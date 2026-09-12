// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi, describe } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Store } from '../../src/state/store.js';
import { createProjectDoc, defaultObject } from '../../src/state/models.js';
import type { EditorSession } from '../../src/editor/session.js';

const mocks = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  enqueue: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), listQueue: vi.fn(), clearQueue: vi.fn(),
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.com', name: 'Artist', guest: false },
}));
vi.mock('../../src/lib/supabase.js', () => ({ cloudEnabled: true, supabase: () => mocks.client }));
vi.mock('../../src/lib/auth.js', () => ({ auth: { user: { get: () => mocks.user } } }));
vi.mock('../../src/lib/indexeddb.js', () => ({ localDb: mocks }));
import { SyncEngine } from '../../src/editor/sync.js';

let engine: SyncEngine;
let session: EditorSession;
let failRequest = '';
let failures = { code: '42501', message: 'Permission denied' };
const calls: { route: string; body: unknown }[] = [];
let duringRequest: (() => void) | null = null;
// the row(s) the mocked PATCH projects returns — a CAS miss looks like `[]`
let patchProjects: unknown = { id: '00000000-0000-4000-8000-000000000000' };
// override the version the mocked GET projects row reports (a peer's head)
let cloudHeadVersion: number | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  failRequest = '';
  failures = { code: '42501', message: 'Permission denied' };
  calls.length = 0;
  duringRequest = null;
  patchProjects = { id: doc0Id() };
  mocks.getProject.mockResolvedValue(null);
  mocks.saveProject.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.listQueue.mockResolvedValue([]);
  mocks.clearQueue.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const doc = createProjectDoc('Test', 'solo', mocks.user.id);
  doc.objects.push(defaultObject('cube', 'Cube'));
  doc.clips[0].tracks.push({
    id: '20000000-0000-4000-8000-000000000001', objectId: doc.objects[0].id, property: 'position',
    keyframes: [{ frame: 0, value: [0, 0, 0], interp: 'linear' }],
  });
  session = {
    doc, canEdit: new Store(true), syncError: new Store(null), saveState: new Store('local'),
    pendingRecovery: null, user: () => mocks.user,
  } as unknown as EditorSession;
    mocks.client = createClient('https://example.supabase.co', 'sb_publishable_test_only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
      const method = init?.method || 'GET';
      const table = path.split('/').pop();
      const route = `${method} ${table}`;
      calls.push({ route, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      duringRequest?.();
      if (route === failRequest) return new Response(JSON.stringify(failures), { status: 403, headers: { 'Content-Type': 'application/json' } });
      let data: unknown = [];
      if (method === 'GET') {
        if (table === 'projects') data = [{
          id: doc.id, owner_id: mocks.user.id,
          version: cloudHeadVersion ?? doc.version,
          name: 'Cloud', mode: 'team', updated_at: '2026-09-01T00:00:00Z',
        }];
        if (table === 'project_members') data = [{ role: 'owner' }];
        if (table === 'scenes') data = [{ id: '10000000-0000-4000-8000-000000000001', data: {} }];
        if (table === 'scene_objects') data = [{ id: doc.objects[0].id }];
      }
      if (method === 'PATCH' && table === 'projects') data = patchProjects;
      if (method === 'PATCH' && table === 'scenes') data = { id: '10000000-0000-4000-8000-000000000001' };
      // PostgREST returns a bare object (not an array) for .single()/.maybeSingle()
      const rawHeaders = init?.headers;
      const accept = rawHeaders instanceof Headers
        ? rawHeaders.get('Accept')
        : Array.isArray(rawHeaders)
          ? (rawHeaders.find(([k]) => k.toLowerCase() === 'accept')?.[1] ?? null)
          : (rawHeaders as Record<string, string> | undefined)?.Accept;
      const wantsObject = typeof accept === 'string' && accept.includes('vnd.pgrst.object');
      if (wantsObject && Array.isArray(data)) data = data[0] ?? null;
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  engine = new SyncEngine(session);
});

function doc0Id(): string { return '00000000-0000-4000-8000-000000000000'; }
afterEach(() => { engine.dispose(); });

it.each(['PATCH scenes', 'POST scene_objects', 'POST materials', 'POST animation_tracks', 'POST keyframes', 'PATCH projects'])('does not report a successful save when %s fails', async (route) => {
  failRequest = route;
  expect(await engine.pushDoc(session.doc)).toBe(false);
  expect(session.doc.cloudVersion).toBe(0);
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(mocks.enqueue.mock.calls[0][0].id).toBe(`push:${session.doc.id}`);
  expect(session.syncError.get()).toContain('denied access');
});

it('advances the revision only after all durable writes succeed', async () => {
  expect(await engine.pushDoc(session.doc)).toBe(true);
  expect(calls[calls.length - 1].route).toBe('PATCH projects');
  expect(session.doc.cloudVersion).toBe(session.doc.version);
  expect(mocks.saveProject).toHaveBeenCalledWith(session.doc);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it('freezes the saved snapshot instead of claiming concurrent edits were saved', async () => {
  const originalVersion = session.doc.version;
  duringRequest = () => { session.doc.version = originalVersion + 1; };
  expect(await engine.pushDoc(session.doc)).toBe(true);
  expect(session.doc.cloudVersion).toBe(originalVersion);
  expect(session.doc.version).toBe(originalVersion + 1);
  expect(calls.find((call) => call.route === 'PATCH projects')?.body).toMatchObject({ version: originalVersion });
});

it('does not try to recreate a project after a failed schema lookup', async () => {
  failRequest = 'GET projects';
  failures = { code: 'PGRST205', message: 'No table projects' };
  expect(await engine.pushDoc(session.doc)).toBe(false);
  expect(calls.some((call) => call.route === 'POST projects')).toBe(false);
  expect(session.syncError.get()).toContain('supabase/migrations');
});

it('does not flush a pending snapshot over an unresolved cloud conflict', async () => {
  session.pendingRecovery = { ...session.doc, version: 99 };
  expect(await engine.pushDoc(session.doc)).toBe(false);
  expect(calls).toHaveLength(0);
});

it('uses chronological queue order, preferring current offline edits', async () => {
  const older = { ...session.doc, updatedAt: '2026-09-01T00:00:00Z', version: 1 };
  const newer = { ...session.doc, updatedAt: '2026-09-02T00:00:00Z', version: 2 };
  session.doc.updatedAt = '2026-09-03T00:00:00Z';
  mocks.listQueue.mockResolvedValue([
    { id: 'a-newer', createdAt: newer.updatedAt, payload: newer },
    { id: 'z-older', createdAt: older.updatedAt, payload: older },
  ]);
  const push = vi.spyOn(engine, 'pushDoc').mockResolvedValue(true);
  await engine.flushQueue();
  expect(push).toHaveBeenCalledWith(session.doc);
  expect(mocks.clearQueue).toHaveBeenCalledWith(['a-newer', 'z-older']);
});
it('refuses to overwrite a newer cloud revision (compare-and-swap)', async () => {
  // ensureCloudProject observes the row at doc.version and CAS-checks it;
  // a row that no longer matches (a peer wrote in between) yields 0 rows.
  patchProjects = [];
  cloudHeadVersion = session.doc.version + 5; // a peer pushed a newer revision
  expect(await engine.pushDoc(session.doc)).toBe(false);
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(session.syncError.get()).toContain('saved this project first');
  expect(session.doc.cloudVersion).toBe(0); // content claim never advanced
});

it('adopts the pulled head after a conflict so "keep mine" can push on top', async () => {
  patchProjects = [];
  cloudHeadVersion = session.doc.version + 5;
  expect(await engine.pushDoc(session.doc)).toBe(false);
  // start-of-session state would then show the recovery modal; the local doc
  // must not be re-pushed while a conflict is pending.
  expect(session.pendingRecovery).toBeTruthy();
  const cloud = session.pendingRecovery as { version: number };
  session.pendingRecovery = null;
  session.doc.version = cloud.version + 1;
  patchProjects = { id: doc0Id() };
  expect(await engine.pushDoc(session.doc)).toBe(true);
});

describe('pullStandalone error surfacing (invite-link "Project not found")', () => {
  it('falls back to the local copy when the cloud pull fails mid-session', async () => {
    failRequest = 'GET projects';
    failures = { code: '42501', message: 'Permission denied' };
    mocks.getProject.mockResolvedValue(session.doc);
    const pulled = await SyncEngine.pullStandalone(session.doc.id);
    expect(pulled?.id).toBe(session.doc.id);
    expect(pulled?.name).toBe(session.doc.name);
  });

  it('rejects with the real cause when there is no local copy to fall back to', async () => {
    // RLS hid the project row (.single() on zero rows): a fresh invitee whose
    // join never happened must see why, not a bare "Project not found".
    failRequest = 'GET projects';
    failures = { code: 'PGRST116', details: 'Results contain 0 rows', message: 'JSON object requested, multiple (or no) rows returned' };
    mocks.getProject.mockResolvedValue(null);
    await expect(SyncEngine.pullStandalone(session.doc.id)).rejects.toThrow(/invite link|does not have access/);
  });

  it('maps a missing schema to the migration hint instead of a raw PostgREST message', async () => {
    failRequest = 'GET projects';
    failures = { code: 'PGRST202', message: 'Could not find the function public.join_project in the schema cache' };
    mocks.getProject.mockResolvedValue(null);
    await expect(SyncEngine.pullStandalone(session.doc.id)).rejects.toThrow(/setup is incomplete/);
  });

  it('returns the cloud document on a successful pull', async () => {
    mocks.getProject.mockResolvedValue(null);
    const pulled = await SyncEngine.pullStandalone(session.doc.id);
    expect(pulled?.id).toBe(session.doc.id);
    expect(pulled?.name).toBe('Cloud');
    expect(pulled?.mode).toBe('team');
  });
});

describe('joinWithCode error mapping', () => {
  it('maps a missing join RPC to the actionable migration message', async () => {
    failRequest = 'POST join_project';
    failures = { code: 'PGRST202', message: 'Could not find the function public.join_project(p_code, p_project_id) in the schema cache' };
    const err = await SyncEngine.joinWithCode(doc0Id(), 'abc12345');
    expect(err).toContain('setup is incomplete');
    expect(err).toContain('supabase/migrations');
  });

  it('keeps server-raised invite errors readable', async () => {
    failRequest = 'POST join_project';
    failures = { code: null, message: 'Invalid invite code' };
    const err = await SyncEngine.joinWithCode(doc0Id(), 'wrong');
    expect(err).toBe('Invalid invite code');
  });
});
