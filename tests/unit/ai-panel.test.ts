// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createProjectDoc, defaultMaterial, defaultObject } from '../../src/state/models.js';
import { updateAiSettings, defaultSettings, aiSettings } from '../../src/ai/settings.js';
import { openAiPanel } from '../../src/ui/ai-panel.js';
import { setEditorSession } from '../../src/ai/index.js';
import type { EditorSession } from '../../src/editor/session.js';
import type { AgentSessionLike } from '../../src/ai/types.js';

function fakeSession() {
  const doc = createProjectDoc('Panel Test', 'solo', 'guest');
  return {
    doc,
    addPrimitive: vi.fn((kind: string) => {
      const o = { id: `obj-${Math.random()}`, name: kind, materialId: null };
      (doc.objects as unknown[]).push(o);
      return o;
    }),
    addGroup: vi.fn(() => ({ id: `grp-${Math.random()}`, name: 'Group' })),
    renameObject: vi.fn(),
    setTransform: vi.fn(),
    addMaterial: vi.fn(() => {
      const m = { id: `mat-${Math.random()}`, name: 'M', mapAssetId: null };
      (doc.materials as unknown[]).push(m);
      return m;
    }),
    updateMaterial: vi.fn(),
    assignMaterial: vi.fn(),
    importGlbBytes: vi.fn(async () => ({ id: 'imported-1', name: 'Model' })),
    uploadTexture: vi.fn(async () => undefined),
  } as unknown as EditorSession;
}

function tabBody(): HTMLElement {
  const el = document.querySelector('#ai-tab-body') as HTMLElement;
  if (!el) throw new Error('AI tab body did not render');
  return el;
}

