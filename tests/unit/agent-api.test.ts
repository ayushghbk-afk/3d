import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AgentAPI, AgentError } from '../../src/ai/agent-api.js';
import { aiSettings, createAgentToken, defaultSettings, updateAiSettings } from '../../src/ai/settings.js';
import { localDb } from '../../src/lib/indexeddb.js';
import { createProjectDoc, defaultMaterial, defaultObject } from '../../src/state/models.js';
import type { AgentSessionLike } from '../../src/ai/types.js';

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
    expect(out.fallback.from).toContain('Stable Fast 3D');
  });

  it('model.generate strict surfaces the provider error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await expect(call('model.generate', { projectId, prompt: 'chair', strict: true })).rejects.toThrow(/offline|Reference image failed/);
  });

  it('model.generate imports an SF3D GLB end to end', async () => {
    const glb = new Uint8Array(2048);
    glb.set([0x67, 0x6c, 0x54, 0x46]);
    const completed = (data: unknown) =>
      `event: process_completed\ndata: ${JSON.stringify({ output: { data }, success: true })}\n\n`;
    // requires → "Remove Background" → bg removal → generate (same session).
    const streams = [
      completed([{ value: 'Remove Background', visible: true }, null, null, null, { visible: false }, { visible: false }]),
      completed([{ value: 'Run' }, { path: '/tmp/s1.png' }, { path: '/tmp/s2.png' }, null, { visible: false }, { visible: false }]),
      completed([{}, {}, {}, {}, { value: { url: '/gradio_api/file=/tmp/x/model.glb', orig_name: 'model.glb' }, visible: true }, {}]),
    ];
    let streamCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('image.pollinations.ai')) return imageResponse();
        if (url.endsWith('/config.json')) {
          return Response.json({
            components: [
              { id: 1, type: 'image' },
              { id: 3, type: 'slider', props: { label: 'Foreground Ratio', value: 0.85 } },
              { id: 4, type: 'radio', props: { value: 'None' } },
              { id: 7, type: 'button', props: { value: 'Run' } },
              { id: 8, type: 'state' },
              { id: 9, type: 'state' },
              { id: 10, type: 'litmodel3d' },
              { id: 11, type: 'column' },
            ],
            dependencies: [
              { id: 20, inputs: [1, 3], outputs: [7, 8, 9, 10, 11] },
              { id: 21, inputs: [7, 1, 9, 3, 4, 3, 3], outputs: [7, 8, 9, 10, 11] },
            ],
          });
        }
        if (url.endsWith('/gradio_api/upload')) return Response.json(['/tmp/x/input.png']);
        if (url.endsWith('/gradio_api/queue/join')) return Response.json({ event_id: 'e1' });
        if (url.includes('/gradio_api/queue/data')) {
          const sse = streams[Math.min(streamCalls++, streams.length - 1)];
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.includes('model.glb')) {
          return new Response(glb as unknown as BodyInit, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );
    const out = (await call('model.generate', { projectId, prompt: 'toy car', quality: 'fast' })) as {
      object: { type: string; assetId: string | null }; provider: string; fallback: null;
    };
    expect(out.provider).toBe('sf3d');
    expect(out.fallback).toBeNull();
    expect(out.object.type).toBe('imported');
    expect(out.object.assetId).not.toBeNull();
    expect(streamCalls).toBe(3); // check → bg removal → generate
  });

  it('model.generate falls back to TripoSR when SF3D is down', async () => {
    const glb = new Uint8Array(2048);
    glb.set([0x67, 0x6c, 0x54, 0x46]);
    const sse =
      'event: process_completed\ndata: {"success":true,"output":{"data":[null,{"url":"/gradio_api/file=/tmp/x/model.glb","orig_name":"model.glb"}]}}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        // SF3D answers but with a broken UI (fails discovery fast, no wake-up wait).
        if (url.includes('stable-fast-3d') && url.endsWith('/config.json')) return Response.json({});
        if (url.includes('stable-fast-3d')) throw new Error('sf3d broken');
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
    const out = (await call('model.generate', { projectId, prompt: 'toy car' })) as {
      object: { type: string }; provider: string; fallback: { from: string; to: string };
    };
    expect(out.provider).toBe('triposr');
    expect(out.object.type).toBe('imported');
    expect(out.fallback.from).toContain('Stable Fast 3D');
    expect(out.fallback.to).toContain('TripoSR');
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

  it('ai.ask answers scene questions offline when the provider is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const out = (await call('ai.ask', { projectId, question: 'how many objects?' })) as {
      answer: string; offline: boolean;
    };
    expect(out.offline).toBe(true);
    expect(out.answer).toContain('0 objects');
  });

  it('ai.ask surfaces a PROVIDER error when offline answering is impossible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expectCode(call('ai.ask', { projectId, question: 'write a poem about cubes' }), 'PROVIDER');
  });
});

