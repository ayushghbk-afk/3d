import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { SnapSettings, TransformMode, Vec3 } from '../state/models.js';
import { isTouchDevice } from '../lib/utils.js';

export type GizmoSpace = 'local' | 'world';

export interface GizmoDelta {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface GizmoHandlers {
  /** Fired on drag start / end. */
  onDraggingChanged?: (dragging: boolean) => void;
  /** Fired continuously while the proxy object is manipulated. */
  onObjectChange?: (pose: GizmoDelta) => void;
}

/**
 * Thin wrapper around `TransformControls`.
 *
 * The gizmo never manipulates scene objects directly: it always drives a
 * *proxy* `Object3D` owned by `TransformRig`, which converts the change into
 * per-object data transforms. That keeps multi-select, pivot offsets and
 * parented objects correct, and lets the same code path power the Agent API.
 */
export class TransformGizmo {
  readonly controls: TransformControls;
  private helper: THREE.Object3D;
  private mode: TransformMode = 'translate';
  private space: GizmoSpace = 'world';
  private snapCfg: SnapSettings = { enabled: false, grid: 0.25, angle: 15, scale: 0.1, toObjects: false };
  private handlers: GizmoHandlers = {};
  private dragging = false;

  constructor(
    private scene: THREE.Scene,
    camera: THREE.Camera,
    dom: HTMLElement,
  ) {
    this.controls = new TransformControls(camera, dom);
    // three >= r178 extracts the helper; support both APIs
    const maybe = this.controls as unknown as { getHelper?: () => THREE.Object3D };
    this.helper = typeof maybe.getHelper === 'function' ? maybe.getHelper() : (this.controls as unknown as THREE.Object3D);
    this.helper.visible = false;
    this.scene.add(this.helper);
    this.controls.setSize(isTouchDevice() ? 1.3 : 0.9);
    this.controls.addEventListener('dragging-changed', (e) => {
      this.dragging = Boolean((e as unknown as { value: boolean }).value);
      this.handlers.onDraggingChanged?.(this.dragging);
    });
    this.controls.addEventListener('objectChange', () => {
      const o = this.controls.object;
      if (!o) return;
      this.handlers.onObjectChange?.({
        position: { x: o.position.x, y: o.position.y, z: o.position.z },
        rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
        scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
      });
    });
  }

  setHandlers(h: GizmoHandlers): void {
    this.handlers = h;
  }

  setCamera(camera: THREE.Camera): void {
    (this.controls as unknown as { camera: THREE.Camera }).camera = camera;
  }

  attach(o: THREE.Object3D | null): void {
    if (!o) {
      this.controls.detach();
      this.helper.visible = false;
      return;
    }
    this.controls.attach(o);
    this.helper.visible = true;
    this.applyMode();
  }

  get attached(): THREE.Object3D | undefined {
    return this.controls.object as unknown as THREE.Object3D | undefined;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  setMode(mode: TransformMode): void {
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    this.controls.setMode(this.mode);
    this.controls.setSpace(this.space);
    this.applySnap();
  }

  /** `local` rotates around the object's own axes, `world` around world axes. */
  setSpace(space: GizmoSpace): void {
    this.space = space;
    this.controls.setSpace(space);
  }

  getSpace(): GizmoSpace {
    return this.space;
  }

  setSnap(cfg: SnapSettings): void {
    this.snapCfg = { ...cfg };
    this.applySnap();
  }

  private applySnap(): void {
    const on = this.snapCfg.enabled;
    this.controls.setTranslationSnap(on && this.snapCfg.grid > 0 ? this.snapCfg.grid : null);
    this.controls.setRotationSnap(on && this.snapCfg.angle > 0 ? THREE.MathUtils.degToRad(this.snapCfg.angle) : null);
    this.controls.setScaleSnap(on && this.snapCfg.scale > 0 ? this.snapCfg.scale : null);
  }

  setVisible(v: boolean): void {
    this.helper.visible = v && !!this.controls.object;
    this.controls.enabled = v;
  }

  setEnabled(v: boolean): void {
    this.controls.enabled = v;
    if (!v && this.controls.object) this.controls.detach();
  }

  dispose(): void {
    this.controls.detach();
    this.scene.remove(this.helper);
    this.controls.dispose();
  }
}

// ---------------------------------------------------------------------------
// Pure math helpers (exported for unit tests and reuse by the transform rig)
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

export interface LocalTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/**
 * Apply a world-space delta to an object that started at `startWorld`, then
 * convert the result back into the object's parent space.
 */
export function worldDeltaToLocal(
  startWorld: THREE.Matrix4,
  delta: THREE.Matrix4,
  parentWorldInverse: THREE.Matrix4,
): LocalTransform {
  _m.multiplyMatrices(delta, startWorld).premultiply(parentWorldInverse);
  _m.decompose(_pos, _quat, _scale);
  _euler.setFromQuaternion(_quat, 'XYZ');
  return {
    position: { x: _pos.x, y: _pos.y, z: _pos.z },
    rotation: { x: _euler.x, y: _euler.y, z: _euler.z },
    scale: { x: _scale.x, y: _scale.y, z: _scale.z },
  };
}

/** Snap a scalar to `step` (0 disables). */
export function snapValue(v: number, step: number): number {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}

/** Snap an angle (radians) to `stepDeg` (0 disables). */
export function snapAngle(rad: number, stepDeg: number): number {
  if (!stepDeg || stepDeg <= 0) return rad;
  const deg = THREE.MathUtils.radToDeg(rad);
  return THREE.MathUtils.degToRad(Math.round(deg / stepDeg) * stepDeg);
}

/** World matrix of `obj`, refreshed from its current local transform. */
export function worldMatrixOf(obj: THREE.Object3D): THREE.Matrix4 {
  obj.updateWorldMatrix(true, false);
  return obj.matrixWorld.clone();
}

/** Mirror matrix about a world plane through `center` with the given axis normal. */
export function mirrorMatrix(axis: 'x' | 'y' | 'z', center: THREE.Vector3): THREE.Matrix4 {
  const s = new THREE.Vector3(1, 1, 1);
  s[axis] = -1;
  const toOrigin = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  const back = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
  const flip = new THREE.Matrix4().makeScale(s.x, s.y, s.z);
  return new THREE.Matrix4().multiplyMatrices(back, new THREE.Matrix4().multiplyMatrices(flip, toOrigin));
}

/**
 * Bake a local matrix into an object's geometry and reset its transform,
 * keeping the object (and its children) visually in place.
 *
 * Returns the local transforms children must adopt so their world pose is
 * unchanged: `childLocal' = local * childLocal`.
 */
export function bakeChildren(local: THREE.Matrix4, childLocal: THREE.Matrix4): THREE.Matrix4 {
  return new THREE.Matrix4().multiplyMatrices(local, childLocal);
}