function switchTab(id: string): void {
  (document.querySelector(`[data-tab="${id}"]`) as HTMLButtonElement).click();
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  updateAiSettings(() => defaultSettings());
  (globalThis.URL.createObjectURL as unknown) = vi.fn(() => 'blob:fake');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI panel', () => {
  it('renders tabs and builds an offline 3D mockup when AI is down', async () => {
    const session = fakeSession();
    openAiPanel(session);
    await vi.waitFor(() => expect(document.querySelector('#ai3d-go')).not.toBeNull());
    (tabBody().querySelector('#ai3d-prompt') as HTMLTextAreaElement).value = 'a wooden chair';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    (tabBody().querySelector('#ai3d-go') as HTMLButtonElement).click();
    await vi.waitFor(() => expect((session.addPrimitive as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThanOrEqual(5));
    expect(tabBody().querySelector('#ai3d-result')?.textContent).toContain('offline primitive mockup');
  });

  it('generates and applies a texture with mocked AI', async () => {
    const session = fakeSession();
    openAiPanel(session);
    await vi.waitFor(() => expect(document.querySelector('#ai3d-go')).not.toBeNull());
    switchTab('texture');
    (tabBody().querySelector('#aitex-prompt') as HTMLTextAreaElement).value = 'lava rock';
    const png = new Uint8Array(2048);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })));
    (tabBody().querySelector('#aitex-go') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(session.uploadTexture).toHaveBeenCalled());
    expect(tabBody().querySelector('#aitex-result')?.textContent).toContain('Texture applied');
  });

  it('manages agent tokens from the UI', async () => {
    const session = fakeSession();
    openAiPanel(session);
    await vi.waitFor(() => expect(document.querySelector('#ai3d-go')).not.toBeNull());
    switchTab('agent');
    const body = tabBody();
    expect(body.querySelector('#ag-enabled')).not.toBeNull();
    expect(body.querySelector('#ag-code')?.textContent).toContain('Web3DStudio.agent');
    (body.querySelector('#ag-label') as HTMLInputElement).value = 'UI token';
    (body.querySelector('#ag-new') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(body.querySelector('#ag-secret')).not.toBeNull());
    const secret = body.querySelector('#ag-secret')?.textContent ?? '';
    expect(secret.startsWith('w3d_')).toBe(true);
    expect(aiSettings.get().agent.tokens).toHaveLength(1);
    (body.querySelector('[data-revoke]') as HTMLButtonElement).click();
    expect(aiSettings.get().agent.tokens).toHaveLength(0);
  });

  it('paint tab analyzes groups and auto-paints through the agent', async () => {
    const doc = createProjectDoc('Paint UI', 'solo', 'guest');
    const g = defaultObject('group', 'Wooden chair');
    doc.objects.push(g);
    for (const n of ['Seat', 'Backrest', 'Leg front', 'Leg back']) {
      const p = defaultObject('cube', n);
      p.parentId = g.id;
      doc.objects.push(p);
    }
    const session = {
      doc,
      applyPaint: vi.fn((items: { objectId: string }[]) =>
        items.map((it) => ({ objectId: it.objectId, materialId: `mat-${it.objectId}` })),
      ),
    } as unknown as EditorSession;
    setEditorSession(session as unknown as AgentSessionLike);
    try {
      openAiPanel(session, 'paint');
      // Floating window chrome, not a modal.
      await vi.waitFor(() => expect(document.querySelector('#float-root .floatwin')).not.toBeNull());
      expect(document.querySelector('.floatwin-title')?.textContent).toBe('✨ AI Studio');
      // Auto-analyze shows what the AI sees: chair + part roles.
      await vi.waitFor(() => expect(document.querySelector('.ai-group-card')).not.toBeNull());
      expect(tabBody().textContent).toContain('chair');
      expect(tabBody().textContent).toContain('legs');
      (tabBody().querySelector('#aipaint-go') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(session.applyPaint).toHaveBeenCalledTimes(1));
      expect(tabBody().querySelector('#aipaint-result')?.textContent).toContain('Painted');
      // Per-group paint button scopes to that group.
      (tabBody().querySelector('[data-paint-group]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(session.applyPaint).toHaveBeenCalledTimes(2));
    } finally {
      setEditorSession(null);
    }
  });

  it('ask tab answers scene questions offline when the free AI is down', async () => {
    const session = fakeSession();
    session.addPrimitive('cube');
    session.addPrimitive('sphere');
    openAiPanel(session, 'ask');
    await vi.waitFor(() => expect(document.querySelector('#aiask-go')).not.toBeNull());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    (tabBody().querySelector('#aiask-q') as HTMLInputElement).value = 'how many objects?';
    (tabBody().querySelector('#aiask-go') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tabBody().querySelector('.ai-msg-assistant')?.textContent).toContain('Offline answer'));
    expect(tabBody().querySelector('.ai-msg-assistant')?.textContent).toContain('2 objects');
  });

  it('ask tab shows the provider error when the question needs real AI', async () => {
    const session = fakeSession();
    openAiPanel(session, 'ask');
    await vi.waitFor(() => expect(document.querySelector('#aiask-go')).not.toBeNull());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    (tabBody().querySelector('#aiask-q') as HTMLInputElement).value = 'write a poem about cubes';
    (tabBody().querySelector('#aiask-go') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tabBody().querySelector('.ai-msg-assistant')?.textContent).toContain("Couldn't reach"));
  });

  it('ask errors offer a shortcut button into Setup', async () => {
    const session = fakeSession();
    openAiPanel(session, 'ask');
    await vi.waitFor(() => expect(document.querySelector('#aiask-go')).not.toBeNull());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    (tabBody().querySelector('#aiask-q') as HTMLInputElement).value = 'write a poem about cubes';
    (tabBody().querySelector('#aiask-go') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tabBody().querySelector('#aiask-setup')).not.toBeNull());
    (tabBody().querySelector('#aiask-setup') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tabBody().querySelector('#ai-pollkey')).not.toBeNull());
    expect(tabBody().querySelector('a[href="https://enter.pollinations.ai/keys"]')).not.toBeNull();
  });

  function paintLiveSession(doc: ReturnType<typeof createProjectDoc>) {
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
      addMaterial: vi.fn(() => {
        const m = { id: `mat-tx-${Math.random()}`, name: 'TX' };
        (doc.materials as unknown[]).push(m);
        return m;
      }),
      updateMaterial: vi.fn(),
      assignMaterial: vi.fn((objectId: string, materialId: string | null) => {
        const o = byId(objectId);
        if (o) o.materialId = materialId;
      }),
      uploadTexture: vi.fn(async () => undefined),
      markDirty: vi.fn(),
    } as unknown as EditorSession;
  }

  it('paint+texture on an unrecognized scene shows guidance instead of crashing', async () => {
    // Exact repro: single ungrouped cube → pseudo-group "object", role keep.
    const doc = createProjectDoc('Lonely cube', 'solo', 'guest');
    doc.objects.push(defaultObject('cube', 'cube'));
    const session = paintLiveSession(doc);
    setEditorSession(session as unknown as AgentSessionLike);
    try {
      openAiPanel(session, 'paint');
      await vi.waitFor(() => expect(document.querySelector('.ai-group-card')).not.toBeNull());
      expect(tabBody().textContent).toContain('keep');
      (tabBody().querySelector('#aipaint-tex') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(tabBody().querySelector('#aipaint-result')?.textContent).toContain('group the model'));
      expect(tabBody().querySelector('#aipaint-result')?.textContent).not.toContain('Cannot read properties');
      (tabBody().querySelector('#aipaint-go') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(tabBody().querySelector('#aipaint-result')?.textContent).toContain('recognized role'));
    } finally {
      setEditorSession(null);
    }
  });

  it('paint+texture reports painted parts and textured roles', async () => {
    const doc = createProjectDoc('Chair', 'solo', 'guest');
    const g = defaultObject('group', 'Wooden chair');
    doc.objects.push(g);
    for (const n of ['Seat', 'Leg front']) {
      const p = defaultObject('cube', n);
      p.parentId = g.id;
      doc.objects.push(p);
    }
    const session = paintLiveSession(doc);
    setEditorSession(session as unknown as AgentSessionLike);
    const png = new Uint8Array(2048);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(png as unknown as BodyInit, { status: 200, headers: { 'content-type': 'image/png' } })),
    );
    try {
      openAiPanel(session, 'paint');
      await vi.waitFor(() => expect(document.querySelector('.ai-group-card')).not.toBeNull());
      (tabBody().querySelector('#aipaint-tex') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(tabBody().querySelector('#aipaint-result')?.textContent).toContain('textured 2 part roles'));
      expect(tabBody().querySelector('#aipaint-result')?.textContent).toContain('Painted 2 parts');
      expect(session.uploadTexture).toHaveBeenCalled();
    } finally {
      setEditorSession(null);
    }
  });

  it('saves the Pollinations key from Setup', async () => {
    const session = fakeSession();
    openAiPanel(session, 'settings');
    await vi.waitFor(() => expect(document.querySelector('#ai-pollkey')).not.toBeNull());
    (tabBody().querySelector('#ai-pollkey') as HTMLInputElement).value = 'sk_test123';
    (tabBody().querySelector('#ai-save') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(aiSettings.get().pollinationsKey).toBe('sk_test123'));
  });

  it('saves custom API settings', async () => {
    const session = fakeSession();
    openAiPanel(session);
    await vi.waitFor(() => expect(document.querySelector('#ai3d-go')).not.toBeNull());
    switchTab('settings');
    const body = tabBody();
    (body.querySelector('input[name="ai-image-prov"][value="custom"]') as HTMLInputElement).click();
    (body.querySelector('#ai-image-url') as HTMLInputElement).value = 'http://localhost:1234/v1';
    (body.querySelector('#ai-image-model') as HTMLInputElement).value = 'local-model';
    (body.querySelector('#ai-save') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(aiSettings.get().imageProvider).toBe('custom'));
    expect(aiSettings.get().imageCustom.baseUrl).toBe('http://localhost:1234/v1');
  });
});
