import type { EditorSession } from '../editor/session.js';
import type { LightData, SceneObjectData } from '../state/models.js';
import * as THREE from 'three';
import { escapeHtml, pickFiles } from '../lib/utils.js';
import { isWithinSubtree } from '../state/tree.js';
import { toast } from './toast.js';

/** Copy/paste hand-off buffer (cross-tab via the system clipboard too). */
interface TransformClipboard {
  version: 1;
  position: [number, number, number];
  rotationDeg: [number, number, number];
  scale: [number, number, number];
}
let xfer: TransformClipboard | null = null;

export function buildInspector(s: EditorSession, el: HTMLElement): () => void {
  function numRow(label: string, vals: [number, number, number], step: number): string {
    const axes = ['X', 'Y', 'Z'];
    return `
      <div class="field">
        <span class="field-label">${label}</span>
        <div class="vec3">
          ${vals
            .map(
              (v, i) =>
                `<label class="axis axis-${axes[i].toLowerCase()}">${axes[i]}<input class="input input-sm" data-vec="${label}:${i}" type="number" step="${step}" value="${Number(v.toFixed(3))}" /></label>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  function render(): void {
    if (el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const o = s.selectedObject();

    if (!o) {
      el.innerHTML = `
        <div class="panel-title">Properties</div>
        <div class="prop-card">
          <div class="prop-card-head">
            <div>
              <div class="prop-eyebrow">Nothing selected</div>
              <h3>Pick an object to edit it.</h3>
            </div>
          </div>
          <p class="muted">Start by adding a primitive, then use Move, Rotate, Scale, and the material controls here.</p>
        </div>
        <div class="prop-card">
          <div class="prop-card-head">
            <div>
              <div class="prop-eyebrow">Viewport</div>
              <h3>Preview controls</h3>
            </div>
          </div>
          <div class="field"><span class="field-label">Shading</span>
            <div class="seg wrap">
              ${(['solid', 'material', 'wireframe'] as const).map((m) => `<button class="btn btn-sm${s.shadingMode.get() === m ? ' active' : ''}" data-sh="${m}">${m}</button>`).join('')}
            </div>
          </div>
          <div class="field"><span class="field-label">Camera</span>
            <div class="seg wrap">
              <button class="btn btn-sm${s.cameraType.get() === 'perspective' ? ' active' : ''}" data-cam="perspective">Perspective</button>
              <button class="btn btn-sm${s.cameraType.get() === 'orthographic' ? ' active' : ''}" data-cam="orthographic">Orthographic</button>
            </div>
          </div>
          <div class="field"><span class="field-label">Environment light</span>
            <input type="range" id="insp-env" min="0" max="2" step="0.05" value="${s.doc.settings.envIntensity}" />
          </div>
          <label class="field small"><input type="checkbox" id="insp-shadows" ${s.doc.settings.shadows ? 'checked' : ''} /> Shadows</label>
          <p class="small muted">${s.doc.objects.length} objects · ${s.doc.materials.length} materials · ${s.doc.clips.length} clips</p>
        </div>`;
      el.querySelectorAll('[data-sh]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => s.shadingMode.set((b as HTMLElement).dataset.sh as 'solid' | 'material' | 'wireframe');
      });
      el.querySelectorAll('[data-cam]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => s.cameraType.set((b as HTMLElement).dataset.cam as 'perspective' | 'orthographic');
      });
      (el.querySelector('#insp-env') as HTMLInputElement).oninput = (e) => {
        s.updateSettings({ envIntensity: parseFloat((e.target as HTMLInputElement).value) });
      };
      (el.querySelector('#insp-shadows') as HTMLInputElement).onchange = (e) => {
        s.updateSettings({ shadows: (e.target as HTMLInputElement).checked });
      };
      return;
    }

    const mat = s.doc.materials.find((m) => m.id === o.materialId) ?? null;
    const d = THREE.MathUtils.radToDeg;
    el.innerHTML = `
      <div class="panel-title">Properties</div>
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
          <button class="btn btn-sm" data-io="vis">${o.visible ? 'Hide object' : 'Show object'}</button>
          <button class="btn btn-sm" data-io="lock">${o.locked ? 'Unlock editing' : 'Lock editing'}</button>
          <button class="btn btn-sm" data-io="dup">Duplicate</button>
          <button class="btn btn-sm" data-io="del">Delete</button>
        </div>
        <label class="field">Parent
          <select id="insp-parent" class="input">
            <option value="">— Scene root —</option>
            ${s.doc.objects
              // offering a descendant here used to let users freeze the tab (parent cycle)
              .filter((x) => x.id !== o.id && !isWithinSubtree(s.doc.objects, o.id, x.id))
              .map((x) => `<option value="${x.id}"${x.id === o.parentId ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}
          </select>
        </label>
        ${o.type === 'group' ? '<button class="btn btn-sm" data-io="ungroup">Ungroup</button>' : ''}
      </div>
      <div class="prop-card">
        <div class="prop-card-head">
          <div>
            <div class="prop-eyebrow">Step 2</div>
            <h3>Transform</h3>
          </div>
          <span class="muted small">Position, rotation, scale</span>
        </div>
        ${numRow('Position', [o.position.x, o.position.y, o.position.z], 0.1)}
        ${numRow('Rotation°', [d(o.rotation.x), d(o.rotation.y), d(o.rotation.z)], 1)}
        ${numRow('Scale', [o.scale.x, o.scale.y, o.scale.z], 0.05)}
        <div class="prop-actions" style="margin-top:8px">
          <button class="btn btn-sm" data-io="reset">Reset</button>
          <button class="btn btn-sm" data-io="copyxf">Copy</button>
          <button class="btn btn-sm" data-io="pastexf"${xfer ? '' : ' disabled'}>Paste</button>
        </div>
      </div>
      ${o.type === 'light' ? lightSection(o.light ?? null) : materialSection(o, mat)}`;

    function lightSection(l: LightData | null): string {
      if (!l) return '';
      const isSpot = l.kind === 'spot';
      const isAtten = l.kind === 'point' || isSpot;
      const maxI = l.kind === 'directional' || l.kind === 'ambient' || l.kind === 'hemisphere' ? 5 : 60;
      return `
        <div class="prop-card">
          <div class="prop-card-head">
            <div>
              <div class="prop-eyebrow">Step 3</div>
              <h3>Light settings</h3>
            </div>
          </div>
          <label class="field">Light type
            <select id="insp-lkind" class="input">
              ${(['point', 'spot', 'directional', 'ambient', 'hemisphere'] as const).map((k) => `<option value="${k}"${k === l.kind ? ' selected' : ''}>${k}</option>`).join('')}
            </select>
          </label>
          <div class="mat-grid">
            <label>Color <input type="color" data-light="color" value="${l.color}" /></label>
            <label>Intensity <input type="range" min="0" max="${maxI}" step="0.1" data-light="intensity" value="${l.intensity}" /></label>
            ${isAtten ? `<label>Distance <input type="range" min="0" max="60" step="0.5" data-light="distance" value="${l.distance}" /></label>` : ''}
            ${isSpot ? `<label>Angle <input type="range" min="0.1" max="1.4" step="0.05" data-light="angle" value="${l.angle}" /></label>` : ''}
            ${isSpot ? `<label>Softness <input type="range" min="0" max="1" step="0.05" data-light="penumbra" value="${l.penumbra}" /></label>` : ''}
          </div>
          ${l.kind === 'point' || l.kind === 'spot' || l.kind === 'directional' ? `<label class="field small"><input type="checkbox" data-light="castShadow" ${l.castShadow ? 'checked' : ''} /> Cast shadow</label>` : ''}
          <p class="small muted">Tip: rotate spot or directional lights to aim them.</p>
        </div>`;
    }

    function materialSection(obj: SceneObjectData, material: typeof mat): string {
      return `
        <div class="prop-card">
          <div class="prop-card-head">
            <div>
              <div class="prop-eyebrow">Step 3</div>
              <h3>Style</h3>
            </div>
            <span class="muted small">Material and texture</span>
          </div>
          <div class="field stack-sm">
            <label class="field-label" for="insp-mat">Material</label>
            <div class="stack-inline">
              <select id="insp-mat" class="input">
                <option value="">— None —</option>
                ${s.doc.materials.map((m) => `<option value="${m.id}"${m.id === obj.materialId ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
              </select>
              <button class="btn btn-sm" data-io="newmat">New material</button>
            </div>
          </div>
          ${material ? `
            <div class="prop-preset-grid">
              <button class="btn btn-sm" data-preset="matte">Matte</button>
              <button class="btn btn-sm" data-preset="metal">Metal</button>
              <button class="btn btn-sm" data-preset="glass">Glass</button>
              <button class="btn btn-sm" data-preset="neon">Neon</button>
            </div>
            <div class="mat-grid">
              <label>Base color <input type="color" data-mat="baseColor" value="${material.baseColor}" /></label>
              <label>Finish <input type="range" min="0" max="1" step="0.01" data-mat="roughness" value="${material.roughness}" /></label>
              <label>Metalness <input type="range" min="0" max="1" step="0.01" data-mat="metalness" value="${material.metalness}" /></label>
              <label>Opacity <input type="range" min="0" max="1" step="0.01" data-mat="opacity" value="${material.opacity}" /></label>
            </div>
            <details class="prop-details">
              <summary>Advanced material</summary>
              <div class="mat-grid" style="margin-top:10px">
                <label>Emissive <input type="color" data-mat="emissive" value="${material.emissive}" /></label>
                <label>Glow <input type="range" min="0" max="3" step="0.05" data-mat="emissiveIntensity" value="${material.emissiveIntensity}" /></label>
              </div>
              <div class="prop-checks">
                <label class="small"><input type="checkbox" data-mat="flatShading" ${material.flatShading ? 'checked' : ''} /> Flat shading</label>
                <label class="small"><input type="checkbox" data-mat="doubleSide" ${material.side === 'double' ? 'checked' : ''} /> Double-sided</label>
              </div>
            </details>
            <div class="prop-card prop-card-soft">
              <div class="prop-card-head">
                <div>
                  <div class="prop-eyebrow">Texture</div>
                  <h3>Base color map</h3>
                </div>
              </div>
              <div class="stack-inline texture-row">
                ${material.mapAssetId && s.textureThumb(material.mapAssetId) ? `<img class="tex-thumb" src="${s.textureThumb(material.mapAssetId)}" alt="Texture preview" />` : '<span class="muted small">No texture yet</span>'}
                <div class="prop-actions texture-actions">
                  <button class="btn btn-sm" data-io="texup">Upload texture</button>
                  ${material.mapAssetId ? '<button class="btn btn-sm" data-io="texrm">Remove texture</button>' : ''}
                </div>
              </div>
            </div>` : '<p class="muted small">Assign a material to unlock styling controls.</p>'}
          ${obj.type === 'imported' ? `<p class="small muted">Imported mesh${obj.assetId ? '' : ' — asset bytes missing'}</p>` : ''}
        </div>`;
    }

    (el.querySelector('#insp-name') as HTMLInputElement).onchange = (e) => {
      s.renameObject(o.id, (e.target as HTMLInputElement).value.trim());
    };
    (el.querySelector('#insp-parent') as HTMLSelectElement).onchange = (e) => {
      s.setParent(o.id, (e.target as HTMLSelectElement).value || null);
    };

    const matSel = el.querySelector('#insp-mat') as HTMLSelectElement | null;
    if (matSel) {
      matSel.onchange = (e) => {
        s.assignMaterial(o.id, (e.target as HTMLSelectElement).value || null);
      };
    }

    const lkindSel = el.querySelector('#insp-lkind') as HTMLSelectElement | null;
    if (lkindSel) {
      lkindSel.onchange = (e) => {
        s.history.checkpoint(s.doc, 'Change light');
        s.updateLight(o.id, { kind: (e.target as HTMLSelectElement).value as 'point' | 'spot' | 'directional' | 'ambient' | 'hemisphere' });
      };
    }

    el.querySelectorAll('[data-light]').forEach((inp) => {
      const input = inp as HTMLInputElement;
      const apply = () => {
        const k = input.dataset.light as string;
        const v = input.type === 'checkbox' ? input.checked : input.type === 'color' ? input.value : parseFloat(input.value);
        s.updateLight(o.id, { [k]: v } as Record<string, unknown> as Parameters<typeof s.updateLight>[1]);
      };
      input.oninput = apply;
      input.onchange = () => s.history.checkpoint(s.doc, 'Edit light', 1500);
    });

    const ioActs: Record<string, () => void> = {
      vis: () => s.toggleVisible(o.id),
      lock: () => s.toggleLock(o.id),
      dup: () => s.duplicateObject(o.id),
      del: () => s.deleteObject(o.id),
      ungroup: () => s.ungroupObject(o.id),
      reset: () => {
        s.history.checkpoint(s.doc, 'Reset transform');
        s.setTransform(o.id, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
        toast('Transform reset', 'success');
      },
      copyxf: async () => {
        xfer = {
          version: 1,
          position: [o.position.x, o.position.y, o.position.z],
          rotationDeg: [THREE.MathUtils.radToDeg(o.rotation.x), THREE.MathUtils.radToDeg(o.rotation.y), THREE.MathUtils.radToDeg(o.rotation.z)],
          scale: [o.scale.x, o.scale.y, o.scale.z],
        };
        try { await navigator.clipboard.writeText(`web3ds.transform:${JSON.stringify(xfer)}`); } catch { /* clipboard optional in non-secure contexts */ }
        toast('Transform copied', 'success');
        render();
      },
      pastexf: () => {
        if (!xfer) { toast('Copy a transform first', 'warn'); return; }
        s.history.checkpoint(s.doc, 'Paste transform');
        s.setTransform(
          o.id,
          { x: xfer.position[0], y: xfer.position[1], z: xfer.position[2] },
          { x: xfer.rotationDeg[0], y: xfer.rotationDeg[1], z: xfer.rotationDeg[2] },
          { x: xfer.scale[0], y: xfer.scale[1], z: xfer.scale[2] },
        );
        toast('Transform pasted', 'success');
      },
      newmat: () => {
        const m = s.addMaterial();
        s.assignMaterial(o.id, m.id);
        toast('Material created', 'success');
      },
      texup: () => void (async () => {
        if (!mat) return;
        const files = await pickFiles('image/*');
        if (!files.length) return;
        toast(`Uploading ${files[0].name}…`);
        await s.uploadTexture(mat.id, files[0]);
      })(),
      texrm: () => {
        if (mat) s.removeTexture(mat.id);
      },
    };
    const presets: Record<string, Partial<{ baseColor: string; metalness: number; roughness: number; emissive: string; emissiveIntensity: number; opacity: number; transparent: boolean }>> = {
      matte: { metalness: 0, roughness: 0.9, emissiveIntensity: 0, opacity: 1, transparent: false },
      metal: { metalness: 1, roughness: 0.25, emissiveIntensity: 0, opacity: 1, transparent: false },
      glass: { metalness: 0, roughness: 0.05, opacity: 0.35, transparent: true, emissiveIntensity: 0 },
      neon: { metalness: 0, roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 2, opacity: 1, transparent: false },
    };
    el.querySelectorAll('[data-preset]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        if (!mat) return;
        s.history.checkpoint(s.doc, 'Material preset');
        const p = presets[(b as HTMLElement).dataset.preset as string] ?? {};
        if ((b as HTMLElement).dataset.preset === 'neon') p.emissive = mat.baseColor;
        s.updateMaterial(mat.id, p);
      };
    });
    el.querySelectorAll('[data-io]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => ioActs[(b as HTMLElement).dataset.io as string]?.();
    });

    el.querySelectorAll('[data-vec]').forEach((inp) => {
      (inp as HTMLInputElement).onchange = (e) => {
        const [kind, idx] = ((e.target as HTMLInputElement).dataset.vec as string).split(':');
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (Number.isNaN(v)) return;
        const i = Number(idx);
        s.history.checkpoint(s.doc, 'Edit transform', 1200);
        if (kind === 'Position') {
          const p = { ...o.position };
          if (i === 0) p.x = v;
          if (i === 1) p.y = v;
          if (i === 2) p.z = v;
          s.setTransform(o.id, p);
        } else if (kind === 'Rotation°') {
          s.setTransform(o.id, undefined, {
            x: i === 0 ? v : d(o.rotation.x),
            y: i === 1 ? v : d(o.rotation.y),
            z: i === 2 ? v : d(o.rotation.z),
          });
        } else {
          const sc = { ...o.scale };
          if (i === 0) sc.x = v;
          if (i === 1) sc.y = v;
          if (i === 2) sc.z = v;
          s.setTransform(o.id, undefined, undefined, sc);
        }
      };
    });

    if (mat) {
      el.querySelectorAll('[data-mat]').forEach((inp) => {
        const input = inp as HTMLInputElement;
        const apply = () => {
          const k = input.dataset.mat as string;
          if (k === 'doubleSide') {
            s.updateMaterial(mat.id, { side: input.checked ? 'double' : 'front' });
            return;
          }
          if (input.type === 'checkbox') {
            s.updateMaterial(mat.id, { [k]: input.checked } as Partial<typeof mat>);
            return;
          }
          const raw = input.value;
          const v = k === 'baseColor' || k === 'emissive' ? raw : parseFloat(raw);
          s.updateMaterial(mat.id, { [k]: v } as Partial<typeof mat>);
        };
        input.oninput = apply;
        input.onchange = () => {
          if (input.type === 'checkbox') s.history.checkpoint(s.doc, 'Edit material');
          else s.history.checkpoint(s.doc, 'Edit material', 1500);
        };
      });
    }
  }

  const u1 = s.rev.subscribe(render);
  const u2 = s.selection.subscribe(render);
  render();
  return () => {
    u1();
    u2();
  };
}
