import type { EditorSession } from '../editor/session.js';
import type { EnvironmentPreset, MaterialPresetId, PrimitiveType } from '../state/models.js';
import { MATERIAL_PRESET_IDS } from '../state/models.js';
import { ENVIRONMENT_PRESETS } from '../engine/environments.js';
import { PROCEDURAL_TEXTURES, proceduralTextureBlob, proceduralTexturePreview, type ProceduralTextureId } from '../engine/procedural-textures.js';
import { escapeHtml } from '../lib/utils.js';
import { toast } from './toast.js';

/**
 * Built-in asset library: Models · Materials · Textures · Environments · Recent.
 *
 * Everything is either procedural (primitives, canvas textures, PMREM skies) or
 * already in the project, so the browser works offline and stays lightweight.
 * Every tile is draggable — dropping on the viewport places/assigns the asset.
 */

export type AssetKind = 'model' | 'material' | 'texture' | 'environment';

export interface AssetDragPayload {
  kind: AssetKind;
  /** primitive kind / material preset / procedural texture id / environment preset */
  id: string;
  label: string;
  /** project asset id, for imported models and uploaded textures */
  assetId?: string;
}

type Tab = 'models' | 'materials' | 'textures' | 'environments' | 'recent';

const PRIMITIVES: { kind: PrimitiveType; label: string; icon: string }[] = [
  { kind: 'cube', label: 'Cube', icon: '▣' },
  { kind: 'sphere', label: 'Sphere', icon: '●' },
  { kind: 'cylinder', label: 'Cylinder', icon: '▤' },
  { kind: 'cone', label: 'Cone', icon: '▲' },
  { kind: 'plane', label: 'Plane', icon: '▱' },
  { kind: 'torus', label: 'Torus', icon: '◎' },
];

/** Recent usage, remembered per device (assets + commands + primitives). */
const RECENT_KEY = 'assets.recent';

interface RecentEntry {
  kind: AssetKind | 'command';
  id: string;
  label: string;
  icon?: string;
  at: number;
}

