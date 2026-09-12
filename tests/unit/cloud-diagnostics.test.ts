// @vitest-environment jsdom
// Exercises the real supabase-js client against a routed fetch stub, so the
// diagnostics report is produced by the same code paths the browser runs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cloudErrorMessage } from '../../src/lib/cloud-errors.js';

const KEY = 'sb_publishable_test_only_key';
const URL_BASE = 'https://example.supabase.co';
const PROJECT = '10000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  enabled: true,
  config: { url: 'https://example.supabase.co', key: 'sb_publishable_test_only_key', enabled: true, error: null as string | null },
  client: null as unknown as SupabaseClient,
  user: { id: '00000000-0000-4000-8000-000000000009', email: 'artist@example.com', name: 'Artist', guest: false },
}));

vi.mock('../../src/lib/supabase.js', () => ({
  get cloudEnabled() { return mocks.enabled; },
  get cloudConfig() { return mocks.config; },
  supabase: () => mocks.client,
  trySupabase: () => (mocks.enabled ? mocks.client : null),
}));
vi.mock('../../src/lib/auth.js', () => ({ auth: { user: { get: () => mocks.user } } }));

import { runCloudDiagnostics, reportToText, CLOUD_TABLES } from '../../src/lib/cloud-diagnostics.js';

let missingTables: string[] = [];
let missingBuckets: string[] = [];
let uploadFails: { code: string; message: string } | null = null;
let rpcMissing = false;
const seen: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function router(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname;
  seen.push(path);

  if (path.endsWith('/auth/v1/health')) return json({ version: '2.158.0' });

  if (path.includes('/rest/v1/rpc/join_project')) {
    return rpcMissing
      ? json({ code: 'PGRST202', message: 'Could not find the function public.join_project(uuid, text) in the schema cache' }, 404)
      : json(null);
  }

  const rest = path.match(/\/rest\/v1\/([a-z_]+)$/);
  if (rest) {
    const table = rest[1];
    if (missingTables.includes(table)) {
      return json({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }, 404);
    }
    // maybeSingle() sends the "exactly one object" accept header.
    if (table === 'projects' && url.search.includes('id=eq.')) {
      return json({ id: PROJECT, name: 'Cloud scene', version: 7, owner_id: mocks.user.id });
    }
    return json([]);
  }

  // What the Storage API really does: the bucket endpoint knows about buckets,
  // the list endpoint does not — it happily returns [] for one that is missing.
  const bucket = path.match(/\/storage\/v1\/bucket\/([a-z]+)$/);
  if (bucket) {
    return missingBuckets.includes(bucket[1])
      ? json({ statusCode: '404', error: 'Not Found', message: 'Bucket not found', code: 'NoSuchBucket' }, 404)
      : json({ id: bucket[1], name: bucket[1], public: bucket[1] === 'thumbnails' });
  }

  const list = path.match(/\/storage\/v1\/object\/list\/([a-z]+)$/);
  if (list) return json([]);

  if (path.includes('/storage/v1/object/')) {
    const target = path.slice(path.indexOf('/storage/v1/object/') + '/storage/v1/object/'.length).split('/')[0];
    if (missingBuckets.includes(target)) {
      return json({ statusCode: '404', error: 'Not Found', message: 'Bucket not found', code: 'NoSuchBucket' }, 404);
    }
    if (uploadFails) return json({ statusCode: '400', error: 'new row violates row-level security policy', message: uploadFails.message }, 400);
    return json({ Key: path });
  }

  return json([]);
}

