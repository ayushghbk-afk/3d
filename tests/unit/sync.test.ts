// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
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

beforeEach(() => {
  vi.clearAllMocks();
  failRequest = '';
  failures = { code: '42501', message: 'Permission denied' };
  calls.length = 0;
  duringRequest = null;
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
        if (table === 'projects') data = [{ id: doc.id, owner_id: mocks.user.id, version: doc.version }];
        if (table === 'project_members') data = [{ role: 'owner' }];
        if (table === 'scenes') data = [{ id: '10000000-0000-4000-8000-000000000001', data: {} }];
        if (table === 'scene_objects') data = [{ id: doc.objects[0].id }];
      }
      if (method === 'PATCH' && table === 'projects') data = { id: doc.id };
      if (method === 'PATCH' && table === 'scenes') data = { id: '10000000-0000-4000-8000-000000000001' };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  engine = new SyncEngine(session);
});
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
