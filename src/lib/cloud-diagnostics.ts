import { auth } from './auth.js';
import { cloudConfig, cloudEnabled, trySupabase } from './supabase.js';
import { cloudErrorMessage } from './cloud-errors.js';

/**
 * Self-service cloud diagnostics.
 *
 * The editor's save badge only ever said "✕ Error" with the reason hidden in a
 * hover tooltip, so a broken Supabase project looked identical to a network
 * outage. This probes each dependency the studio actually uses — config, auth,
 * the fifteen tables, the invite RPC, both storage buckets and Realtime — and
 * reports the first thing that is actually wrong, with the raw server message.
 *
 * Every check is read-only except the optional storage round-trip, which writes
 * one probe object under `<project>/__diagnostics__/` and removes it again.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CloudCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Verbatim server code/message, for copy-pasting into a bug report. */
  raw?: string;
  ms: number;
}

export interface CloudReport {
  at: string;
  url: string;
  keyKind: string;
  checks: CloudCheck[];
  failed: number;
  /** The advice line shown at the top of the report. */
  advice: string | null;
}

interface ServerError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  status?: number;
  statusCode?: string;
}

/** Every public table the schema is supposed to create (see supabase/setup.sql). */
export const CLOUD_TABLES = [
  'projects',
  'project_members',
  'profiles',
  'scenes',
  'scene_objects',
  'folders',
  'assets',
  'models',
  'materials',
  'textures',
  'animations',
  'animation_tracks',
  'keyframes',
  'project_versions',
  'project_changes',
] as const;

/** Codes that mean "this object does not exist in the database yet". */
const MISSING_SCHEMA = new Set(['PGRST205', 'PGRST202', '42P01', '42703', 'PGRST204', 'PGRST102']);

function raw(e: unknown): string {
  const err = e as ServerError | null;
  if (!err) return String(e);
  const parts = [err.code ?? err.statusCode ?? '', err.message ?? '', err.details ?? '', err.hint ?? '']
    .map((p) => String(p).trim())
    .filter(Boolean);
  return parts.length ? parts.join(' — ') : JSON.stringify(err);
}

function isMissingSchema(e: unknown): boolean {
  const err = e as ServerError | null;
  return !!err && (MISSING_SCHEMA.has(String(err.code)) || /could not find|does not exist|schema cache/i.test(err.message ?? ''));
}

/** Never log or copy a key: only its kind and a short fingerprint. */
function keyKind(key: string): string {
  if (!key) return 'none';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    return `legacy JWT (${payload.role ?? 'unknown'} role)`;
  } catch {
    return 'unknown';
  }
}

function fingerprint(key: string): string {
  if (!key) return 'n/a';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t0), value };
  } catch (error) {
    return { ms: Math.round(performance.now() - t0), error };
  }
}

