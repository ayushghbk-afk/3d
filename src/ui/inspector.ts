import type { EditorSession } from '../editor/session.js';
import type { LightData, SceneObjectData } from '../state/models.js';
import * as THREE from 'three';
import { escapeHtml, pickFiles } from '../lib/utils.js';
import { toast } from './toast.js';

export function buildInspector(s: EditorSession, el: HTMLElement): () => void {
  function numRow(label: string, vals: [number, number, number], step: number, onChange: (i: number, v: number) => void): string {
    const axes = ['X', 'Y', 'Z'];
    return `<div class="field"><span class="field-label">${label}</span><div class="vec3">${vals
      .map(
        (v, i) =>
          `<label class="axis axis-${axes[i].toLowerCase()}">${axes[i]}<input class="input input-sm" data-vec="${label}:${i}" type="number" step="${step}" value="${Number(v.toFixed(3))}" /></label>`,
      )
      .join('')}</div></div>`;
  }

  function render(): void {
    // don't clobber while typing
    if (el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const o = s.selectedObject();
    if (!o) {
      el.innerHTML = `
        <div class="panel-title">Inspector</div>
        <p class="muted small">Select an object to edit its transform and material.</p>
        <div class="field"><span class="field-label">Shading</span>
          <div class="seg">
            ${(['solid', 'material', 'wireframe'] as const).map((m) => `<button class="btn btn-sm${s.shadingMode.get() === m ? ' active' : ''}" data-sh="${m}">${m}</button>`).join('')}
          </div>
        </div>
        <div class="field"><span class="field-label">Camera</span>
          <div class="seg">
            <button class="btn btn-sm${s.cameraType.get() === 'perspective' ? ' active' : ''}" data-cam="perspective">Persp</button>
            <button class="btn btn-sm${s.cameraType.get() === 'orthographic' ? ' active' : ''}" data-cam="orthographic">Ortho</button>
          </div>
        </div>
        <div class="field"><span class="field-label">Environment light</span>
          <input type="range" id="insp-env" min="0" max="2" step="0.05" value="${s.doc.settings.envIntensity}" />
        </div>
        <label class="field small"><input type="checkbox" id="insp-shadows" ${s.doc.settings.shadows ? 'checked' : ''} /> Shadows</label>
        <div class="field"><span class="field-label">Scene</span>
          <p class="small">${s.doc.objects.length} objects · ${s.doc.materials.length} materials · ${s.doc.clips.length} clips</p>
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
      <div class="panel-title">Inspector</div>
      <label class="field">Name
        <input id="insp-name" class="input" value="${escapeHtml(o.name)}" maxlength="60" />
      </label>
      <div class="row-between">
        <span class="badge">${escapeHtml(o.type)}</span>
        <span>
          <button class="btn btn-sm" data-io="vis" title="Visibility">${o.visible ? '👁' : '🚫'}</button>
          <button class="btn btn-sm" data-io="lock" title="Lock">${o.locked ? '🔒' : '🔓'}</button>
          <button class="btn btn-sm" data-io="dup" title="Duplicate">⧉</button>
          <button class="btn btn-sm" data-io="del" title="Delete">🗑</button>
        </span>
      </div>
      <label class="field">Parent
        <select id="insp-parent" class="input">
          <option value="">— Scene root —</option>
          ${s.doc.objects.filter((x) => x.id !== o.id).map((x) => `<option value="${x.id}"${x.id === o.parentId ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}
        </select>
      </label>
      <div class="panel-sub">Transform</div>
      ${numRow('Position', [o.position.x, o.position.y, o.position.z], 0.1, () => undefined)}
      ${numRow('Rotation°', [d(o.rotation.x), d(o.rotation.y), d(o.rotation.z)], 1, () => undefined)}
      ${numRow('Scale', [o.scale.x, o.scale.y, o.scale.z], 0.05, () => undefined)}
      ${o.type === 'light' ? lightSection(o.light ?? null) : materialSection(o)}
      ${o.type === 'imported' ? `<p class="small muted">Imported mesh${o.assetId ? '' : ' — asset bytes missing'}</p>` : ''}`;

    function lightSection(l: LightData | null): string {
      if (!l) return '';
      const isSpot = l.kind === 'spot';
      const isAtten = l.kind === 'point' || isSpot;
      const maxI = l.kind === 'directional' || l.kind === 'ambient' || l.kind === 'hemisphere' ? 5 : 60;
      return `
      <div class="panel-sub">Light</div>
      <label class="field">Type
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
      <p class="small muted">Tip: rotate spot / directional lights to aim them.</p>`;
    }

    function materialSection(obj: SceneObjectData): string {
      return `
      <div class="panel-sub">Material</div>
      <div class="row-between">
        <select id="insp-mat" class="input">
          <option value="">— None —</option>
          ${s.doc.materials.map((m) => `<option value="${m.id}"${m.id === obj.materialId ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-io="newmat" title="New material">＋</button>
      </div>
      ${mat ? `
      <div class="seg" style="margin-top:8px">
        <button class="btn btn-sm" data-preset="matte" title="Rough, non-metal">Matte</button>
        <button class="btn btn-sm" data-preset="metal" title="Full metal">Metal</button>
        <button class="btn btn-sm" data-preset="glass" title="Transparent glossy">Glass</button>
        <button class="btn btn-sm" data-preset="neon" title="Emissive glow">Neon</button>
      </div>
      <div class="mat-grid">
        <label>Color <input type="color" data-mat="baseColor" value="${mat.baseColor}" /></label>
        <label>Emissive <input type="color" data-mat="emissive" value="${mat.emissive}" /></label>
        <label>Metal <input type="range" min="0" max="1" step="0.01" data-mat="metalness" value="${mat.metalness}" /></label>
        <label>Rough <input type="range" min="0" max="1" step="0.01" data-mat="roughness" value="${mat.roughness}" /></label>
        <label>Opacity <input type="range" min="0" max="1" step="0.01" data-mat="opacity" value="${mat.opacity}" /></label>
        <label>Glow <input type="range" min="0" max="3" step="0.05" data-mat="emissiveIntensity" value="${mat.emissiveIntensity}" /></label>
      </div>
      <div class="row-between" style="margin-top:8px">
        <label class="small"><input type="checkbox" data-mat="flatShading" ${mat.flatShading ? 'checked' : ''} /> Flat shading</label>
        <label class="small"><input type="checkbox" data-mat="doubleSide" ${mat.side === 'double' ? 'checked' : ''} /> Double-sided</label>
      </div>
      <div class="panel-sub">Texture (base color)</div>
      <div class="row-between">
        ${mat.mapAssetId && s.textureThumb(mat.mapAssetId) ? `<img class="tex-thumb" src="${s.textureThumb(mat.mapAssetId)}" alt="Texture preview" />` : '<span class="muted small">No texture</span>'}
        <span>
          <button class="btn btn-sm" data-io="texup">Upload</button>
          ${mat.mapAssetId ? '<button class="btn btn-sm" data-io="texrm">Remove</button>' : ''}
        </span>
      </div>` : '<p class="muted small">No material assigned.</p>'}`;
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
