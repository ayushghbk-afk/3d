import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { TransformGizmo, worldDeltaToLocal, worldMatrixOf, type GizmoSpace } from '../engine/transform.js';
import type { Vec3 } from '../state/models.js';

export type PivotMode = 'origin' | 'median' | 'bounds';

interface Target {
  id: string;
  startWorld: THREE.Matrix4;
  parentInv: THREE.Matrix4;
}

const v = new THREE.Vector3();

/**
 * Connects the selection to the transform gizmo.
 *
 * The gizmo drives a single proxy object; on every change we compute the
 * world-space delta since drag start and re-apply it to each selected object
 * through its parent. That makes these all behave correctly:
 *   • multi-select (objects keep their relative layout)
 *   • parented objects (delta is applied in world space, stored as local)
 *   • pivot/origin offsets (the proxy sits at the pivot, so rotate/scale
 *     happen around it)
 */
export class TransformRig {
  readonly gizmo: TransformGizmo;
  private proxy = new THREE.Object3D();
  private targets: Target[] = [];
  private frame0 = new THREE.Matrix4();
  private frame0Inv = new THREE.Matrix4();
  private dragging = false;
  private pivotEditing = false;

  space: GizmoSpace = 'world';
  pivotMode: PivotMode = 'origin';

  constructor(private session: EditorSession) {
    const vp = session.viewport;
    this.proxy.visible = false; // manipulation frame only — never rendered
    this.proxy.name = '__gizmo_frame';
    vp.scene.add(this.proxy);
    this.gizmo = new TransformGizmo(vp.scene, vp.camera, vp.renderer.domElement);
    this.gizmo.setHandlers({
      onDraggingChanged: (d) => this.handleDragging(d),
      onObjectChange: () => this.handleChange(),
    });
  }

  get isPivotEditing(): boolean {
    return this.pivotEditing;
  }

  setPivotEditing(on: boolean): void {
    this.pivotEditing = on;
    this.sync();
  }

  setSpace(space: GizmoSpace): void {
    this.space = space;
    this.gizmo.setSpace(space);
    if (!this.gizmo.isDragging) this.sync();
  }

  setPivotMode(mode: PivotMode): void {
    this.pivotMode = mode;
    if (!this.gizmo.isDragging) this.sync();
  }

  /** Objects the gizmo should move: selected, unlocked, and not inside another selected object. */
  private selectionTargets(): string[] {
    const ids = this.session.selection.ids();
    if (!ids.length) return [];
    const set = new Set(ids);
    const byId = new Map(this.session.doc.objects.map((o) => [o.id, o]));
    return ids.filter((id) => {
      const o = byId.get(id);
      if (!o || o.locked || !this.session.canEditObject(id)) return false;
      // skip children of a selected ancestor: moving the ancestor moves them
      let p = o.parentId;
      let hops = 0;
      while (p && hops++ < 64) {
        if (set.has(p)) return false;
        p = byId.get(p)?.parentId ?? null;
      }
      return true;
    });
  }

  /**
   * Rebuild the manipulation frame and re-attach the gizmo.
   * Safe to call on any state change; no-ops while a drag is in progress.
   */
  sync(): void {
    if (this.gizmo.isDragging) return;
    const session = this.session;
    const ids = this.selectionTargets();
    if (!ids.length || !session.canEdit.get() || session.playback.playing) {
      this.targets = [];
      this.gizmo.attach(null);
      return;
    }

    const vp = session.viewport;
    const frame = this.computeFrame(ids);
    frame.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrix();

    this.targets = [];
    for (const id of ids) {
      const obj = vp.objects.get(id);
      if (!obj) continue;
      this.targets.push({
        id,
        startWorld: worldMatrixOf(obj),
        parentInv: obj.parent ? worldMatrixOf(obj.parent).invert() : new THREE.Matrix4(),
      });
    }
    this.frame0.copy(frame);
    this.frame0Inv.copy(frame).invert();
    this.gizmo.attach(this.proxy);
  }