beforeEach(() => {
  seen.length = 0;
  missingTables = [];
  missingBuckets = [];
  uploadFails = null;
  rpcMissing = false;
  mocks.enabled = true;
  mocks.config = { url: URL_BASE, key: KEY, enabled: true, error: null };
  mocks.user = { id: '00000000-0000-4000-8000-000000000009', email: 'artist@example.com', name: 'Artist', guest: false };
  vi.stubGlobal('fetch', vi.fn(router));
  // One client for the whole file: supabase-js warns about sibling GoTrueClients
  // sharing a storage key, and the routed fetch reads the mutable state anyway.
  mocks.client ??= createClient(URL_BASE, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 5 } },
    global: { fetch: router as unknown as typeof fetch },
  });
  vi.spyOn(mocks.client.auth, 'getSession').mockResolvedValue({
    data: { session: { user: { id: mocks.user.id, email: mocks.user.email } } },
    error: null,
  } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const run = (): ReturnType<typeof runCloudDiagnostics> =>
  runCloudDiagnostics({ projectId: PROJECT, realtimeTimeoutMs: 20 });

const byId = (report: Awaited<ReturnType<typeof runCloudDiagnostics>>, id: string) =>
  report.checks.find((c) => c.id === id)!;

describe('cloud diagnostics', () => {
  it('reports a healthy project with nothing to fix', async () => {
    const report = await run();
    expect(report.failed).toBe(0);
    expect(report.advice).toBeNull();
    expect(byId(report, 'config').status).toBe('ok');
    expect(byId(report, 'reachability').detail).toContain('2.158.0');
    expect(byId(report, 'session').detail).toBe('artist@example.com');
    expect(byId(report, 'schema').detail).toContain(`All ${CLOUD_TABLES.length} tables`);
    expect(byId(report, 'storage').status).toBe('ok');
    expect(byId(report, 'storageWrite').status).toBe('ok');
    expect(byId(report, 'project').detail).toContain('v7');
  });

  it('probes every table the editor writes to', async () => {
    await run();
    for (const table of CLOUD_TABLES) {
      expect(seen.some((p) => p.endsWith(`/rest/v1/${table}`))).toBe(true);
    }
    expect(CLOUD_TABLES).toHaveLength(15);
  });

  it('names the missing table and points at the migrations', async () => {
    missingTables = ['materials', 'keyframes'];
    const report = await run();
    const schema = byId(report, 'schema');
    expect(schema.status).toBe('fail');
    expect(schema.detail).toContain('materials, keyframes');
    expect(report.failed).toBeGreaterThan(0);
    expect(report.advice).toContain('supabase/setup.sql');
  });

  it('flags a missing storage bucket even though listing it succeeds', async () => {
    // The regression: storage.list() on a missing bucket answers 200 [], so an
    // earlier version of this check reported "ok" while every upload failed.
    missingBuckets = ['assets'];
    const report = await run();
    expect(byId(report, 'storage').status).toBe('fail');
    expect(byId(report, 'storage').detail).toContain('assets');
    expect(byId(report, 'storage').raw).toContain('Bucket not found');
    expect(byId(report, 'storageWrite').status).toBe('fail');
    expect(byId(report, 'storageWrite').raw).toContain('NoSuchBucket');
    expect(report.advice).toContain('20260912000000_storage_buckets_repair.sql');
  });

  it('treats a private bucket this session cannot read as present', async () => {
    const original = router;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname.endsWith('/storage/v1/bucket/assets')) {
          return json({ statusCode: '400', error: 'The user does not have permission' }, 400);
        }
        return original(input);
      }),
    );
    const report = await run();
    expect(byId(report, 'storage').status).toBe('ok');
    expect(byId(report, 'storage').detail).toContain('buckets exist');
  });

  it('flags a blocked upload and points at the repair migration', async () => {
    uploadFails = { code: '42501', message: 'new row violates row-level security policy for storage.objects' };
    const report = await run();
    expect(byId(report, 'storageWrite').status).toBe('fail');
    // A policy denial must not be reported as the missing-bucket repair.
    expect(report.advice).toContain('20260908000003_cloud_repairs.sql');
    expect(report.advice).not.toContain('storage_buckets_repair');
  });

  it('flags a missing join_project RPC so invite links are explained', async () => {
    rpcMissing = true;
    const report = await run();
    expect(byId(report, 'rpc').status).toBe('fail');
    expect(report.advice).toContain('migrated');
  });

  it('says so plainly when there is no session to push with', async () => {
    vi.spyOn(mocks.client.auth, 'getSession').mockResolvedValue({ data: { session: null }, error: null } as never);
    const report = await run();
    expect(byId(report, 'session').status).toBe('fail');
    expect(byId(report, 'storageWrite').status).toBe('skip');
    expect(report.advice).toContain('Sign in');
  });

  it('skips every network probe when cloud is not configured', async () => {
    mocks.enabled = false;
    mocks.config = { url: '', key: '', enabled: false, error: null };
    const report = await run();
    expect(byId(report, 'config').status).toBe('warn');
    expect(byId(report, 'schema').status).toBe('skip');
    expect(seen).toHaveLength(0);
    expect(report.advice).toContain('local-only');
  });

  it('surfaces a build-config mistake instead of probing anyway', async () => {
    mocks.enabled = false;
    mocks.config = { url: '', key: '', enabled: false, error: 'Set both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.' };
    const report = await run();
    expect(byId(report, 'config').status).toBe('fail');
    expect(report.advice).toContain('VITE_SUPABASE_URL');
  });

  it('writes a copyable report that never contains the key', async () => {
    const text = reportToText(await run());
    expect(text).toContain('Web 3D Studio — cloud diagnostics');
    expect(text).toContain('OK   Database tables');
    expect(text).not.toContain(KEY);
    expect(text).toContain('example.supabase.co');
  });

  it('keeps the server detail in the save-badge tooltip text', () => {
    expect(cloudErrorMessage({ message: 'Failed to fetch' })).toBe('Failed to fetch');
    expect(
      cloudErrorMessage({ code: '22P02', message: 'invalid input syntax for type uuid', details: 'invalid input syntax' }),
    ).toContain('invalid input syntax for type uuid (invalid input syntax)');
    // The migration hint wording the pages test depends on stays intact.
    expect(cloudErrorMessage({ code: 'PGRST205', message: 'nope' })).toContain('Supabase database setup is incomplete');
  });
});

import { openCloudDiagnosticsModal } from '../../src/ui/panels-extra.js';

describe('the diagnostics modal', () => {
  const mount = (): HTMLElement => {
    document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
    return document.getElementById('modal-root') as HTMLElement;
  };

  it('opens from the save badge and renders every probe', async () => {
    const root = mount();
    openCloudDiagnosticsModal();
    expect(root.querySelector('.modal-title')?.textContent).toContain('Cloud diagnostics');
    await vi.waitFor(() => expect(root.textContent).toContain('Database tables'), { timeout: 10000 });
    expect(root.querySelector('.diag-ok')).toBeTruthy();
    expect(root.querySelector('.diag-fail')).toBeNull();
    expect(root.textContent).toContain('Copy report');
    expect(root.textContent).toContain('All 15 tables');
  });

  it('puts the fix in front of the user when a table is missing', async () => {
    missingTables = ['keyframes'];
    const root = mount();
    openCloudDiagnosticsModal();
    await vi.waitFor(() => expect(root.querySelector('.diag-fail')).toBeTruthy(), { timeout: 10000 });
    expect(root.querySelector('.banner-warn')?.textContent).toContain('supabase/setup.sql');
    expect(root.querySelector('.diag-fail')?.textContent).toContain('keyframes');
  });
});
