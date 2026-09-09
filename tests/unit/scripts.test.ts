import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createProjectDoc, defaultScript, normalizeDoc } from '../../src/state/models.js';
import {
  assertSafeScript, compileScript, createHeadlessHost, runScriptCode, SCRIPT_EXAMPLES,
} from '../../src/editor/scripts.js';
import { AgentAPI, AgentError } from '../../src/ai/agent-api.js';
import { createAgentToken, defaultSettings, updateAiSettings } from '../../src/ai/settings.js';
import { localDb } from '../../src/lib/indexeddb.js';

describe('script sandbox', () => {
  it('rejects window / fetch / unicode escapes', () => {
    expect(() => assertSafeScript('window.alert(1)')).toThrow(/window/);
    expect(() => assertSafeScript('fetch("https://x")')).toThrow(/fetch/);
    expect(() => assertSafeScript('eval("1")')).toThrow(/eval/);
    expect(() => assertSafeScript('const w = "\\u0077indow"')).toThrow(/escape/);
    expect(() => compileScript('scene.add({ kind: "cube" })')).not.toThrow();
  });
});

describe('headless scene API', () => {
  it('adds meshes, moves them, and writes keyframes + camera', async () => {
    const doc = createProjectDoc('Scripted', 'solo', 'guest');
    const host = createHeadlessHost(doc, { canGenerate: false });
    const out = await runScriptCode(`
      const a = scene.add({ kind: 'cube', name: 'Box', position: { x: 1, y: 0, z: 0 }, color: '#ff0000' });
      scene.rotate(a.id, { y: 90 });
      scene.move(a.id, { x: 1 });
      scene.keys.add(a.id, 'position', 0, [0, 0, 0]);
      scene.keys.add(a.id, 'position', 10, [2, 1, 0]);
      scene.camera.set({ position: { x: 5, y: 4, z: 6 }, target: { x: 0, y: 1, z: 0 }, fov: 40 });
      scene.camera.orbit(90, 45, 10);
      scene.log('ok', a.name);
    `, host);
    expect(out.ok).toBe(true);
    expect(out.logs.join(' ')).toContain('Box');
    const box = doc.objects.find((o) => o.name === 'Box');
    expect(box).toBeTruthy();
    expect(box?.position.x).toBeCloseTo(2);
    expect(box?.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(box?.materialId).not.toBeNull();
    const keys = doc.clips[0].tracks.find((t) => t.objectId === box?.id && t.property === 'position')?.keyframes ?? [];
    expect(keys.map((k) => k.frame)).toEqual([0, 10]);
    expect(host.getCamera().fov).toBe(40);
    expect(host.getCamera().position.x).not.toBe(5); // orbit moved it
  });

  it('blocks generate in frame scripts and without generate scope', async () => {
    const doc = createProjectDoc('NoGen', 'solo', 'guest');
    const host = createHeadlessHost(doc, { canGenerate: false });
    const heavy = await runScriptCode(`await scene.textures.generate('lava');`, host, { allowHeavy: true });
    expect(heavy.ok).toBe(false);
    expect(heavy.error).toMatch(/generate scope/i);
    const frame = await runScriptCode(`await scene.textures.generate('lava');`, host, { allowHeavy: false, canGenerate: true } as { allowHeavy: boolean });
    expect(frame.ok).toBe(false);
    expect(frame.error).toMatch(/per-frame/i);
  });

  it('examples compile', () => {
    for (const ex of SCRIPT_EXAMPLES) {
      expect(() => compileScript(ex.code)).not.toThrow();
    }
  });
});

describe('normalizeDoc scripts', () => {
  it('fills a missing scripts array', () => {
    const doc = createProjectDoc('N', 'solo', 'guest');
    delete (doc as { scripts?: unknown }).scripts;
    const n = normalizeDoc(doc);
    expect(n.scripts).toEqual([]);
    n.scripts.push({ ...defaultScript('X'), trigger: 'nope' as 'manual' });
    normalizeDoc(n);
    expect(n.scripts[0].trigger).toBe('manual');
  });
});

describe('Agent API script + camera + texture list', () => {
  let api: AgentAPI;
  let token: string;
  let projectId: string;

  async function call(method: string, params: Record<string, unknown> = {}) {
    return api.authorizedCall(method, params, 'page', token) as Promise<Record<string, unknown>>;
  }

  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    updateAiSettings(() => defaultSettings());
    updateAiSettings((s) => ({ ...s, agent: { ...s.agent, enabled: true } }));
    api = new AgentAPI(() => null);
    ({ secret: token } = await createAgentToken('scripts', ['read', 'write', 'generate'], null));
    projectId = ((await call('project.create', { name: 'S' })) as { project: { id: string } }).project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('adds, lists, runs and deletes a script that creates a cube', async () => {
    const added = (await call('script.add', {
      projectId,
      name: 'Make cube',
      code: `scene.add({ kind: 'cube', name: 'FromScript', position: { x: 3, y: 1, z: 0 } });`,
    })) as { script: { id: string; enabled: boolean } };
    expect(added.script.enabled).toBe(false);
    const listed = (await call('script.list', { projectId })) as { scripts: { name: string }[] };
    expect(listed.scripts.some((s) => s.name === 'Make cube')).toBe(true);
    const ran = (await call('script.run', { projectId, id: added.script.id })) as { ok: boolean };
    expect(ran.ok).toBe(true);
    const objs = (await call('object.list', { projectId })) as { objects: { name: string; position: { x: number } }[] };
    expect(objs.objects.find((o) => o.name === 'FromScript')?.position.x).toBe(3);
    await call('script.delete', { projectId, id: added.script.id });
    expect(((await call('script.list', { projectId })) as { scripts: unknown[] }).scripts).toHaveLength(0);
  });

  it('runs ad-hoc code and sets the camera', async () => {
    const ran = (await call('script.run', {
      projectId,
      code: `scene.add({ kind: 'sphere', name: 'Ball' }); scene.camera.set({ fov: 35, position: { x: 2, y: 3, z: 4 } });`,
    })) as { ok: boolean };
    expect(ran.ok).toBe(true);
    const cam = (await call('camera.get', { projectId })) as { camera: { fov: number; position: { x: number } } };
    expect(cam.camera.fov).toBe(35);
    expect(cam.camera.position.x).toBe(2);
    await call('camera.lookAt', { projectId, x: 1, y: 2, z: 3 });
    const after = (await call('camera.get', { projectId })) as { camera: { target: { y: number } } };
    expect(after.camera.target.y).toBe(2);
  });

  it('rejects unsafe script.run code', async () => {
    await expect(call('script.run', { projectId, code: 'window.location = "https://evil"' })).rejects.toBeInstanceOf(AgentError);
  });

  it('lists texture capabilities without a token and texture.list with one', async () => {
    const caps = (await api.authorizedCall('texture.capabilities', {}, 'page', null)) as {
      api: string; methods: { name: string }[];
    };
    expect(caps.api).toBe('textures');
    expect(caps.methods.some((m) => m.name === 'texture.generate')).toBe(true);
    const listed = (await call('texture.list', { projectId })) as { textures: unknown[]; materials: unknown[] };
    expect(listed.textures).toEqual([]);
    expect(listed.materials.length).toBeGreaterThan(0);
  });

  it('exposes script/camera/texture methods in capabilities', async () => {
    const caps = (await api.authorizedCall('agent.capabilities', {}, 'page', null)) as {
      apis: string[];
      methods: { name: string; scope: string }[];
    };
    expect(caps.apis).toEqual(['agent', 'textures']);
    const byName = Object.fromEntries(caps.methods.map((m) => [m.name, m.scope]));
    expect(byName).toMatchObject({
      'script.run': 'write',
      'camera.set': 'write',
      'texture.list': 'read',
      'texture.capabilities': 'none',
      'playback.set': 'write',
    });
  });
});

describe('localDb roundtrip scripts', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('persists scripts on a project', async () => {
    const doc = createProjectDoc('Keep', 'solo', 'guest');
    doc.scripts.push(defaultScript('Spin'));
    await localDb.saveProject(doc);
    const loaded = await localDb.getProject(doc.id);
    expect(loaded?.scripts[0].name).toBe('Spin');
  });
});
