import * as THREE from 'three';

export interface FirstPersonOptions {
  /** Called when the user presses Escape or Q to leave the mode. */
  onExit?: () => void;
  /** metres per second */
  speed?: number;
  /** Eye height above the ground plane (0 disables ground clamping). */
  eyeHeight?: number;
  gravity?: number;
}

/**
 * Minimal first-person fly/walk camera used by the viewport (edit-time "walk
 * through your scene") and by Play Mode's player controller.
 *
 * Desktop: WASD/arrows, pointer-lock mouse look, Shift to sprint, Space/E up.
 * Touch: driven externally through `setMoveVector` (the on-screen joystick).
 */
export class FirstPersonControls {
  enabled = false;
  /** Yaw/pitch in radians. */
  yaw = 0;
  pitch = 0;
  speed: number;
  eyeHeight: number;
  gravity: number;
  velocity = new THREE.Vector3();
  /** Set by the touch joystick: x = strafe, y = forward. */
  moveVector = new THREE.Vector2();
  jump = false;

  private keys = new Set<string>();
  private onExit?: () => void;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private disposed = false;
  private el: HTMLElement;
  private sensitivity = 0.0025;

  constructor(
    private camera: THREE.Camera,
    dom: HTMLElement,
    opts: FirstPersonOptions = {},
  ) {
    this.el = dom;
    this.speed = opts.speed ?? 4;
    this.eyeHeight = opts.eyeHeight ?? 0;
    this.gravity = opts.gravity ?? 0;
    this.onExit = opts.onExit;
    this.yaw = Math.atan2(
      -(camera.position.x - 0),
      -(camera.position.z - 0),
    );
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    this.keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'Escape' || e.code === 'KeyQ') {
      this.onExit?.();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.el.setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragging = false;
    this.el.releasePointerCapture?.(e.pointerId);
  };

  /** Drag the camera up/down/left/right from touch (two-finger pan etc). */
  lookBy(dx: number, dy: number): void {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.el.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.keys.clear();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.keys.clear();
    this.moveVector.set(0, 0);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  dispose(): void {
    this.disposed = true;
    this.disable();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Advance the camera. `collide` optionally resolves against the scene. */
  update(dt: number, collider?: (from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3): void {
    if (!this.enabled || this.disposed) return;
    const forward = this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : this.keys.has('KeyS') || this.keys.has('ArrowDown') ? -1 : 0;
    const strafe = this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? -1 : 0;
    const up = this.keys.has('Space') || this.keys.has('KeyE') ? 1 : this.keys.has('KeyC') || this.keys.has('ShiftLeft') === false && this.keys.has('ControlLeft') ? -1 : 0;
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 2.2 : 1;

    const fx = forward + this.moveVector.y;
    const sx = strafe + this.moveVector.x;

    const dir = new THREE.Vector3();
    dir.x = -Math.sin(this.yaw) * fx + Math.cos(this.yaw) * sx;
    dir.z = -Math.cos(this.yaw) * fx - Math.sin(this.yaw) * sx;
    dir.y = up;
    if (dir.lengthSq() > 0) dir.normalize();

    const speed = this.speed * boost;
    const target = new THREE.Vector3(dir.x * speed, dir.y * speed, dir.z * speed);

    if (this.gravity) {
      target.y = this.velocity.y - this.gravity * dt;
      if (this.jump && Math.abs(this.velocity.y) < 0.01) target.y = 4.2;
    }
    this.jump = false;

    const step = new THREE.Vector3(target.x * dt, target.y * dt, target.z * dt);
    const from = this.camera.position.clone();
    const to = from.clone().add(step);

    let resolved = to;
    if (collider) resolved = collider(from, to);

    if (this.gravity) {
      this.velocity.y = resolved.y === to.y ? Math.min(0, target.y) : 0;
      if (this.eyeHeight) resolved.y = Math.max(this.eyeHeight, resolved.y);
    }

    this.camera.position.copy(resolved);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    (this.camera as THREE.Object3D).rotation.y = this.yaw;
    (this.camera as THREE.Object3D).rotation.x = this.pitch;
    this.camera.updateMatrixWorld();
  }
}
