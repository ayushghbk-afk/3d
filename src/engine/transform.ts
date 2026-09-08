import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { TransformMode, Vec3 } from '../state/models.js';
import { isTouchDevice } from '../lib/utils.js';

export interface GizmoDelta {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export class TransformGizmo {
  readonly controls: TransformControls;
  onDraggingChanged: ((dragging: boolean) => void) | null = null;
  onObjectChange: ((delta: GizmoDelta) => void) | null = null;
  private helper: THREE.Object3D;

  constructor(
    private scene: THREE.Scene,
    camera: THREE.Camera,
    dom: HTMLElement,
  ) {
    this.controls = new TransformControls(camera, dom);
    // three >= r178 extracts the helper; support both APIs
    const maybe = this.controls as unknown as { getHelper?: () => THREE.Object3D };
    this.helper = typeof maybe.getHelper === 'function' ? maybe.getHelper() : (this.controls as unknown as THREE.Object3D);
    this.scene.add(this.helper);
    this.controls.setSize(isTouchDevice() ? 1.25 : 0.9);
    this.controls.addEventListener('dragging-changed', (e) => {
      this.onDraggingChanged?.((e as unknown as { value: boolean }).value);
    });
    this.controls.addEventListener('objectChange', () => {
      const o = this.controls.object;
      if (!o) return;
      this.onObjectChange?.({
        position: { x: o.position.x, y: o.position.y, z: o.position.z },
        rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
        scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
      });
    });
  }

  setCamera(camera: THREE.Camera): void {
    (this.controls as unknown as { camera: THREE.Camera }).camera = camera;
  }

  attach(o: THREE.Object3D | null): void {
    if (!o) {
      this.controls.detach();
      return;
    }
    this.controls.attach(o);
  }

  get attached(): THREE.Object3D | undefined {
    return this.controls.object as unknown as THREE.Object3D | undefined;
  }

  setMode(mode: TransformMode): void {
    this.controls.setMode(mode);
  }

  setSnap(enabled: boolean): void {
    this.controls.setTranslationSnap(enabled ? 0.1 : null);
    this.controls.setRotationSnap(enabled ? THREE.MathUtils.degToRad(15) : null);
    this.controls.setScaleSnap(enabled ? 0.1 : null);
  }

  dispose(): void {
    this.controls.detach();
    this.scene.remove(this.helper);
    this.controls.dispose();
  }
}