function recents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as RecentEntry[]).filter((x) => x && typeof x.id === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(entry: Omit<RecentEntry, 'at'>): void {
  try {
    const next = [{ ...entry, at: Date.now() }, ...recents().filter((r) => !(r.kind === entry.kind && r.id === entry.id))].slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function rememberAsset(payload: AssetDragPayload, icon?: string): void {
  pushRecent({ kind: payload.kind, id: payload.id, label: payload.label, icon });
}

/** Place or assign a dropped asset (used by the viewport drop handler). */
export async function applyAssetPayload(
  s: EditorSession,
  payload: AssetDragPayload,
  point: { x: number; y: number; z: number } | null,
): Promise<void> {
  rememberAsset(payload);
  if (payload.kind === 'model') {
    if (payload.assetId) {
      const bytes = s.getAssetBytes(payload.assetId);
      if (bytes) {
        const created = await s.importGlbBytes(payload.label, bytes.slice(0), `${payload.label}.glb`);
        if (created && point) s.setTransform(created.id, { x: point.x, y: point.y, z: point.z });
        toast(`Placed ${payload.label}`, 'success');
        return;
      }
    }
    const created = s.addPrimitive(payload.id as PrimitiveType);
    if (point) s.setTransform(created.id, { x: point.x, y: point.y, z: point.z });
    s.renameObject(created.id, payload.label);
    toast(`${payload.label} added`, 'success');
    return;
  }
  if (payload.kind === 'material') {
    const targets = s.selectedObjects();
    if (!targets.length) {
      toast('Select an object first', 'warn');
      return;
    }
    s.applyMaterialPresetToSelection(payload.id as MaterialPresetId);
    return;
  }
  if (payload.kind === 'texture') {
    // Unique-per-selection materials: a texture dropped on ONE object must not
    // repaint every other object that happens to share its material.
    const mats = s.makeSelectionMaterialsUnique();
    if (!mats.length) {
      toast('Select an object with a material first', 'warn');
      return;
    }
    const assetId = payload.assetId;
    if (assetId) {
      for (const m of mats) s.setMaterialMap(m.id, 'base', assetId);
      void s.hydrateTextures();
      toast(mats.length > 1 ? `Texture applied to ${mats.length} objects` : 'Texture applied', 'success');
      return;
    }
    toast('Generating texture…');
    const blob = await proceduralTextureBlob(payload.id as ProceduralTextureId, 512);
    const file = new File([blob], `${payload.id}.png`, { type: 'image/png' });
    for (const m of mats) await s.uploadTexture(m.id, file, 'base');
    toast(mats.length > 1 ? `Texture applied to ${mats.length} objects` : 'Texture applied', 'success');
    return;
  }
  if (payload.kind === 'environment') {
    s.setEnvironment({ preset: payload.id as EnvironmentPreset });
    toast(`Environment: ${payload.label}`, 'success');
  }
}

const PREVIEW_CACHE = new Map<string, string>();

export function buildAssetBrowser(s: EditorSession, el: HTMLElement, opts: { onClose?: () => void } = {}): () => void {
  let tab: Tab = 'models';
  let query = '';

  const tile = (payload: AssetDragPayload, visual: string, sub = ''): string => `
    <button class="asset-tile" draggable="true" data-kind="${payload.kind}" data-id="${escapeHtml(payload.id)}" data-label="${escapeHtml(payload.label)}" ${payload.assetId ? `data-asset="${payload.assetId}"` : ''} title="Click to use · drag into the scene">
      <span class="asset-visual">${visual}</span>
      <span class="asset-name">${escapeHtml(payload.label)}</span>
      ${sub ? `<span class="asset-sub muted small">${escapeHtml(sub)}</span>` : ''}
    </button>`;

  function render(): void {
    const q = query.trim().toLowerCase();
    const matches = (label: string): boolean => !q || label.toLowerCase().includes(q);
    const models = PRIMITIVES.filter((p) => matches(p.label));
    const projectModels = s.doc.assets.filter((a) => a.kind === 'model' && matches(a.name));
    const presets = MATERIAL_PRESET_IDS.filter((p) => matches(p));
    const projectMats = s.doc.materials.filter((m) => matches(m.name));
    const projectTex = s.doc.assets.filter((a) => a.kind === 'texture' && matches(a.name));
    const procs = PROCEDURAL_TEXTURES.filter((t) => matches(t.label));
    const envs = ENVIRONMENT_PRESETS.filter((e) => matches(e.label));
    const recentList = recents().filter((r) => matches(r.label));

    el.innerHTML = `
      <div class="panel-title asset-head">
        <span>Assets</span>
        <span class="spacer"></span>
        ${opts.onClose ? '<button class="btn btn-xs" data-assets="close">✕</button>' : ''}
      </div>
      <div class="asset-tabs">
        ${(['models', 'materials', 'textures', 'environments', 'recent'] as Tab[])
          .map((t) => `<button class="btn btn-xs${tab === t ? ' active' : ''}" data-tab="${t}">${t}</button>`)
          .join('')}
      </div>
      <div class="asset-search">
        <input class="input input-sm" type="search" placeholder="Search assets…" value="${escapeHtml(query)}" id="asset-q" />
      </div>
      <div class="asset-grid">
        ${
          tab === 'models'
            ? `${models.map((p) => tile({ kind: 'model', id: p.kind, label: p.label }, `<span class="asset-glyph">${p.icon}</span>`)).join('')}
               ${projectModels
                 .map((a) =>
                   tile({ kind: 'model', id: a.id, label: a.name, assetId: a.id }, '<span class="asset-glyph">📦</span>', 'imported'),
                 )
                 .join('')}
               ${!projectModels.length ? '<p class="muted small asset-note">Imported GLB models show up here.</p>' : ''}`
            : ''
        }
        ${
          tab === 'materials'
            ? `${presets
                .map((p) => tile({ kind: 'material', id: p, label: p }, `<span class="asset-swatch asset-swatch-${p}"></span>`))
                .join('')}
               ${projectMats
                 .map((m) => tile({ kind: 'material', id: m.id, label: m.name }, `<span class="asset-swatch" style="background:${m.baseColor}"></span>`, 'project'))
                 .join('')}`
            : ''
        }
        ${
          tab === 'textures'
            ? `${procs
                .map((t) => {
                  if (!PREVIEW_CACHE.has(t.id)) PREVIEW_CACHE.set(t.id, proceduralTexturePreview(t.id));
                  return tile({ kind: 'texture', id: t.id, label: t.label }, `<img src="${PREVIEW_CACHE.get(t.id)}" alt="${t.label}" />`);
                })
                .join('')}
               ${projectTex
                 .map((a) =>
                   tile(
                     { kind: 'texture', id: a.id, label: a.name, assetId: a.id },
                     a.thumb ? `<img src="${a.thumb}" alt="${escapeHtml(a.name)}" />` : '<span class="asset-glyph">🖼</span>',
                     'project',
                   ),
                 )
                 .join('')}`
            : ''
        }
        ${
          tab === 'environments'
            ? envs
                .map((e) =>
                  tile(
                    { kind: 'environment', id: e.id, label: e.label },
                    `<span class="asset-sky" style="background:linear-gradient(160deg, ${e.sky[0]}, ${e.sky[1]} 60%, ${e.ground})"></span>`,
                  ),
                )
                .join('')
            : ''
        }
        ${
          tab === 'recent'
            ? recentList.length
              ? recentList
                  .map((r) =>
                    tile(
                      { kind: r.kind as AssetKind, id: r.id, label: r.label },
                      `<span class="asset-glyph">${r.icon ?? '•'}</span>`,
                      r.kind,
                    ),
                  )
                  .join('')
              : '<p class="muted small asset-note">Nothing used yet — anything you drop into the scene shows up here.</p>'
            : ''
        }
      </div>`;

    const input = el.querySelector('#asset-q') as HTMLInputElement | null;
    if (input) {
      input.oninput = () => {
        query = input.value;
        const caret = query.length;
        render();
        const next = el.querySelector('#asset-q') as HTMLInputElement | null;
        next?.focus();
        next?.setSelectionRange(caret, caret);
      };
    }
    el.querySelectorAll('[data-tab]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        tab = (b as HTMLElement).dataset.tab as Tab;
        render();
      };
    });
    el.querySelectorAll('[data-assets="close"]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => opts.onClose?.();
    });
    el.querySelectorAll('.asset-tile').forEach((t) => {
      const node = t as HTMLElement;
      const payload: AssetDragPayload = {
        kind: node.dataset.kind as AssetKind,
        id: node.dataset.id as string,
        label: node.dataset.label as string,
        assetId: node.dataset.asset ?? undefined,
      };
      node.addEventListener('dragstart', (e) => {
        (e as DragEvent).dataTransfer?.setData('application/x-web3d-asset', JSON.stringify(payload));
        (e as DragEvent).dataTransfer?.setData('text/plain', payload.label);
        (e as DragEvent).dataTransfer!.effectAllowed = 'copy';
      });
      node.addEventListener('click', () => {
        void applyAssetPayload(s, payload, null);
      });
    });
  }

  const u1 = s.rev.subscribe(render);
  render();
  return () => {
    u1();
  };
}