  /** World matrix of the gizmo frame for the current selection. */
  private computeFrame(ids: string[]): THREE.Matrix4 {
    const vp = this.session.viewport;
    const objs = ids.map((id) => vp.objects.get(id)).filter((o): o is THREE.Object3D => !!o);
    const first = objs[0];
    if (!first) return new THREE.Matrix4();

    const single = objs.length === 1 ? this.session.doc.objects.find((o) => o.id === ids[0]) : null;
    if (single && !this.pivotEditing) {
      const world = worldMatrixOf(first);
      const pivot = single.pivot ?? { x: 0, y: 0, z: 0 };
      if (pivot.x || pivot.y || pivot.z) {
        v.set(pivot.x, pivot.y, pivot.z).applyMatrix4(world);
        if (this.space === 'world' || this.pivotMode === 'bounds') {
          // keep world-aligned orientation, only move the origin
          const q = new THREE.Quaternion();
          const s = new THREE.Vector3();
          world.decompose(new THREE.Vector3(), q, s);
          const out = new THREE.Matrix4();
          if (this.space === 'world') out.compose(v, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
          else out.compose(v, q, new THREE.Vector3(1, 1, 1));
          return out;
        }
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        const p = new THREE.Vector3();
        world.decompose(p, q, s);
        return new THREE.Matrix4().compose(v, q, new THREE.Vector3(1, 1, 1));
      }
      if (this.space === 'world') {
        const p = new THREE.Vector3();
        world.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
        return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
      }
      return world;
    }

    // multi-selection (or pivot editing): median point / bounding-box centre
    const box = new THREE.Box3();
    const centers: THREE.Vector3[] = [];
    for (const o of objs) {
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) continue;
      box.union(b);
      centers.push(b.getCenter(new THREE.Vector3()));
    }
    const center = new THREE.Vector3();
    if (this.pivotMode === 'median' && centers.length) {
      const xs = centers.map((c) => c.x).sort((a, b) => a - b);
      const ys = centers.map((c) => c.y).sort((a, b) => a - b);
      const zs = centers.map((c) => c.z).sort((a, b) => a - b);
      const mid = Math.floor(centers.length / 2);
      center.set(xs[mid] ?? 0, ys[mid] ?? 0, zs[mid] ?? 0);
    } else if (!box.isEmpty()) {
      box.getCenter(center);
    } else {
      const o = objs[0];
      o.updateWorldMatrix(true, false);
      center.setFromMatrixPosition(o.matrixWorld);
    }
    let quat = new THREE.Quaternion();
    if (this.space === 'local') {
      const primaryId = this.session.selection.get();
      const primary = (primaryId ? this.session.viewport.objects.get(primaryId) : null) ?? first;
      worldMatrixOf(primary).decompose(new THREE.Vector3(), quat, new THREE.Vector3());
    }
    return new THREE.Matrix4().compose(center.clone(), quat, new THREE.Vector3(1, 1, 1));
  }

  private handleDragging(dragging: boolean): void {
    const session = this.session;
    session.viewport.controls.enabled = !dragging;
    if (dragging) {
      this.dragging = true;
      if (!this.pivotEditing) session.history.checkpoint(session.doc, 'Transform');
      else session.history.checkpoint(session.doc, 'Edit pivot');
      // capture the exact start state (the proxy may have moved since sync)
      this.frame0.copy(this.proxy.matrix);
      this.frame0Inv.copy(this.frame0).invert();
      for (const t of this.targets) {
        const obj = session.viewport.objects.get(t.id);
        if (!obj) continue;
        t.startWorld = worldMatrixOf(obj);
        t.parentInv = obj.parent ? worldMatrixOf(obj.parent).invert() : new THREE.Matrix4();
      }
      session.beginTransformBroadcast();
    } else {
      this.dragging = false;
      if (this.pivotEditing) this.commitPivot();
      session.endTransformBroadcast();
      session.markDirty('transform');
      if (!this.pivotEditing) {
        session.autokeyFromGizmo();
        session.dropToSurface();
      }
      // re-sync so the frame matches the committed data
      this.sync();
    }
  }

  private handleChange(): void {
    if (!this.dragging) return;
    const session = this.session;
    this.proxy.updateMatrix();
    const delta = new THREE.Matrix4().multiplyMatrices(this.proxy.matrix, this.frame0Inv);
    for (const t of this.targets) {
      const local = worldDeltaToLocal(t.startWorld, delta, t.parentInv);
      session.writeLocalTransform(t.id, local);
    }
  }

  /** Pivot editing: convert the dragged frame origin into each object's local pivot. */
  private commitPivot(): void {
    const session = this.session;
    this.proxy.updateMatrix();
    const origin = new THREE.Vector3().setFromMatrixPosition(this.proxy.matrix);
    for (const t of this.targets) {
      const world = t.startWorld;
      const local = origin.clone().applyMatrix4(world.clone().invert());
      const pivot: Vec3 = { x: local.x, y: local.y, z: local.z };
      session.setPivot(t.id, pivot);
      // changing the pivot must not move the geometry: the data transform is
      // re-based so the object stays exactly where it is.
      const obj = session.viewport.objects.get(t.id);
      if (obj) {
        const data = session.doc.objects.find((o) => o.id === t.id);
        if (data) session.writeLocalTransform(t.id, { position: data.position, rotation: data.rotation, scale: data.scale });
      }
    }
  }

  /** Current frame origin, in world space (used by pivot presets and focus). */
  frameOrigin(): THREE.Vector3 {
    this.proxy.updateMatrix();
    return new THREE.Vector3().setFromMatrixPosition(this.proxy.matrix);
  }

  dispose(): void {
    this.gizmo.attach(null);
    this.gizmo.dispose();
    this.proxy.parent?.remove(this.proxy);
  }
}
