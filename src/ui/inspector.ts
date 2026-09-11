import * as THREE from 'three';
import type { EditorSession } from '../editor/session.js';
import type {
  EnvironmentPreset, FogSettings, LightData, MaterialData, MaterialPresetId, PostFxSettings, SceneObjectData,
} from '../state/models.js';
import { MATERIAL_PRESET_IDS } from '../state/models.js';
import { ENVIRONMENT_PRESETS } from '../engine/environments.js';
import { escapeHtml, pickFiles } from '../lib/utils.js';
import { isWithinSubtree } from '../state/tree.js';
import { toast } from './toast.js';

/** Copy/paste hand-off for transforms (module scope so it survives re-renders). */
interface TransformClipboard {
  position: [number, number, number];
  rotationDeg: [number, number, number];
  scale: [number, number, number];
}
let xfer: TransformClipboard | null = null;

const AXES = ['X', 'Y', 'Z'] as const;
const d2r = THREE.MathUtils.degToRad;
const r2d = THREE.MathUtils.radToDeg;

/**
 * Inspector v2 — numeric transforms (multi-select aware), the full material
 * editor (PBR + presets + map slots), lights, collections, physics and the
 * scene presentation settings (environment, fog, post-processing).
 */
export function buildInspector(s: EditorSession, el: HTMLElement): () => void {
  let tab: 'object' | 'scene' = 'object';

  function numRow(label: string, vals: [number, number, number], step: number): string {
    return `
      <div class="field">
        <span class="field-label">${label}</span>
        <div class="vec3">
          ${vals
            .map(
              (v, i) =>
                `<label class="axis axis-${AXES[i].toLowerCase()}">${AXES[i]}<input class="input input-sm" data-vec="${label}:${i}" type="number" step="${step}" value="${Number(v.toFixed(3))}" /></label>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  function render(): void {
    if (el.contains(document.activeElement) && (document.activeElement as HTMLElement)?.tagName === 'INPUT'
      && (document.activeElement as HTMLInputElement).type === 'number') {
      return; // don't yank the field out from under a typing user
    }
    const o = s.selectedObject();
    const count = s.selection.count();
    el.innerHTML = `
      <div class="panel-title insp-tabs">
        <button class="btn btn-xs${tab === 'object' ? ' active' : ''}" data-insp-tab="object">${count > 1 ? `${count} objects` : 'Object'}</button>
        <button class="btn btn-xs${tab === 'scene' ? ' active' : ''}" data-insp-tab="scene">Scene</button>
      </div>
      ${tab === 'scene' ? sceneSection() : o ? objectSection(o, count) : emptySection()}`;
    wire();
  }

  // ------------------------------------------------------------------ object
  function objectSection(o: SceneObjectData, count: number): string {
    const mat = s.doc.materials.find((m) => m.id === o.materialId) ?? null;
    return `
      ${count > 1 ? `<p class="muted small insp-multi">Editing ${count} objects — numeric fields apply to all of them.</p>` : ''}
      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Selected object</div>
            <h3>${escapeHtml(o.name)}</h3>
          </div>
          <span class="badge">${escapeHtml(o.type)}</span>
        </div>
        <label class="field">Name
          <input id="insp-name" class="input" value="${escapeHtml(o.name)}" maxlength="60" />
        </label>
        <div class="prop-actions">
          <button class="btn btn-sm" data-io="vis">${o.visible ? 'Hide' : 'Show'}</button>
          <button class="btn btn-sm" data-io="lock">${o.locked ? 'Unlock' : 'Lock'}</button>
          <button class="btn btn-sm" data-io="dup">Duplicate</button>
          <button class="btn btn-sm" data-io="del">Delete</button>
        </div>
        <label class="field">Parent
          <select id="insp-parent" class="input">
            <option value="">— Scene root —</option>
            ${s.doc.objects
              .filter((x) => x.id !== o.id && !isWithinSubtree(s.doc.objects, o.id, x.id))
              .map((x) => `<option value="${x.id}"${x.id === o.parentId ? ' selected' : ''}>${escapeHtml(x.name)}</option>`)
              .join('')}
          </select>
        </label>
        ${o.type === 'group' ? '<button class="btn btn-sm" data-io="ungroup">Ungroup</button>' : ''}
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Transform</div>
            <h3>Position · Rotation · Scale</h3>
          </div>
        </div>
        <div class="seg wrap prop-tools">
          ${(['translate', 'rotate', 'scale'] as const)
            .map(
              (m) =>
                `<button class="btn btn-sm${s.transformMode.get() === m ? ' active' : ''}" data-tmode="${m}" title="${m} (${m === 'translate' ? 'W' : m === 'rotate' ? 'E' : 'R'})">${m === 'translate' ? '↔ Move' : m === 'rotate' ? '🔄 Rotate' : '📐 Scale'}</button>`,
            )
            .join('')}
        </div>
        <div class="seg wrap prop-tools">
          <button class="btn btn-sm${s.gizmoSpace.get() === 'local' ? ' active' : ''}" data-space="local" title="Local axes (X)">Local</button>
          <button class="btn btn-sm${s.gizmoSpace.get() === 'world' ? ' active' : ''}" data-space="world" title="World axes (X)">World</button>
          <button class="btn btn-sm${s.transformTarget.get() === 'pivot' ? ' active' : ''}" data-io="pivotmode" title="Drag the gizmo to move the transform origin">Edit pivot</button>
        </div>
        ${numRow('Position', [o.position.x, o.position.y, o.position.z], 0.1)}
        ${numRow('Rotation°', [r2d(o.rotation.x), r2d(o.rotation.y), r2d(o.rotation.z)], 1)}
        ${numRow('Scale', [o.scale.x, o.scale.y, o.scale.z], 0.05)}
        <div class="prop-actions wrap">
          <button class="btn btn-sm" data-io="reset">Reset</button>
          <button class="btn btn-sm" data-io="copyxf">Copy</button>
          <button class="btn btn-sm" data-io="pastexf"${xfer ? '' : ' disabled'}>Paste</button>
          <button class="btn btn-sm" data-io="applyall">Apply</button>
          <button class="btn btn-sm" data-io="applyrs">Apply rot/scale</button>
          <button class="btn btn-sm" data-io="drop">Drop to ground</button>
          <button class="btn btn-sm" data-io="snapgrid">Snap to grid</button>
        </div>
        <div class="prop-actions wrap">
          <span class="muted small">Mirror</span>
          <button class="btn btn-xs" data-mirror="x">X</button>
          <button class="btn btn-xs" data-mirror="y">Y</button>
          <button class="btn btn-xs" data-mirror="z">Z</button>
          <span class="spacer"></span>
          <span class="muted small">Pivot</span>
          <button class="btn btn-xs" data-pivot="center">Centre</button>
          <button class="btn btn-xs" data-pivot="base">Bottom</button>
          <button class="btn btn-xs" data-pivot="origin">Origin</button>
        </div>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Snapping</div>
            <h3>Grid · angle · surface</h3>
          </div>
          <label class="switch">
            <input type="checkbox" id="insp-snap" ${s.snapSettings.get().enabled ? 'checked' : ''} />
            <span>On</span>
          </label>
        </div>
        <div class="mat-grid">
          <label>Grid <input type="number" id="insp-grid" class="input input-sm" min="0.01" step="0.05" value="${s.snapSettings.get().grid}" /></label>
          <label>Angle° <input type="number" id="insp-angle" class="input input-sm" min="1" max="90" step="1" value="${s.snapSettings.get().angle}" /></label>
          <label>Scale <input type="number" id="insp-scalesnap" class="input input-sm" min="0.01" step="0.05" value="${s.snapSettings.get().scale}" /></label>
        </div>
        <label class="field small"><input type="checkbox" id="insp-snapobj" ${s.snapSettings.get().toObjects ? 'checked' : ''} /> Snap to surfaces while dragging</label>
      </div>

      ${o.type === 'light' ? lightSection(o.light ?? null) : materialSection(o, mat)}

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Organisation</div>
            <h3>Collections</h3>
          </div>
          <button class="btn btn-xs" data-io="newcol">＋</button>
        </div>
        <div class="prop-checks">
          ${s.doc.collections.length
            ? s.doc.collections
                .map(
                  (c) => `<label class="small"><input type="checkbox" data-collection="${c.id}" ${(o.collectionIds ?? []).includes(c.id) ? 'checked' : ''} /> <span class="peer" style="--c:${c.color}">●</span> ${escapeHtml(c.name)}</label>`,
                )
                .join('')
            : '<p class="muted small">No collections yet.</p>'}
        </div>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Play Mode</div>
            <h3>Physics</h3>
          </div>
          <label class="switch">
            <input type="checkbox" id="insp-phys" ${o.physics?.enabled ? 'checked' : ''} />
            <span>Body</span>
          </label>
        </div>
        ${
          o.physics?.enabled
            ? `<div class="mat-grid">
                <label>Shape
                  <select id="insp-phys-shape" class="input input-sm">
                    ${(['box', 'sphere', 'plane'] as const)
                      .map((sh) => `<option value="${sh}"${o.physics?.shape === sh ? ' selected' : ''}>${sh}</option>`)
                      .join('')}
                  </select>
                </label>
                <label>Mass <input type="number" id="insp-phys-mass" class="input input-sm" min="0.1" step="0.5" value="${o.physics?.mass ?? 1}" /></label>
                <label>Bounce <input type="number" id="insp-phys-rest" class="input input-sm" min="0" max="1" step="0.05" value="${o.physics?.restitution ?? 0.25}" /></label>
              </div>
              <div class="prop-checks">
                <label class="small"><input type="checkbox" id="insp-phys-dyn" ${o.physics?.dynamic ? 'checked' : ''} /> Dynamic (falls)</label>
                <label class="small"><input type="checkbox" id="insp-phys-trig" ${o.physics?.trigger ? 'checked' : ''} /> Trigger volume</label>
              </div>`
            : '<p class="muted small">Enable to give this object a body in Play Mode.</p>'
        }
      </div>`;
  }

  function emptySection(): string {
    return `
      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Nothing selected</div>
            <h3>Pick an object to edit it.</h3>
          </div>
        </div>
        <p class="muted">Click in the viewport, use the outliner, or press <kbd>Ctrl</kbd>+<kbd>K</kbd> for any command.</p>
        <div class="prop-actions wrap">
          <button class="btn btn-sm" data-add="cube">▣ Cube</button>
          <button class="btn btn-sm" data-add="sphere">● Sphere</button>
          <button class="btn btn-sm" data-add="cylinder">▤ Cylinder</button>
          <button class="btn btn-sm" data-add="cone">▲ Cone</button>
          <button class="btn btn-sm" data-add="plane">▱ Plane</button>
          <button class="btn btn-sm" data-add="torus">◎ Torus</button>
          <button class="btn btn-sm" data-io="newlight">💡 Light</button>
          <button class="btn btn-sm" data-io="newgroup">🗂 Group</button>
        </div>
      </div>
      ${sceneSection()}`;
  }

  // ------------------------------------------------------------------ light
  function lightSection(l: LightData | null): string {
    if (!l) return '';
    const isSpot = l.kind === 'spot';
    const isAtten = l.kind === 'point' || isSpot;
    const maxI = l.kind === 'directional' || l.kind === 'ambient' || l.kind === 'hemisphere' ? 5 : 60;
    return `
      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Light</div>
            <h3>Light settings</h3>
          </div>
        </div>
        <label class="field">Type
          <select id="insp-lkind" class="input">
            ${(['point', 'spot', 'directional', 'ambient', 'hemisphere'] as const)
              .map((k) => `<option value="${k}"${k === l.kind ? ' selected' : ''}>${k}</option>`)
              .join('')}
          </select>
        </label>
        <div class="mat-grid">
          <label>Color <input type="color" data-light="color" value="${l.color}" /></label>
          <label>Intensity <input type="range" min="0" max="${maxI}" step="0.1" data-light="intensity" value="${l.intensity}" /></label>
          ${isAtten ? `<label>Distance <input type="range" min="0" max="60" step="0.5" data-light="distance" value="${l.distance}" /></label>` : ''}
          ${isSpot ? `<label>Angle <input type="range" min="0.1" max="1.4" step="0.05" data-light="angle" value="${l.angle}" /></label>` : ''}
          ${isSpot ? `<label>Softness <input type="range" min="0" max="1" step="0.05" data-light="penumbra" value="${l.penumbra}" /></label>` : ''}
        </div>
        ${l.kind === 'point' || isSpot || l.kind === 'directional'
          ? `<label class="field small"><input type="checkbox" data-light="castShadow" ${l.castShadow ? 'checked' : ''} /> Cast shadow</label>`
          : ''}
        <p class="small muted">Rotate spot or directional lights to aim them.</p>
      </div>`;
  }

  // --------------------------------------------------------------- materials
  function materialSection(obj: SceneObjectData, material: MaterialData | null): string {
    return `
      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Material</div>
            <h3>${material ? escapeHtml(material.name) : 'No material'}</h3>
          </div>
          <button class="btn btn-xs" data-io="newmat" title="New material">＋</button>
        </div>
        <div class="field stack-sm">
          <div class="stack-inline">
            <select id="insp-mat" class="input">
              <option value="">— None —</option>
              ${s.doc.materials.map((m) => `<option value="${m.id}"${m.id === obj.materialId ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
            </select>
            <button class="btn btn-sm" data-io="dupmat" title="Duplicate material">⧉</button>
            ${material ? '<button class="btn btn-sm" data-io="delmat" title="Delete material">🗑</button>' : ''}
          </div>
        </div>
        ${
          material
            ? `
          <div class="prop-preset-grid">
            ${MATERIAL_PRESET_IDS.map(
              (p) => `<button class="btn btn-xs" data-preset="${p}" title="Apply the ${p} preset">${p}</button>`,
            ).join('')}
          </div>
          <div class="mat-grid">
            <label>Base color <input type="color" data-mat="baseColor" value="${material.baseColor}" /></label>
            <label>Metallic <input type="range" min="0" max="1" step="0.01" data-mat="metalness" value="${material.metalness}" /></label>
            <label>Roughness <input type="range" min="0" max="1" step="0.01" data-mat="roughness" value="${material.roughness}" /></label>
            <label>Opacity <input type="range" min="0" max="1" step="0.01" data-mat="opacity" value="${material.opacity}" /></label>
          </div>
          <details class="prop-details" open>
            <summary>Emission</summary>
            <div class="mat-grid" style="margin-top:10px">
              <label>Emissive <input type="color" data-mat="emissive" value="${material.emissive}" /></label>
              <label>Glow <input type="range" min="0" max="4" step="0.05" data-mat="emissiveIntensity" value="${material.emissiveIntensity}" /></label>
            </div>
          </details>
          <details class="prop-details">
            <summary>Transmission &amp; coat</summary>
            <div class="mat-grid" style="margin-top:10px">
              <label>Transmission <input type="range" min="0" max="1" step="0.01" data-mat="transmission" value="${material.transmission}" /></label>
              <label>IOR <input type="range" min="1" max="2.5" step="0.01" data-mat="ior" value="${material.ior}" /></label>
              <label>Thickness <input type="range" min="0" max="5" step="0.05" data-mat="thickness" value="${material.thickness}" /></label>
              <label>Clearcoat <input type="range" min="0" max="1" step="0.01" data-mat="clearcoat" value="${material.clearcoat}" /></label>
              <label>Coat roughness <input type="range" min="0" max="1" step="0.01" data-mat="clearcoatRoughness" value="${material.clearcoatRoughness}" /></label>
            </div>
          </details>
          <details class="prop-details">
            <summary>Maps</summary>
            <div class="map-row" style="margin-top:10px">
              <div class="map-slot">
                <span class="field-label">Base color</span>
                ${mapSlot(material, 'base', material.mapAssetId)}
                <div class="prop-actions">
                  <button class="btn btn-xs" data-map="base">Upload</button>
                  <button class="btn btn-xs" data-mapclear="base">Clear</button>
                </div>
              </div>
              <div class="map-slot">
                <span class="field-label">Normal</span>
                ${mapSlot(material, 'normal', material.normalMapAssetId)}
                <div class="prop-actions">
                  <button class="btn btn-xs" data-map="normal">Upload</button>
                  <button class="btn btn-xs" data-mapclear="normal">Clear</button>
                </div>
                <label class="small">Strength <input type="range" min="0" max="3" step="0.05" data-mat="normalScale" value="${material.normalScale}" /></label>
              </div>
              <div class="map-slot">
                <span class="field-label">Ambient occlusion</span>
                ${mapSlot(material, 'ao', material.aoMapAssetId)}
                <div class="prop-actions">
                  <button class="btn btn-xs" data-map="ao">Upload</button>
                  <button class="btn btn-xs" data-mapclear="ao">Clear</button>
                </div>
                <label class="small">Strength <input type="range" min="0" max="2" step="0.05" data-mat="aoIntensity" value="${material.aoIntensity}" /></label>
              </div>
            </div>
            <div class="prop-actions">
              <button class="btn btn-sm" data-io="aitex">✨ AI texture…</button>
            </div>
          </details>
          <div class="prop-checks">
            <label class="small"><input type="checkbox" data-mat="flatShading" ${material.flatShading ? 'checked' : ''} /> Flat shading</label>
            <label class="small"><input type="checkbox" data-mat="doubleSide" ${material.side === 'double' ? 'checked' : ''} /> Double-sided</label>
            <label class="small"><input type="checkbox" data-mat="transparent" ${material.transparent ? 'checked' : ''} /> Transparent</label>
          </div>`
            : '<p class="muted small">Assign a material to style this object.</p>'
        }
      </div>`;
  }

  function mapSlot(material: MaterialData, slot: string, assetId: string | null): string {
    const thumb = assetId ? s.textureThumb(assetId) : null;
    return thumb
      ? `<img class="tex-thumb" src="${thumb}" alt="${slot} map preview" />`
      : `<span class="muted small">none</span>`;
  }

  // ------------------------------------------------------------------ scene
  function sceneSection(): string {
    const env = s.doc.settings.environment;
    const fog = s.doc.settings.fog;
    const post = s.doc.settings.postfx;
    return `
      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Viewport</div>
            <h3>Preview</h3>
          </div>
        </div>
        <div class="field"><span class="field-label">Shading</span>
          <div class="seg wrap">
            ${(['solid', 'material', 'wireframe'] as const)
              .map((m) => `<button class="btn btn-sm${s.shadingMode.get() === m ? ' active' : ''}" data-sh="${m}">${m}</button>`)
              .join('')}
          </div>
        </div>
        <div class="field"><span class="field-label">Camera</span>
          <div class="seg wrap">
            <button class="btn btn-sm${s.cameraType.get() === 'perspective' ? ' active' : ''}" data-cam="perspective">Perspective</button>
            <button class="btn btn-sm${s.cameraType.get() === 'orthographic' ? ' active' : ''}" data-cam="orthographic">Orthographic</button>
          </div>
        </div>
        <div class="prop-actions wrap">
          <button class="btn btn-xs" data-view="top">Top</button>
          <button class="btn btn-xs" data-view="front">Front</button>
          <button class="btn btn-xs" data-view="right">Right</button>
          <button class="btn btn-xs" data-io="frameall">Frame all</button>
          <button class="btn btn-xs" data-io="fps">🚶 First-person</button>
        </div>
        <label class="field small"><input type="checkbox" id="insp-gridvis" ${s.gridVisible.get() ? 'checked' : ''} /> Show grid</label>
        <label class="field small"><input type="checkbox" id="insp-shadows" ${s.doc.settings.shadows ? 'checked' : ''} /> Shadows</label>
        <div class="field"><span class="field-label">Environment light</span>
          <input type="range" id="insp-env" min="0" max="2" step="0.05" value="${s.doc.settings.envIntensity}" />
        </div>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Environment</div>
            <h3>Lighting &amp; sky</h3>
          </div>
        </div>
        <div class="prop-preset-grid">
          ${ENVIRONMENT_PRESETS.map(
            (p) => `<button class="btn btn-xs${env?.preset === p.id ? ' active' : ''}" data-env="${p.id}">${escapeHtml(p.label.split(' ')[0])}</button>`,
          ).join('')}
        </div>
        <label class="field small"><input type="checkbox" id="insp-envbg" ${env?.background ? 'checked' : ''} /> Show environment as background</label>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Atmosphere</div>
            <h3>Fog</h3>
          </div>
          <label class="switch"><input type="checkbox" id="insp-fog" ${fog?.enabled ? 'checked' : ''} /><span>On</span></label>
        </div>
        <div class="mat-grid">
          <label>Color <input type="color" id="insp-fogcolor" value="${fog?.color ?? '#11141b'}" /></label>
          <label>Near <input type="number" id="insp-fognear" class="input input-sm" min="0" step="1" value="${fog?.near ?? 8}" /></label>
          <label>Far <input type="number" id="insp-fogfar" class="input input-sm" min="1" step="1" value="${fog?.far ?? 60}" /></label>
        </div>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Post-processing</div>
            <h3>Bloom · vignette · grain</h3>
          </div>
          <label class="switch"><input type="checkbox" id="insp-post" ${post?.enabled ? 'checked' : ''} /><span>On</span></label>
        </div>
        <div class="mat-grid">
          <label>Bloom <input type="range" id="insp-bloom" min="0" max="2" step="0.05" value="${post?.bloom ?? 0.45}" /></label>
          <label>Vignette <input type="range" id="insp-vignette" min="0" max="1" step="0.05" value="${post?.vignette ?? 0.35}" /></label>
          <label>Grain <input type="range" id="insp-grain" min="0" max="1" step="0.02" value="${post?.grain ?? 0.08}" /></label>
          <label>Blur (DoF) <input type="range" id="insp-dof" min="0" max="1" step="0.05" value="${post?.dof ?? 0}" /></label>
        </div>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Camera bookmarks</div>
            <h3>Saved views</h3>
          </div>
          <button class="btn btn-xs" data-io="bookmark">＋ Save</button>
        </div>
        ${
          s.doc.cameraBookmarks.length
            ? s.doc.cameraBookmarks
                .map(
                  (b) => `<div class="member-row">
                    <span class="member-name">${escapeHtml(b.name)}</span>
                    <span class="spacer"></span>
                    <button class="btn btn-xs" data-bookmark-go="${b.id}">Go</button>
                    <button class="btn btn-xs" data-bookmark-del="${b.id}">🗑</button>
                  </div>`,
                )
                .join('')
            : '<p class="muted small">Frame a view and press ＋ Save.</p>'
        }
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Mesh tools</div>
            <h3>Modelling</h3>
          </div>
        </div>
        <div class="prop-actions wrap">
          <button class="btn btn-sm" data-io="merge">Merge selection</button>
          <button class="btn btn-sm" data-io="subdivide">Subdivide</button>
          <button class="btn btn-sm" data-io="simplify">Simplify</button>
        </div>
        <p class="muted small">Merge combines selected objects into one mesh. Subdivide and simplify rewrite the geometry (stored as a GLB asset so it survives reloads).</p>
      </div>

      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Project</div>
            <h3>Stats</h3>
          </div>
        </div>
        <p class="small muted">${s.doc.objects.length} objects · ${s.doc.materials.length} materials · ${s.doc.clips.length} clips · ${s.doc.assets.length} assets</p>
        ${
          s.selection.count()
            ? `<p class="small muted">Selected: ${(() => {
                const st = s.selectionStats();
                return `${st.objects} objects · ${st.tris.toLocaleString()} triangles`;
              })()}</p>`
            : ''
        }
      </div>`;
  }

  // ------------------------------------------------------------------- wire
  function wire(): void {
    const o = s.selectedObject();
    const mat = o ? (s.doc.materials.find((m) => m.id === o.materialId) ?? null) : null;

    el.querySelectorAll('[data-insp-tab]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        tab = (b as HTMLElement).dataset.inspTab as 'object' | 'scene';
        render();
      };
    });

    el.querySelectorAll('[data-tmode]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.setTransformMode((b as HTMLElement).dataset.tmode as 'translate' | 'rotate' | 'scale');
    });
    el.querySelectorAll('[data-space]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.setGizmoSpace((b as HTMLElement).dataset.space as 'local' | 'world');
    });
    el.querySelectorAll('[data-sh]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.shadingMode.set((b as HTMLElement).dataset.sh as 'solid' | 'material' | 'wireframe');
    });
    el.querySelectorAll('[data-cam]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.cameraType.set((b as HTMLElement).dataset.cam as 'perspective' | 'orthographic');
    });
    el.querySelectorAll('[data-view]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        const map: Record<string, [number, number]> = { top: [0, 1], front: [0, 90], right: [90, 90], back: [180, 90], left: [-90, 90] };
        const v = map[(b as HTMLElement).dataset.view as string];
        if (v) {
          s.viewport.setView(v[0], v[1]);
          s.persistCamera();
        }
      };
    });
    el.querySelectorAll('[data-env]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.setEnvironment({ preset: (b as HTMLElement).dataset.env as EnvironmentPreset });
    });
    el.querySelectorAll('[data-preset]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        if (!mat) return;
        s.applyMaterialPreset(mat.id, (b as HTMLElement).dataset.preset as MaterialPresetId);
      };
    });
    el.querySelectorAll('[data-mirror]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.mirrorSelection((b as HTMLElement).dataset.mirror as 'x' | 'y' | 'z');
    });
    el.querySelectorAll('[data-pivot]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.setPivotPreset((b as HTMLElement).dataset.pivot as 'center' | 'base' | 'top' | 'origin');
    });
    el.querySelectorAll('[data-add]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.addPrimitive((b as HTMLElement).dataset.add as 'cube');
    });
    el.querySelectorAll('[data-collection]').forEach((c) => {
      (c as HTMLInputElement).onchange = (e) => {
        if (!o) return;
        const colId = (c as HTMLElement).dataset.collection as string;
        const checked = (e.target as HTMLInputElement).checked;
        const list = new Set(o.collectionIds ?? []);
        if (checked) list.add(colId);
        else list.delete(colId);
        o.collectionIds = [...list];
        s.markDirty('collection');
      };
    });
    el.querySelectorAll('[data-map]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        if (!mat) return;
        const slot = (b as HTMLElement).dataset.map as 'base' | 'normal' | 'ao';
        void pickFiles('image/*').then(async (files) => {
          if (!files.length) return;
          toast(`Uploading ${files[0].name}…`);
          await s.uploadTexture(mat.id, files[0], slot);
          toast(`${slot} map applied`, 'success');
        });
      };
    });
    el.querySelectorAll('[data-mapclear]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        if (!mat) return;
        const slot = (b as HTMLElement).dataset.mapclear as 'base' | 'normal' | 'ao';
        s.setMaterialMap(mat.id, slot, null);
        void s.hydrateTextures();
      };
    });

    // named inputs
    const bind = (id: string, event: 'oninput' | 'onchange', fn: (el: HTMLInputElement) => void): void => {
      const input = el.querySelector(id) as HTMLInputElement | null;
      if (input) input[event] = () => fn(input);
    };

    bind('#insp-name', 'onchange', (input) => {
      if (o) s.renameObject(o.id, input.value.trim() || o.name);
    });
    bind('#insp-parent', 'onchange', (input) => {
      if (o) s.setParent(o.id, input.value || null);
    });
    bind('#insp-snap', 'onchange', (input) => s.setSnapSettings({ enabled: input.checked }));
    bind('#insp-grid', 'onchange', (input) => s.setSnapSettings({ grid: Math.max(0.01, parseFloat(input.value) || 0.25) }));
    bind('#insp-angle', 'onchange', (input) => s.setSnapSettings({ angle: Math.max(1, Math.min(90, parseFloat(input.value) || 15)) }));
    bind('#insp-scalesnap', 'onchange', (input) => s.setSnapSettings({ scale: Math.max(0.01, parseFloat(input.value) || 0.1) }));
    bind('#insp-snapobj', 'onchange', (input) => s.setSnapSettings({ toObjects: input.checked }));
    bind('#insp-env', 'oninput', (input) => {
      s.updateSettings({ envIntensity: parseFloat(input.value) });
      if (s.doc.settings.environment) s.setEnvironment({ intensity: parseFloat(input.value) });
    });
    bind('#insp-shadows', 'onchange', (input) => s.updateSettings({ shadows: input.checked }));
    bind('#insp-gridvis', 'onchange', () => s.toggleGrid());
    bind('#insp-envbg', 'onchange', (input) => s.setEnvironment({ background: input.checked }));
    bind('#insp-fog', 'onchange', (input) => s.setFog({ enabled: input.checked }));
    bind('#insp-fogcolor', 'oninput', (input) => s.setFog({ color: input.value }));
    bind('#insp-fognear', 'onchange', (input) => s.setFog({ near: parseFloat(input.value) || 0 }));
    bind('#insp-fogfar', 'onchange', (input) => s.setFog({ far: parseFloat(input.value) || 1 }));
    bind('#insp-post', 'onchange', (input) => s.setPostFx({ enabled: input.checked }));
    bind('#insp-bloom', 'oninput', (input) => s.setPostFx({ bloom: parseFloat(input.value) }));
    bind('#insp-vignette', 'oninput', (input) => s.setPostFx({ vignette: parseFloat(input.value) }));
    bind('#insp-grain', 'oninput', (input) => s.setPostFx({ grain: parseFloat(input.value) }));
    bind('#insp-dof', 'oninput', (input) => s.setPostFx({ dof: parseFloat(input.value) }));
    bind('#insp-phys', 'onchange', (input) => s.setPhysics({ enabled: input.checked }));
    bind('#insp-phys-mass', 'onchange', (input) => s.setPhysics({ mass: Math.max(0.1, parseFloat(input.value) || 1) }));
    bind('#insp-phys-rest', 'onchange', (input) => s.setPhysics({ restitution: Math.max(0, Math.min(1, parseFloat(input.value) || 0)) }));
    bind('#insp-phys-dyn', 'onchange', (input) => s.setPhysics({ dynamic: input.checked }));
    bind('#insp-phys-trig', 'onchange', (input) => s.setPhysics({ trigger: input.checked }));
    const shapeSel = el.querySelector('#insp-phys-shape') as HTMLSelectElement | null;
    if (shapeSel) shapeSel.onchange = () => s.setPhysics({ shape: shapeSel.value as 'box' | 'sphere' | 'plane' });

    const lkindSel = el.querySelector('#insp-lkind') as HTMLSelectElement | null;
    if (lkindSel && o) {
      lkindSel.onchange = () => {
        s.history.checkpoint(s.doc, 'Change light');
        s.updateLight(o.id, { kind: lkindSel.value as LightData['kind'] });
      };
    }

    el.querySelectorAll('[data-light]').forEach((inp) => {
      const input = inp as HTMLInputElement;
      const apply = (): void => {
        if (!o) return;
        const k = input.dataset.light as string;
        const v = input.type === 'checkbox' ? input.checked : input.type === 'color' ? input.value : parseFloat(input.value);
        s.updateLight(o.id, { [k]: v } as Partial<LightData>);
      };
      input.oninput = apply;
      input.onchange = () => s.history.checkpoint(s.doc, 'Edit light', 1500);
    });

    if (mat) {
      el.querySelectorAll('[data-mat]').forEach((inp) => {
        const input = inp as HTMLInputElement;
        const apply = (): void => {
          const k = input.dataset.mat as string;
          if (k === 'doubleSide') {
            s.updateMaterial(mat.id, { side: input.checked ? 'double' : 'front' });
            return;
          }
          if (input.type === 'checkbox') {
            s.updateMaterial(mat.id, { [k]: input.checked } as Partial<MaterialData>);
            return;
          }
          const raw = input.value;
          const v = k === 'baseColor' || k === 'emissive' ? raw : parseFloat(raw);
          s.updateMaterial(mat.id, { [k]: v } as Partial<MaterialData>);
        };
        input.oninput = apply;
        input.onchange = () => s.history.checkpoint(s.doc, 'Edit material', 1500);
      });
    }

    const matSel = el.querySelector('#insp-mat') as HTMLSelectElement | null;
    if (matSel && o) matSel.onchange = () => s.assignMaterial(o.id, matSel.value || null);

    // numeric transform fields (apply to the whole selection)
    el.querySelectorAll('[data-vec]').forEach((inp) => {
      (inp as HTMLInputElement).onchange = (e) => {
        if (!o) return;
        const [kind, idx] = ((e.target as HTMLInputElement).dataset.vec as string).split(':');
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (Number.isNaN(v)) return;
        const i = Number(idx);
        const ids = s.selection.ids().length ? s.selection.ids() : [o.id];
        s.history.checkpoint(s.doc, 'Edit transform', 1200);
        for (const id of ids) {
          const target = s.doc.objects.find((x) => x.id === id);
          if (!target) continue;
          if (kind === 'Position') {
            const p = { ...target.position };
            if (i === 0) p.x = v;
            if (i === 1) p.y = v;
            if (i === 2) p.z = v;
            s.setTransform(id, p);
          } else if (kind === 'Rotation°') {
            s.setTransform(id, undefined, {
              x: i === 0 ? v : r2d(target.rotation.x),
              y: i === 1 ? v : r2d(target.rotation.y),
              z: i === 2 ? v : r2d(target.rotation.z),
            });
          } else {
            const sc = { ...target.scale };
            if (i === 0) sc.x = v;
            if (i === 1) sc.y = v;
            if (i === 2) sc.z = v;
            s.setTransform(id, undefined, undefined, sc);
          }
        }
      };
    });

    const ioActs: Record<string, () => void> = {
      vis: () => o && s.toggleVisible(o.id),
      lock: () => o && s.toggleLock(o.id),
      dup: () => s.duplicateSelection(),
      del: () => s.deleteSelection(),
      ungroup: () => o && s.ungroupObject(o.id),
      newmat: () => {
        const m = s.addMaterial(`Material ${s.doc.materials.length + 1}`);
        if (o) s.assignMaterial(o.id, m.id);
        toast('Material created', 'success');
      },
      dupmat: () => {
        if (!mat) return;
        s.duplicateMaterial(mat.id);
        toast('Material duplicated', 'success');
      },
      delmat: () => mat && s.deleteMaterial(mat.id),
      newgroup: () => {
        const g = s.addGroup();
        s.renameObject(g.id, 'Group');
      },
      newlight: () => s.addLight('point'),
      newcol: () => {
        const name = window.prompt('Collection name', `Collection ${s.doc.collections.length + 1}`);
        if (name && o) {
          const c = s.createCollection(name);
          s.assignToCollection(c.id, [o.id]);
        }
      },
      reset: () => s.resetTransform('all'),
      applyall: () => s.applyTransforms('all'),
      applyrs: () => s.applyTransforms('rotationScale'),
      drop: () => s.dropToGround(),
      snapgrid: () => s.snapSelectionToGrid(),
      pivotmode: () => s.setTransformTarget(s.transformTarget.get() === 'pivot' ? 'object' : 'pivot'),
      frameall: () => {
        s.select(null);
        s.viewport.focusIds(null);
      },
      fps: () => s.toggleFirstPerson(),
      bookmark: () => {
        const name = window.prompt('Bookmark name', `View ${s.doc.cameraBookmarks.length + 1}`);
        const b = s.addCameraBookmark(name ?? undefined);
        if (b) toast('Bookmark saved', 'success');
      },
      merge: () => void s.mergeSelection(),
      subdivide: () => void s.subdivideSelection(2),
      simplify: () => void s.simplifySelection(0.5),
      aitex: () => void s.generateTextureForSelection(),
      copyxf: () => {
        if (!o) return;
        xfer = {
          position: [o.position.x, o.position.y, o.position.z],
          rotationDeg: [r2d(o.rotation.x), r2d(o.rotation.y), r2d(o.rotation.z)],
          scale: [o.scale.x, o.scale.y, o.scale.z],
        };
        toast('Transform copied', 'success');
        render();
      },
      pastexf: () => {
        if (!xfer) {
          toast('Copy a transform first', 'warn');
          return;
        }
        s.history.checkpoint(s.doc, 'Paste transform');
        for (const id of s.selection.ids()) {
          s.setTransform(
            id,
            { x: xfer.position[0], y: xfer.position[1], z: xfer.position[2] },
            { x: xfer.rotationDeg[0], y: xfer.rotationDeg[1], z: xfer.rotationDeg[2] },
            { x: xfer.scale[0], y: xfer.scale[1], z: xfer.scale[2] },
          );
        }
        toast('Transform pasted', 'success');
      },
    };
    el.querySelectorAll('[data-io]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => ioActs[(b as HTMLElement).dataset.io as string]?.();
    });
    el.querySelectorAll('[data-bookmark-go]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.gotoBookmark((b as HTMLElement).dataset.bookmarkGo as string);
    });
    el.querySelectorAll('[data-bookmark-del]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.removeBookmark((b as HTMLElement).dataset.bookmarkDel as string);
    });
  }

  const u1 = s.rev.subscribe(render);
  const u2 = s.selection.subscribe(render);
  const u3 = s.selection.subscribeIds(() => render());
  const u4 = s.snapSettings.subscribe(() => render());
  const u5 = s.gizmoSpace.subscribe(() => render());
  const u6 = s.transformMode.subscribe(() => render());
  render();
  return () => {
    u1();
    u2();
    u3();
    u4();
    u5();
    u6();
  };
}

export type { FogSettings, PostFxSettings };