describe('scene.* (AI understanding + full scene control)', () => {
  function chairDoc() {
    const doc = createProjectDoc('Paint Me', 'solo', 'guest');
    const chair = defaultObject('group', 'Wooden chair');
    doc.objects.push(chair);
    for (const n of ['Seat', 'Backrest', 'Leg front', 'Leg back']) {
      const p = defaultObject('cube', n);
      p.parentId = chair.id;
      doc.objects.push(p);
    }
    doc.objects.push(defaultObject('cube', 'Mystery blade'));
    return doc;
  }

  function fakeLive(doc: ReturnType<typeof chairDoc>) {
    const byId = (id: string) => doc.objects.find((o) => o.id === id);
    return {
      doc,
      applyPaint: vi.fn((items: { objectId: string; materialName: string; patch: Record<string, unknown> }[]) =>
        items.map((it) => {
          const m = defaultMaterial(it.materialName);
          Object.assign(m, it.patch);
          doc.materials.push(m);
          const o = byId(it.objectId);
          if (o) o.materialId = m.id;
          return { objectId: it.objectId, materialId: m.id };
        }),
      ),
      checkpoint: vi.fn(),
      setTransform: vi.fn((id: string, pos?: { x?: number; z?: number }) => {
        const o = byId(id);
        if (o && pos) o.position = { ...o.position, ...pos };
      }),
      markDirty: vi.fn(),
      addMaterial: vi.fn(() => {
        const m = defaultMaterial('M');
        doc.materials.push(m);
        return m;
      }),
      updateMaterial: vi.fn((id: string, patch: Record<string, unknown>) => {
        Object.assign(doc.materials.find((m) => m.id === id) ?? {}, patch);
      }),
      assignMaterial: vi.fn((objectId: string, materialId: string | null) => {
        const o = byId(objectId);
        if (o) o.materialId = materialId;
      }),
      uploadTexture: vi.fn(async () => undefined),
    };
  }

  it('lists scene.* in capabilities with read/write/generate scopes', async () => {
    const caps = (await api.authorizedCall('agent.capabilities', {}, 'page', null)) as {
      methods: { name: string; scope: string }[];
    };
    const byName = Object.fromEntries(caps.methods.map((m) => [m.name, m.scope]));
    expect(byName).toMatchObject({
      'scene.analyze': 'read',
      'scene.autopaint': 'write',
      'scene.autotexture': 'generate',
      'scene.tidy': 'write',
    });
  });

  it('analyzes + paints + tidies headless with persistence', async () => {
    const doc = chairDoc();
    await localDb.saveProject(doc);
    const analysis = (await call('scene.analyze', { projectId: doc.id })) as {
      mode: string; summary: string; groups: { label: string }[];
    };
    expect(analysis.mode).toBe('headless');
    expect(analysis.groups.map((g) => g.label).sort()).toEqual(['chair', 'sword']);
    expect(analysis.summary).toContain('chair');

    const painted = (await call('scene.autopaint', { projectId: doc.id })) as {
      mode: string; applied: number; groups: number;
      plan: { role: string; color: string }[];
    };
    expect(painted.mode).toBe('headless');
    expect(painted.applied).toBe(5);
    expect(painted.groups).toBe(2);
    const reloaded = await localDb.getProject(doc.id);
    expect(reloaded?.materials.length).toBeGreaterThanOrEqual(2);
    expect(reloaded?.objects.find((o) => o.name === 'Seat')?.materialId).not.toBeNull();

    const tidied = (await call('scene.tidy', { projectId: doc.id, spacing: 4 })) as {
      arranged: number; cols: number; spacing: number;
    };
    expect(tidied).toMatchObject({ arranged: 2, cols: 2, spacing: 4 });
    const moved = await localDb.getProject(doc.id);
    const xs = moved?.objects.filter((o) => !o.parentId).map((o) => o.position.x).sort();
    expect(xs).toEqual([0, 4]);
  });

  it('scopes autopaint to groupIds', async () => {
    const doc = chairDoc();
    await localDb.saveProject(doc);
    const chairId = doc.objects.find((o) => o.name === 'Wooden chair')?.id;
    const out = (await call('scene.autopaint', { projectId: doc.id, groupIds: [chairId] })) as {
      applied: number; groups: number;
    };
    expect(out).toMatchObject({ applied: 4, groups: 1 });
  });

  it('paints live through one session.applyPaint call (single undo step)', async () => {
    const doc = chairDoc();
    const live = fakeLive(doc);
    const liveApi = new AgentAPI(() => live as unknown as AgentSessionLike);
    const out = (await liveApi.authorizedCall('scene.autopaint', {}, 'page', token)) as {
      mode: string; applied: number;
    };
    expect(out.mode).toBe('live');
    expect(out.applied).toBe(5);
    expect(live.applyPaint).toHaveBeenCalledTimes(1);
    expect(live.applyPaint.mock.calls[0][0]).toHaveLength(5);
    const analysis = (await liveApi.authorizedCall('scene.analyze', {}, 'page', token)) as { mode: string };
    expect(analysis.mode).toBe('live');
  });

  it('tidies live via checkpoint + one setTransform per root', async () => {
    const doc = chairDoc();
    const live = fakeLive(doc);
    const liveApi = new AgentAPI(() => live as unknown as AgentSessionLike);
    const out = (await liveApi.authorizedCall('scene.tidy', {}, 'page', token)) as { arranged: number };
    expect(out.arranged).toBe(2);
    expect(live.checkpoint).toHaveBeenCalledTimes(1);
    expect(live.setTransform).toHaveBeenCalledTimes(2);
  });

  it('autotextures live: paint first, then one AI texture per role', async () => {
    const doc = chairDoc();
    const live = fakeLive(doc);
    const liveApi = new AgentAPI(() => live as unknown as AgentSessionLike);
    const png = new Uint8Array(2048);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })),
    );
    const out = (await liveApi.authorizedCall('scene.autotexture', { maxTextures: 1 }, 'page', token)) as {
      mode: string; painted: number; textured: { role: string; provider: string }[];
    };
    expect(out.mode).toBe('live');
    expect(out.painted).toBe(5);
    expect(out.textured).toHaveLength(1);
    expect(out.textured[0].provider).toBe('pollinations');
    expect(live.uploadTexture).toHaveBeenCalledTimes(1);
  });
});
