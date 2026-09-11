import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { collectSubtree } from '../state/tree.js';
import { uid, nowIso } from '../lib/utils.js';
import { localDb } from '../lib/indexeddb.js';
import { mirrorMatrix, type GizmoSpace } from '../engine/transform.js';
import type { PivotMode } from './transform-rig.js';
import type { SceneObjectData, SnapSettings, Vec3 } from '../state/models.js';

/**
 * Transform commands: gizmo space/snapping, duplicate, mirror, apply/reset
 * transforms, pivot editing, alignment, copy/paste transform.
 */
export interface TransformOps {
  duplicateSelection(this: EditorSession, offset?: Vec3): SceneObjectData[];
  mirrorSelection(this: EditorSession, axis: 'x' | 'y' | 'z'): void;
  applyTransforms(this: EditorSession, mode?: 'all' | 'rotationScale'): void;
  resetTransform(this: EditorSession, part?: 'all' | 'position' | 'rotation' | 'scale'): void;
  setPivotPreset(this: EditorSession, preset: 'center' | 'base' | 'top' | 'origin'): void;
  clearPivot(this: EditorSession): void;
  nudgeSelection(this: EditorSession, delta: Vec3): void;
  snapSelectionToGrid(this: EditorSession): void;
  dropToGround(this: EditorSession): void;
  alignSelection(this: EditorSession, axis: 'x' | 'y' | 'z', mode: 'min' | 'center' | 'max'): void;
  setGizmoSpace(this: EditorSession, space: GizmoSpace): void;
  setPivotMode(this: EditorSession, mode: PivotMode): void;
  setTransformTarget(this: EditorSession, target: 'object' | 'pivot'): void;
  setSnapSettings(this: EditorSession, patch: Partial<SnapSettings>): void;
  frameSelection(this: EditorSession): void;
  copyTransform(this: EditorSession): void;
  pasteTransform(this: EditorSession): void;
  hasTransformClipboard(this: EditorSession): boolean;
}

