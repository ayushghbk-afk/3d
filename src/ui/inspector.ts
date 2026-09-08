import type { EditorSession } from '../editor/session.js';
import * as THREE from 'three';
import { escapeHtml } from '../lib/utils.js';
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
        <div class="field"><span class="field-label">Scene</span>
          <p class="small">${s.doc.objects.length} objects · ${s.doc.materials.length} materials · ${s.doc.clips.length} clips</p>
        </div>`;
      el.querySelectorAll('[data-sh]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => s.shadingMode.set((b as HTMLElement).dataset.sh as 'solid' | 'material' | 'wireframe');
      });
      el.querySelectorAll('[data-cam]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => s.cameraType.set((b as HTMLElement).dataset.cam as 'perspective' | 'orthographic');
      });
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
      <div class="panel-sub">Material</div>
      <div class="row-between">
        <select id="insp-mat" class="input">
          <option value="">— None —</option>
          ${s.doc.materials.map((m) => `<option value="${m.id}"${m.id === o.materialId ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-io="newmat" title="New material">＋</button>
      </div>
      ${mat ? `
      <div class="mat-grid">
        <label>Color <input type="color" data-mat="baseColor" value="${mat.baseColor}" /></label>
        <label>Emissive <input type="color" data-mat="emissive" value="${mat.emissive}" /></label>
        <label>Metal <input type="range" min="0" max="1" step="0.01" data-mat="metalness" value="${mat.metalness}" /></label>
        <label>Rough <input type="range" min="0" max="1" step="0.01" data-mat="roughness" value="${mat.roughness}" /></label>
        <label>Opacity <input type="range" min="0" max="1" step="0.01" data-mat="opacity" value="${mat.opacity}" /></label>
      </div>` : '<p class="muted small">No material assigned.</p>'}
      ${o.type === 'imported' ? `<p class="small muted">Imported mesh${o.assetId ? '' : ' — asset bytes missing'}</p>` : ''}`;

    (el.querySelector('#insp-name') as HTMLInputElement).onchange = (e) => {
      s.renameObject(o.id, (e.target as HTMLInputElement).value.trim());
    };
    (el.querySelector('#insp-parent') as HTMLSelectElement).onchange = (e) => {
      s.setParent(o.id, (e.target as HTMLSelectElement).value || null);
    };
    (el.querySelector('#insp-mat') as HTMLSelectElement).onchange = (e) => {
      s.assignMaterial(o.id, (e.target as HTMLSelectElement).value || null);
    };
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
    };
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
        (inp as HTMLInputElement).oninput = (e) => {
          const k = (e.target as HTMLInputElement).dataset.mat as string;
          const raw = (e.target as HTMLInputElement).value;
          const v = k === 'baseColor' || k === 'emissive' ? raw : parseFloat(raw);
          s.updateMaterial(mat.id, { [k]: v } as Partial<typeof mat>);
        };
        (inp as HTMLInputElement).onchange = () => s.history.checkpoint(s.doc, 'Edit material', 1500);
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
