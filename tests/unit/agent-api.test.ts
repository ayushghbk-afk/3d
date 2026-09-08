import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AgentAPI, AgentError } from '../../src/ai/agent-api.js';
import { aiSettings, createAgentToken, defaultSettings, updateAiSettings } from '../../src/ai/settings.js';
import { localDb } from '../../src/lib/indexeddb.js';

let api: AgentAPI;
let token: string;

async function call(method: string, params: Record<string, unknown> = {}, secret?: string) {
  return api.authorizedCall(method, params, 'page', secret ?? token) as Promise<Record<string, unknown>>;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (e) {
    expect((e as AgentError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AgentError ${code}, call succeeded.`);
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  updateAiSettings(() => defaultSettings());
  updateAiSettings((s) => ({ ...s, agent: { ...s.agent, enabled: true } }));
  api = new AgentAPI(() => null); // headless: no editor open
  ({ secret: token } = await createAgentToken('test-agent', ['read', 'write', 'generate'], null));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('auth', () => {
  it('rejects calls while disabled', async () => {
    updateAiSettings((s) => ({ ...s, agent: { ...s.agent, enabled: false } }));
    await expectCode(call('project.list'), 'AUTH_DISABLED');
  });

  it('allows ping/capabilities without a token', async () => {
    const pong = await api.authorizedCall('agent.ping', {}, 'page', null) as Record<string, unknown>;
    expect(pong.ok).toBe(true);
    const caps = await api.authorizedCall('agent.capabilities', {}, 'page', null) as Record<string, unknown>;
    expect((caps.methods as unknown[]).length).toBeGreaterThan(20);
  });

  it('rejects missing, invalid and under-scoped tokens', async () => {
    await expectCode(api.authorizedCall('project.list', {}, 'page', null), 'AUTH_REQUIRED');
    await expectCode(api.authorizedCall('project.list', {}, 'page', 'w3d_nope_nope'), 'AUTH_INVALID');
    const { secret: readOnly } = await createAgentToken('reader', ['read'], null);
    await expectCode(api.authorizedCall('object.add', { kind: 'cube' }, 'page', readOnly), 'FORBIDDEN_SCOPE');
  });

  it('rejects expired tokens', async () => {
    const { meta, secret } = await createAgentToken('old', ['read'], null);
    await api.authorizedCall('project.list', {}, 'page', secret);
    updateAiSettings((s) => ({
      ...s,
      agent: {
        ...s.agent,
        tokens: s.agent.tokens.map((t) => (t.id === meta.id ? { ...t, expiresAt: new Date(Date.now() - 1000).toISOString() } : t)),
      },
    }));
    await expectCode(api.authorizedCall('project.list', {}, 'page', secret), 'AUTH_INVALID');
    expect(aiSettings.get().agent.tokens.find((t) => t.id === meta.id)?.expiresAt).not.toBeNull();
  });

  it('rate-limits per token', async () => {
    updateAiSettings((s) => ({ ...s, agent: { ...s.agent, rateLimitPerMin: 3 } }));
    await call('project.list');
    await call('project.list');
    await call('project.list');
    await expectCode(call('project.list'), 'RATE_LIMITED');
  });

  it('logs activity for successes and failures', async () => {
    await call('project.list');
    const pid = ((await call('project.create', { name: 'Log' })) as { project: { id: string } }).project.id;
    await expectCode(call('object.add', { projectId: pid, kind: 'nope' }), 'VALIDATION');
    const activity = await call('agent.activity', { limit: 5 }) as { entries: { ok: boolean; method: string }[] };
    expect(activity.entries[0].method).toBe('object.add');
    expect(activity.entries[0].ok).toBe(false);
    expect(activity.entries.some((e) => e.method === 'project.list' && e.ok)).toBe(true);
  });
});

describe('projects headless', () => {
  it('creates, lists, renames and deletes projects', async () => {
    const created = (await call('project.create', { name: 'Agent House', mode: 'solo' })) as { project: { id: string } };
    const id = created.project.id;
    const list = (await call('project.list')) as { projects: { id: string }[] };
    expect(list.projects.some((p) => p.id === id)).toBe(true);
    const ctx = (await call('project.context', { projectId: id })) as { context: string };
    expect(ctx.context).toContain('Agent House');
    await call('project.update', { id, name: 'Renamed' });
    expect(((await call('project.get', { id })) as { project: { name: string } }).project.name).toBe('Renamed');
    await call('project.delete', { id });
    expect(await localDb.getProject(id)).toBeNull();
  });

  it('validates project input', async () => {
    await expectCode(call('project.create', {}), 'VALIDATION');
    await expectCode(call('project.create', { name: 'x', mode: 'party' }), 'VALIDATION');
    await expectCode(call('project.get', { id: 'missing' }), 'NOT_FOUND');
  });
});

describe('objects headless', () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = ((await call('project.create', { name: 'Scene' })) as { project: { id: string } }).project.id;
  });

  it('adds, updates, duplicates and deletes objects', async () => {
    const added = (await call('object.add', {
      projectId, kind: 'cube', name: 'Box', position: { x: 1, y: 2 }, color: '#ff0000',
    })) as { object: { id: string; position: { x: number; y: number }; materialId: string | null } };
    expect(added.object.position.x).toBe(1);
    expect(added.object.materialId).not.toBeNull();

    const updated = (await call('object.update', {
      projectId, id: added.object.id, rotationDeg: { y: 90 }, scale: { x: 2 }, visible: false,
    })) as { object: { rotation: { y: number }; scale: { x: number }; visible: boolean } };
    expect(updated.object.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(updated.object.scale.x).toBe(2);
    expect(updated.object.visible).toBe(false);

    const dup = (await call('object.duplicate', { projectId, id: added.object.id })) as { object: { id: string; name: string } };
    expect(dup.object.id).not.toBe(added.object.id);

    const listed = (await call('object.list', { projectId })) as { objects: unknown[] };
    expect(listed.objects).toHaveLength(2);

    await call('object.delete', { projectId, id: added.object.id });
    const after = (await call('object.list', { projectId })) as { objects: unknown[] };
    expect(after.objects).toHaveLength(1);
  });

  it('adds groups and lights, rejects bad kinds', async () => {
    const group = (await call('object.add', { projectId, kind: 'group' })) as { object: { type: string } };
    expect(group.object.type).toBe('group');
    const light = (await call('object.add', { projectId, kind: 'light', lightKind: 'spot' })) as {
      object: { light: { kind: string } };
    };
    expect(light.object.light.kind).toBe('spot');
    await expectCode(call('object.add', { projectId, kind: 'teapot' }), 'VALIDATION');
    await expectCode(call('object.add', { projectId, kind: 'cube', color: 'red' }), 'VALIDATION');
  });

  it('reparents and guards self-parenting', async () => {
    const parent = (await call('object.add', { projectId, kind: 'group', name: 'P' })) as { object: { id: string } };
    const child = (await call('object.add', { projectId, kind: 'sphere', name: 'C' })) as { object: { id: string } };
    await call('object.update', { projectId, id: child.object.id, parentId: parent.object.id });
    const listed = (await call('object.list', { projectId })) as { objects: { id: string; parentId: string | null }[] };
    expect(listed.objects.find((o) => o.id === child.object.id)?.parentId).toBe(parent.object.id);
    await expectCode(call('object.update', { projectId, id: child.object.id, parentId: child.object.id }), 'VALIDATION');
  });
});

describe('materials, assets and animation headless', () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = ((await call('project.create', { name: 'Mat' })) as { project: { id: string } }).project.id;
  });

  it('manages materials', async () => {
    const mat = (await call('material.add', { projectId, name: 'Gold', baseColor: '#ffd700', metalness: 1, roughness: 0.2 })) as {
      material: { id: string; baseColor: string; metalness: number };
    };
    expect(mat.material.baseColor).toBe('#ffd700');
    await call('material.update', { projectId, id: mat.material.id, roughness: 0.5, side: 'double' });
    const listed = (await call('material.list', { projectId })) as { materials: { id: string; side: string }[] };
    expect(listed.materials.find((m) => m.id === mat.material.id)?.side).toBe('double');
    await expectCode(call('material.add', { projectId, baseColor: 'gold' }), 'VALIDATION');
  });

  it('imports GLB bytes as an asset + object', async () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x67, 0x6c, 0x54, 0x46]);
    const b64 = Buffer.from(bytes).toString('base64');
    const imported = (await call('asset.import', { projectId, name: 'Ship', dataBase64: b64 })) as {
      object: { assetId: string | null; type: string };
    };
    expect(imported.object.type).toBe('imported');
    expect(imported.object.assetId).not.toBeNull();
    const assets = (await call('asset.list', { projectId })) as { assets: { id: string }[] };
    expect(assets.assets).toHaveLength(1);
    await expectCode(call('asset.import', { projectId, name: 'Bad', dataBase64: '!!!' }), 'VALIDATION');
  });

  it('adds clips and keyframes', async () => {
    const obj = (await call('object.add', { projectId, kind: 'cube' })) as { object: { id: string } };
    const clip = (await call('clip.add', { projectId, name: 'Walk' })) as { clip: { id: string } };
    const key = (await call('keyframe.add', {
      projectId, objectId: obj.object.id, property: 'position', frame: 10, value: [1, 0, 0], clipId: clip.clip.id,
    })) as { value: number[] };
    expect(key.value).toEqual([1, 0, 0]);
    const clips = (await call('clip.list', { projectId })) as { clips: { tracks: { keyframes: { frame: number }[] }[] }[] };
    expect(clips.clips.flatMap((c) => c.tracks.flatMap((t) => t.keyframes)).some((k) => k.frame === 10)).toBe(true);
    await call('keyframe.delete', { projectId, objectId: obj.object.id, property: 'position', frame: 10 });
    await expectCode(call('keyframe.add', { projectId, objectId: 'missing', frame: 0 }), 'NOT_FOUND');
  });
});

describe('generation (mocked network)', () => {
  let projectId: string;
  const pngBytes = new Uint8Array(2048);

  const imageResponse = () =>
    new Response(pngBytes as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } });

  beforeEach(async () => {
    projectId = ((await call('project.create', { name: 'Gen' })) as { project: { id: string } }).project.id;
  });

  it('image.generate returns a data URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse()));
    const out = (await call('image.generate', { prompt: 'blue marble', width: 256, height: 256, seed: 7 })) as {
      dataUrl: string; seed: number; provider: string; fallback: null;
    };
    expect(out.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(out.seed).toBe(7);
    expect(out.provider).toBe('pollinations');
    expect(out.fallback).toBeNull();
  });

  it('texture.generate applies a map to a new material', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imageResponse()));
    const out = (await call('texture.generate', { projectId, prompt: 'lava rock', size: 128 })) as {
      materialId: string; provider: string;
    };
    const doc = await localDb.getProject(projectId);
    const mat = doc?.materials.find((m) => m.id === out.materialId);
    expect(mat?.mapAssetId).not.toBeNull();
    expect(out.provider).toBe('pollinations');
  });

  it('model.generate falls back to offline primitives when AI is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const out = (await call('model.generate', { projectId, prompt: 'a wooden chair' })) as {
      procedural: boolean; objectIds: string[]; fallback: { from: string };
    };
    expect(out.procedural).toBe(true);
    expect(out.objectIds.length).toBeGreaterThanOrEqual(5);
    expect(out.fallback.from).toContain('TripoSR');
  });

  it('model.generate strict surfaces the provider error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await expect(call('model.generate', { projectId, prompt: 'chair', strict: true })).rejects.toThrow(/offline|Reference image failed/);
  });

  it('model.generate imports a TripoSR GLB end to end', async () => {
    const glb = new Uint8Array(2048);
    glb.set([0x67, 0x6c, 0x54, 0x46]);
    const sse =
      'event: process_generating\ndata: {}\n\n' +
      'event: process_completed\ndata: {"output":{"data":[null,{"url":"/gradio_api/file=/tmp/x/model.obj","orig_name":"model.obj"},{"url":"/gradio_api/file=/tmp/x/model.glb","orig_name":"model.glb"}]}}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('image.pollinations.ai')) return imageResponse();
        if (url.endsWith('/config.json')) {
          return Response.json({
            components: [
              { id: 1, type: 'image' },
              { id: 2, type: 'slider' },
              { id: 3, type: 'model3d' },
            ],
            dependencies: [{ id: 5, inputs: [1, 2], outputs: [3] }],
          });
        }
        if (url.endsWith('/gradio_api/upload')) return Response.json(['/tmp/x/input.png']);
        if (url.endsWith('/gradio_api/queue/join')) return Response.json({ event_id: 'e1' });
        if (url.includes('/gradio_api/queue/data')) {
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('model.glb')) {
          return new Response(glb as unknown as BodyInit, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const out = (await call('model.generate', { projectId, prompt: 'toy car', quality: 'fast' })) as {
      object: { type: string; assetId: string | null }; provider: string;
    };
    expect(out.provider).toBe('triposr');
    expect(out.object.type).toBe('imported');
    expect(out.object.assetId).not.toBeNull();
  });

  it('ai.ask answers with project context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ choices: [{ message: { content: 'You have 0 objects.' } }] })),
    );
    const out = (await call('ai.ask', { projectId, question: 'summarize' })) as { answer: string; projectId: string };
    expect(out.answer).toContain('0 objects');
    expect(out.projectId).toBe(projectId);
  });
});