export interface TransformClipboard {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
let xfer: TransformClipboard | null = null;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function uniqueName(objects: SceneObjectData[], base: string): string {
  const taken = new Set(objects.map((o) => o.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 999; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${uid().slice(0, 4)}`;
}

/** Selected objects whose parent is not itself selected. */
function selectionRoots(session: EditorSession): string[] {
  const ids = new Set(session.selection.ids());
  const byId = new Map(session.doc.objects.map((o) => [o.id, o]));
  return [...ids].filter((id) => {
    let p = byId.get(id)?.parentId ?? null;
    let hops = 0;
    while (p && hops++ < 64) {
      if (ids.has(p)) return false;
      p = byId.get(p)?.parentId ?? null;
    }
    return true;
  });
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

function localMatrixOf(o: SceneObjectData): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(o.position.x, o.position.y, o.position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rotation.x, o.rotation.y, o.rotation.z, 'XYZ')),
    new THREE.Vector3(o.scale.x, o.scale.y, o.scale.z),
  );
}

function writeMatrix(session: EditorSession, id: string, m: THREE.Matrix4): void {
  m.decompose(_p, _q, _s);
  _e.setFromQuaternion(_q, 'XYZ');
  session.writeLocalTransform(id, {
    position: { x: _p.x, y: _p.y, z: _p.z },
    rotation: { x: _e.x, y: _e.y, z: _e.z },
    scale: { x: _s.x, y: _s.y, z: _s.z },
  });
}

/** Bounding box of an object in its own local space (geometry space). */
function localBounds(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  obj.updateWorldMatrix(true, true);
  const inv = obj.matrixWorld.clone().invert();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    if (!b) return;
    const world = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    box.union(b.clone().applyMatrix4(world));
  });
  return box;
}

export function worldBoxOf(session: EditorSession, id: string): THREE.Box3 | null {
  const obj = session.viewport.objects.get(id);
  if (!obj) return null;
  const box = new THREE.Box3().setFromObject(obj);
  return box.isEmpty() ? null : box;
}

/** Copy a subtree, returning the old→new id map. */
function duplicateSubtree(session: EditorSession, rootId: string, offset?: Vec3): Map<string, string> {
  const src = session.doc.objects.find((o) => o.id === rootId);
  if (!src) return new Map();
  const subtree = collectSubtree(session.doc.objects, rootId);
  const idMap = new Map<string, string>();
  for (const node of subtree) idMap.set(node.id, uid());
  for (const node of subtree) {
    const copy = JSON.parse(JSON.stringify(node)) as SceneObjectData;
    copy.id = idMap.get(node.id) as string;
    copy.name = node.id === src.id ? uniqueName(session.doc.objects, `${src.name} copy`) : node.name;
    if (node.id === src.id && offset) {
      copy.position = {
        x: src.position.x + offset.x,
        y: src.position.y + offset.y,
        z: src.position.z + offset.z,
      };
    }
    copy.parentId = node.parentId && idMap.has(node.parentId) ? (idMap.get(node.parentId) as string) : node.parentId;
    copy.version = 1;
    copy.updatedAt = nowIso();
    session.doc.objects.push(copy);
    session.viewport.addObject(copy);
    if (copy.type === 'imported' && copy.assetId) void session.attachAsset(copy);
    session.sync.broadcastOp('add', copy);
  }
  return idMap;
}

export const transformOps: TransformOps = {
  duplicateSelection(offset = { x: 0.5, y: 0, z: 0 }): SceneObjectData[] {
    const roots = selectionRoots(this);
    if (!roots.length) return [];
    this.history.checkpoint(this.doc, 'Duplicate');
    const created: SceneObjectData[] = [];
    for (const id of roots) {
      const map = duplicateSubtree(this, id, offset);
      const newRoot = map.get(id);
      const data = newRoot ? this.doc.objects.find((o) => o.id === newRoot) : null;
      if (data) created.push(data);
    }
    if (created.length) this.selectIds(created.map((o) => o.id));
    this.markDirty('add');
    this.rig.sync();
    return created;
  },

  mirrorSelection(axis): void {
    const roots = selectionRoots(this);
    if (!roots.length) return;
    this.history.checkpoint(this.doc, 'Mirror');
    const box = new THREE.Box3();
    for (const id of roots) {
      const b = worldBoxOf(this, id);
      if (b) box.union(b);
    }
    const center = box.isEmpty() ? this.rig.frameOrigin() : box.getCenter(new THREE.Vector3());
    const mirror = mirrorMatrix(axis, center);
    const created: string[] = [];
    for (const id of roots) {
      const map = duplicateSubtree(this, id);
      for (const [, newId] of map) {
        const obj = this.viewport.objects.get(newId);
        if (!obj) continue;
        obj.updateWorldMatrix(true, false);
        const parentInv = obj.parent ? obj.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
        const local = new THREE.Matrix4()
          .multiplyMatrices(parentInv, new THREE.Matrix4().multiplyMatrices(mirror, obj.matrixWorld.clone()));
        writeMatrix(this, newId, local);
      }
      const root = map.get(id);
      if (root) created.push(root);
    }
    if (created.length) this.selectIds(created);
    this.markDirty('add');
    this.rig.sync();
    this.notice('info', `Mirrored on ${axis.toUpperCase()} — use Apply transforms to bake the flip`);
  },

  applyTransforms(mode = 'all'): void {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Apply transforms');
    const byId = new Map(this.doc.objects.map((o) => [o.id, o]));
    let n = 0;
    for (const id of ids) {
      const data = byId.get(id);
      if (!data || !this.canEditObject(id)) continue;
      const local = localMatrixOf(data);
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(data.rotation.x, data.rotation.y, data.rotation.z, 'XYZ'));
      const scl = new THREE.Vector3(data.scale.x, data.scale.y, data.scale.z);
      const M = mode === 'all'
        ? local.clone()
        : new THREE.Matrix4().compose(new THREE.Vector3(), quat, scl);
      if (M.determinant() === 0) continue;

      // 1. bake M into the geometry (data.baked), keeping the pose unchanged
      const baked = new THREE.Matrix4().fromArray(
        data.baked && data.baked.length === 16 ? data.baked : IDENTITY,
      );
      data.baked = Array.from(new THREE.Matrix4().multiplyMatrices(M, baked).elements);

      // 2. the object's own transform loses M
      const newLocal = new THREE.Matrix4().multiplyMatrices(local, M.clone().invert());
      newLocal.decompose(_p, _q, _s);
      _e.setFromQuaternion(_q, 'XYZ');
      data.position = { x: _p.x, y: _p.y, z: _p.z };
      data.rotation = { x: _e.x, y: _e.y, z: _e.z };
      data.scale = { x: _s.x, y: _s.y, z: _s.z };
      data.updatedAt = nowIso();
      data.version++;
      // 3. children keep their world pose: childLocal' = M * childLocal
      for (const child of this.doc.objects.filter((o) => o.parentId === id)) {
        const childLocal = localMatrixOf(child);
        writeMatrix(this, child.id, new THREE.Matrix4().multiplyMatrices(M, childLocal));
      }

      // geometry changed → rebuild the viewport object from data
      this.viewport.removeObject(id);
      this.viewport.addObject(data);
      this.sync.broadcastOp('update', data);
      n++;
    }
    if (n) {
      this.markDirty('apply transform');
      this.rig.sync();
      this.notice('info', `Applied ${mode === 'all' ? 'all transforms' : 'rotation & scale'} to ${n} object${n === 1 ? '' : 's'}`);
    }
  },

  resetTransform(part = 'all'): void {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, `Reset ${part}`);
    for (const id of ids) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o || !this.canEditObject(id)) continue;
      if (part === 'all' || part === 'position') o.position = { x: 0, y: 0, z: 0 };
      if (part === 'all' || part === 'rotation') o.rotation = { x: 0, y: 0, z: 0 };
      if (part === 'all' || part === 'scale') o.scale = { x: 1, y: 1, z: 1 };
      o.version++;
      o.updatedAt = nowIso();
      this.viewport.updateObject(o);
      this.sync.broadcastOp('update', o);
    }
    this.markDirty('reset transform');
    this.rig.sync();
  },

  setPivotPreset(preset): void {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Set pivot');
    for (const id of ids) {
      const o = this.doc.objects.find((x) => x.id === id);
      const obj = this.viewport.objects.get(id);
      if (!o || !obj) continue;
      let pivot: Vec3 = { x: 0, y: 0, z: 0 };
      if (preset !== 'origin') {
        const box = localBounds(obj);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          if (preset === 'center') pivot = { x: center.x, y: center.y, z: center.z };
          else if (preset === 'base') pivot = { x: center.x, y: box.min.y, z: center.z };
          else pivot = { x: center.x, y: box.max.y, z: center.z };
        }
      }
      this.setPivot(id, pivot);
    }
    this.markDirty('pivot');
    this.rig.sync();
  },

  clearPivot(): void {
    this.setPivotPreset('origin');
  },

  nudgeSelection(delta): void {
    if (!this.selection.count()) return;
    this.history.checkpoint(this.doc, 'Nudge', 900);
    this.translateWorld(new THREE.Vector3(delta.x, delta.y, delta.z));
    this.markDirty('transform');
    this.rig.sync();
  },

  snapSelectionToGrid(): void {
    const cfg = this.snapSettings.get();
    const step = cfg.grid > 0 ? cfg.grid : 0.25;
    const origin = this.rig.frameOrigin();
    const target = new THREE.Vector3(
      Math.round(origin.x / step) * step,
      Math.round(origin.y / step) * step,
      Math.round(origin.z / step) * step,
    );
    const delta = target.sub(origin);
    if (delta.lengthSq() < 1e-9) return;
    this.history.checkpoint(this.doc, 'Snap to grid');
    this.translateWorld(delta);
    this.markDirty('transform');
    this.rig.sync();
  },

  dropToGround(): void {
    const roots = selectionRoots(this);
    if (!roots.length) return;
    this.history.checkpoint(this.doc, 'Drop to ground');
    for (const id of roots) {
      const box = worldBoxOf(this, id);
      if (!box) continue;
      this.translateWorld(new THREE.Vector3(0, -box.min.y, 0), [id]);
    }
    this.markDirty('transform');
    this.rig.sync();
  },

  alignSelection(axis, mode): void {
    const roots = selectionRoots(this);
    if (roots.length < 2) return;
    const boxes = roots.map((id) => ({ id, box: worldBoxOf(this, id) })).filter((x) => x.box);
    if (boxes.length < 2) return;
    const values = boxes.map(({ box }) => {
      const b = box as THREE.Box3;
      return mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2;
    });
    const target = mode === 'min' ? Math.min(...values) : mode === 'max' ? Math.max(...values) : values.reduce((a, b) => a + b, 0) / values.length;
    this.history.checkpoint(this.doc, 'Align');
    boxes.forEach(({ id, box }, i) => {
      const b = box as THREE.Box3;
      const own = mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2;
      const delta = target - own;
      if (Math.abs(delta) < 1e-6) return;
      const v = new THREE.Vector3();
      v[axis] = delta;
      this.translateWorld(v, [id]);
      void i;
    });
    this.markDirty('transform');
    this.rig.sync();
  },

  setGizmoSpace(space): void {
    this.gizmoSpace.set(space);
    void localDb.setSetting('gizmo.space', space);
  },

  setPivotMode(mode): void {
    this.pivotMode.set(mode);
    void localDb.setSetting('gizmo.pivot', mode);
  },

  setTransformTarget(target): void {
    this.transformTarget.set(target);
    this.notice('info', target === 'pivot' ? 'Editing pivot — drag the gizmo to move the origin' : 'Editing objects');
  },

  setSnapSettings(patch): void {
    const next = { ...this.snapSettings.get(), ...patch };
    this.snapSettings.set(next);
    void localDb.setSetting('gizmo.snapcfg', JSON.stringify(next));
  },

  frameSelection(): void {
    const ids = this.selection.ids();
    this.viewport.focusIds(ids.length ? ids : null);
  },

  copyTransform(): void {
    const o = this.selectedObject();
    if (!o) return;
    xfer = {
      position: { ...o.position },
      rotation: { ...o.rotation },
      scale: { ...o.scale },
    };
    this.notice('info', 'Transform copied');
  },

  pasteTransform(): void {
    if (!xfer) {
      this.notice('warn', 'Copy a transform first');
      return;
    }
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Paste transform');
    for (const id of ids) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o || !this.canEditObject(id)) continue;
      o.position = { ...xfer.position };
      o.rotation = { ...xfer.rotation };
      o.scale = { ...xfer.scale };
      o.version++;
      o.updatedAt = nowIso();
      this.viewport.updateObject(o);
      this.sync.broadcastOp('update', o);
    }
    this.markDirty('transform');
    this.rig.sync();
  },

  hasTransformClipboard(): boolean {
    return !!xfer;
  },
};