export interface DiagnosticsOptions {
  /** When set, the project row and the storage round-trip are probed too. */
  projectId?: string | null;
  /** Skip the storage write round-trip (read-only mode). */
  readOnly?: boolean;
  /** How long to wait for a Realtime echo before calling it degraded. */
  realtimeTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function runCloudDiagnostics(opts: DiagnosticsOptions = {}): Promise<CloudReport> {
  const checks: CloudCheck[] = [];
  const push = (c: Omit<CloudCheck, 'ms'> & { ms?: number }): void => {
    checks.push({ ms: 0, ...c });
  };

  // 1. configuration ---------------------------------------------------------
  if (!cloudEnabled) {
    push({
      id: 'config',
      label: 'Cloud configuration',
      status: cloudConfig.error ? 'fail' : 'warn',
      detail: cloudConfig.error
        ? cloudConfig.error
        : 'Cloud is not configured — this build runs in local mode, so nothing is uploaded.',
    });
  } else {
    push({
      id: 'config',
      label: 'Cloud configuration',
      status: 'ok',
      detail: `${new URL(cloudConfig.url).host} · ${keyKind(cloudConfig.key)} key · fingerprint ${fingerprint(cloudConfig.key)}`,
    });
  }

  const sb = cloudEnabled ? trySupabase() : null;
  if (!sb) {
    for (const id of ['reachability', 'session', 'schema', 'rpc', 'storage', 'realtime']) {
      push({ id, label: id, status: 'skip', detail: 'Skipped — cloud is not configured.' });
    }
    return finish(checks);
  }

  // 2. reachability (GoTrue health is public and cheap) ----------------------
  {
    const { ms, value, error } = await timed(async () => {
      const res = await fetch(`${cloudConfig.url}/auth/v1/health`, { headers: { apikey: cloudConfig.key } });
      if (!res.ok) throw { code: String(res.status), message: await res.text() };
      return (await res.json()) as { version?: string };
    });
    push(
      error
        ? {
            id: 'reachability',
            label: 'Supabase reachable',
            status: 'fail',
            detail: 'Could not reach the Supabase project over HTTPS.',
            raw: raw(error),
            ms,
          }
        : {
            id: 'reachability',
            label: 'Supabase reachable',
            status: 'ok',
            detail: `GoTrue ${value?.version ?? 'ok'} answered /auth/v1/health`,
            ms,
          },
    );
  }

  // 3. session ---------------------------------------------------------------
  let sessionUserId: string | null = null;
  {
    const { ms, value } = await timed(() => sb.auth.getSession());
    const error = value?.error;
    const user = value?.data?.session?.user ?? null;
    const local = auth.user.get();
    if (error) {
      push({ id: 'session', label: 'Signed in', status: 'fail', detail: cloudErrorMessage(error), raw: raw(error), ms });
    } else if (!user) {
      push({
        id: 'session',
        label: 'Signed in',
        status: local?.guest ? 'warn' : 'fail',
        detail: local?.guest
          ? 'Browsing as Guest — cloud saves are skipped until you sign in.'
          : 'No session: the editor cannot push to the cloud.',
        ms,
      });
    } else {
      sessionUserId = user.id;
      push({ id: 'session', label: 'Signed in', status: 'ok', detail: `${user.email ?? user.id}`, ms });
    }
  }

  // 4. schema: every table the app writes to --------------------------------
  {
    const missing: string[] = [];
    const broken: string[] = [];
    let ok = 0;
    let ms = 0;
    for (const table of CLOUD_TABLES) {
      const r = await timed(async () => await sb.from(table).select('id').limit(1));
      ms += r.ms;
      const err = (r.value as { error?: unknown } | undefined)?.error ?? r.error;
      if (err) {
        if (isMissingSchema(err)) missing.push(table);
        else broken.push(`${table}: ${raw(err)}`);
      } else ok++;
    }
    if (missing.length) {
      push({
        id: 'schema',
        label: 'Database tables',
        status: 'fail',
        detail: `${ok}/${CLOUD_TABLES.length} present — missing: ${missing.join(', ')}`,
        raw: 'PGRST205 (table not in the schema cache)',
        ms,
      });
    } else if (broken.length) {
      push({ id: 'schema', label: 'Database tables', status: 'warn', detail: `${ok}/${CLOUD_TABLES.length} readable`, raw: broken.join(' | '), ms });
    } else {
      push({ id: 'schema', label: 'Database tables', status: 'ok', detail: `All ${CLOUD_TABLES.length} tables present and readable`, ms });
    }
  }

  // 5. invite RPC ------------------------------------------------------------
  {
    const { ms, value, error: thrown } = await timed(
      async () => await sb.rpc('join_project', { p_project_id: '00000000-0000-4000-8000-000000000000', p_code: 'diagnostics' }),
    );
    const error = (value as { error?: unknown } | undefined)?.error ?? thrown;
    if (error && isMissingSchema(error)) {
      push({
        id: 'rpc',
        label: 'join_project RPC',
        status: 'fail',
        detail: 'Invite links cannot work without this function.',
        raw: raw(error),
        ms,
      });
    } else {
      // A wrong code / unknown project is the *expected* outcome of the probe.
      push({ id: 'rpc', label: 'join_project RPC', status: 'ok', detail: 'Present and callable', ms });
    }
  }

  // 6. storage buckets -------------------------------------------------------
  {
    const results: string[] = [];
    let failed = false;
    let ms = 0;
    for (const bucket of ['assets', 'thumbnails']) {
      const r = await timed(async () => await sb.storage.from(bucket).list('', { limit: 1 }));
      ms += r.ms;
      const err = (r.value as { error?: unknown } | undefined)?.error ?? r.error;
      if (err) {
        failed = true;
        results.push(`${bucket}: ${raw(err)}`);
      } else {
        results.push(`${bucket}: listed ok`);
      }
    }
    push({
      id: 'storage',
      label: 'Storage buckets',
      status: failed ? 'fail' : 'ok',
      detail: failed ? 'A bucket the app uploads to is missing or unreadable.' : 'assets + thumbnails buckets are readable',
      raw: failed ? results.join(' | ') : undefined,
      ms,
    });
  }

  // 7. storage write round-trip (only with a project and a real session) -----
  if (opts.projectId && !opts.readOnly) {
    if (!sessionUserId) {
      push({ id: 'storageWrite', label: 'Storage upload', status: 'skip', detail: 'Sign in to test uploads.', ms: 0 });
    } else {
      const path = `${opts.projectId}/__diagnostics__/probe.txt`;
      const body = new Blob([`web-3d-studio diagnostics ${new Date().toISOString()}`], { type: 'text/plain' });
      const up = await timed(async () => await sb.storage.from('assets').upload(path, body, { upsert: true, contentType: 'text/plain' }));
      const upError = (up.value as { error?: unknown } | null)?.error ?? up.error;
      if (upError) {
        push({
          id: 'storageWrite',
          label: 'Storage upload',
          status: 'fail',
          detail: 'Uploads are rejected — mesh rewrites, imports and AI models cannot be stored in the cloud.',
          raw: raw(upError),
          ms: up.ms,
        });
      } else {
        const rm = await timed(async () => await sb.storage.from('assets').remove([path]));
        push({
          id: 'storageWrite',
          label: 'Storage upload',
          status: 'ok',
          detail: `Wrote and removed ${path}`,
          ms: up.ms + rm.ms,
        });
      }
    }
  } else if (opts.readOnly) {
    push({ id: 'storageWrite', label: 'Storage upload', status: 'skip', detail: 'Read-only run — no probe object written.', ms: 0 });
  } else {
    push({ id: 'storageWrite', label: 'Storage upload', status: 'skip', detail: 'Open a project to test uploads.', ms: 0 });
  }

  // 8. realtime --------------------------------------------------------------
  {
    const t0 = performance.now();
    const probe = sb.channel(`diagnostics-${Date.now()}`, { config: { broadcast: { self: true } } });
    const result = await new Promise<'ok' | 'timeout' | 'error'>((resolve) => {
      let settled = false;
      const done = (r: 'ok' | 'timeout' | 'error'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => done('timeout'), opts.realtimeTimeoutMs ?? 6000);
      probe.on('broadcast', { event: 'ping' }, () => done('ok')).subscribe((state) => {
        const s = String(state);
        if (s === 'SUBSCRIBED') void probe.send({ type: 'broadcast', event: 'ping', payload: {} });
        if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') done('error');
      });
    });
    // Do not leave a socket behind: the probe is one ping, not a subscription.
    void probe.unsubscribe();
    push({
      id: 'realtime',
      label: 'Realtime',
      status: result === 'ok' ? 'ok' : 'warn',
      detail:
        result === 'ok'
          ? 'Broadcast channel round-tripped'
          : 'No Realtime echo — live cursors and co-editing will be degraded, but saving still works.',
      ms: Math.round(performance.now() - t0),
    });
  }

  // 9. the open project's cloud row -----------------------------------------
  if (opts.projectId) {
    const { ms, value, error } = await timed(
      async () => await sb.from('projects').select('id,version,owner_id,name').eq('id', opts.projectId as string).maybeSingle(),
    );
    const projError = (value as { error?: unknown } | null)?.error ?? error;
    const row = (value as { data?: { version: number; owner_id: string; name: string } } | null)?.data ?? null;
    if (projError) {
      push({
        id: 'project',
        label: 'This project in the cloud',
        status: isMissingSchema(projError) ? 'fail' : 'warn',
        detail: cloudErrorMessage(projError),
        raw: raw(projError),
        ms,
      });
    } else if (!row) {
      push({
        id: 'project',
        label: 'This project in the cloud',
        status: 'warn',
        detail: 'No cloud row yet — the first save creates it. If that keeps failing, the insert is being denied.',
        ms,
      });
    } else {
      push({
        id: 'project',
        label: 'This project in the cloud',
        status: 'ok',
        detail: `“${row.name}” · revision v${row.version} · owner ${row.owner_id.slice(0, 8)}…`,
        ms,
      });
    }
  }

  return finish(checks);
}

function finish(checks: CloudCheck[]): CloudReport {
  const failed = checks.filter((c) => c.status === 'fail').length;
  return { at: new Date().toISOString(), url: cloudConfig.url, keyKind: keyKind(cloudConfig.key), checks, failed, advice: adviceFor(checks) };
}

/** Turn the first hard failure into the one thing worth doing next. */
export function adviceFor(checks: CloudCheck[]): string | null {
  const find = (id: string): CloudCheck | undefined => checks.find((c) => c.id === id);
  const config = find('config');
  if (config?.status === 'fail') return 'Fix the VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY build variables and rebuild.';
  if (config?.status === 'warn') return 'Cloud is off in this build, so the app is local-only by design.';
  if (find('reachability')?.status === 'fail') return 'The Supabase project is unreachable — check that it is not paused and that your network allows *.supabase.co.';
  if (find('schema')?.status === 'fail' || find('rpc')?.status === 'fail') {
    return 'The database is only partly migrated. Open the Supabase SQL editor and run supabase/setup.sql (fresh project) or the missing files in supabase/migrations in filename order, then retry.';
  }
  if (find('storage')?.status === 'fail') {
    return 'The assets/thumbnails storage buckets are missing. Re-run supabase/setup.sql — it inserts both buckets and their policies.';
  }
  if (find('storageWrite')?.status === 'fail') {
    return 'Uploads are blocked by a storage policy. Run supabase/migrations/20260908000003_cloud_repairs.sql — it adds the UPDATE policies that upsert uploads need.';
  }
  if (find('session')?.status === 'fail') return 'Sign in again; the stored session is no longer valid.';
  if (find('session')?.status === 'warn') return 'Sign in — Guest mode never writes to the cloud.';
  return null;
}

/** Plain-text report for copying into an issue or a chat message. */
export function reportToText(report: CloudReport): string {
  const icon = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' } as const;
  const lines = [
    'Web 3D Studio — cloud diagnostics',
    `at ${report.at}`,
    `project ${report.url || '(none)'} · key ${report.keyKind}`,
    '',
    ...report.checks.map((c) => `${icon[c.status]} ${c.label}: ${c.detail}${c.raw ? `\n      ${c.raw}` : ''}`),
  ];
  if (report.advice) lines.push('', `Next step: ${report.advice}`);
  return lines.join('\n');
}
