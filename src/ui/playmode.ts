import * as THREE from 'three';
import type { EditorSession } from '../editor/session.js';
import type { SceneObjectData } from '../state/models.js';
import { FirstPersonControls } from '../engine/fps-controls.js';

/**
 * Play Mode — turns the editor into a tiny game engine.
 *
 * • First-person camera with gravity and collision (WASD / touch joystick)
 * • Simple physics for objects marked as dynamic bodies in the inspector
 * • Trigger volumes report entry, `play` scripts run on start
 * • Esc (or the HUD button) returns to the editor with the scene intact
 *
 * Everything is intentionally small: a few hundred lines, no physics engine
 * dependency, and it never mutates the saved document.
 */

interface Body {
  id: string;
  dynamic: boolean;
  shape: 'box' | 'sphere' | 'plane';
  trigger: boolean;
  mass: number;
  restitution: number;
  radius: number;
  half: THREE.Vector3;
  velocity: THREE.Vector3;
  center: THREE.Vector3;
}

export class PlayMode {
  private hud: HTMLDivElement | null = null;
  private controls: FirstPersonControls | null = null;
  private bodies: Body[] = [];
  private startTransforms = new Map<string, { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>();
  private entered = new Set<string>();
  private joystick: { active: boolean; x: number; y: number; id: number | null } = { active: false, x: 0, y: 0, id: null };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private keys = new Set<string>();
  private raf = 0;
  private lastT = 0;
  private elapsed = 0;
  private tmpBox = new THREE.Box3();

  constructor(
    private session: EditorSession,
    private onExit: () => void,
  ) {}

  get active(): boolean {
    return !!this.hud;
  }

  async enter(): Promise<void> {
    if (this.hud) return;
    const s = this.session;
    s.playMode.set(true);
    s.select(null);
    s.rig.gizmo.attach(null);

    // remember transforms so exiting restores the authored scene
    this.startTransforms.clear();
    for (const o of s.doc.objects) {
      const obj = s.viewport.objects.get(o.id);
      if (!obj) continue;
      this.startTransforms.set(o.id, {
        position: obj.position.clone(),
        rotation: obj.rotation.clone(),
        scale: obj.scale.clone(),
      });
    }

    this.bodies = this.collectBodies();
    this.entered.clear();
    this.buildHud();
    document.body.classList.add('play-mode');

    const cam = s.viewport.camera;
    if (cam.position.y < 1.2) cam.position.y = 1.6;
    const opts = { speed: 4.5, eyeHeight: 1.6, gravity: 18, onExit: () => this.exit() };
    s.viewport.setFirstPerson(true, opts);
    this.controls = s.viewport.getFirstPerson();
    s.viewport.physicsCollider = (from, to) => this.resolveCamera(from, to);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.tick);

    await s.scriptEngine.runTrigger('play');
    this.session.logActivity('system', 'entered Play Mode');
  }

  exit(): void {
    if (!this.hud) return;
    const s = this.session;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.hud?.remove();
    this.hud = null;
    s.viewport.physicsCollider = null;
    s.viewport.setFirstPerson(false);
    this.controls = null;
    document.body.classList.remove('play-mode');

    // restore authored transforms
    for (const [id, t] of this.startTransforms) {
      const data = s.doc.objects.find((o) => o.id === id);
      const obj = s.viewport.objects.get(id);
      if (!data || !obj) continue;
      obj.position.copy(t.position);
      obj.rotation.copy(t.rotation);
      obj.scale.copy(t.scale);
      data.position = { x: t.position.x, y: t.position.y, z: t.position.z };
      data.rotation = { x: t.rotation.x, y: t.rotation.y, z: t.rotation.z };
      data.scale = { x: t.scale.x, y: t.scale.y, z: t.scale.z };
    }
    this.startTransforms.clear();
    s.playMode.set(false);
    s.rig.sync();
    this.onExit();
  }

  private collectBodies(): Body[] {
    const out: Body[] = [];
    for (const data of this.session.doc.objects) {
      if (!data.physics?.enabled) continue;
      const obj = this.session.viewport.objects.get(data.id);
      if (!obj) continue;
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) continue;
      const size = box.getSize(new THREE.Vector3());
      out.push({
        id: data.id,
        dynamic: !!data.physics.dynamic,
        shape: data.physics.shape,
        trigger: !!data.physics.trigger,
        mass: Math.max(0.1, data.physics.mass),
        restitution: data.physics.restitution,
        radius: Math.max(size.x, size.z) / 2,
        half: size.multiplyScalar(0.5),
        velocity: new THREE.Vector3(),
        center: box.getCenter(new THREE.Vector3()),
      });
    }
    return out;
  }

  private buildHud(): void {
    const hud = document.createElement('div');
    hud.className = 'play-hud';
    hud.innerHTML = `
      <div class="play-top">
        <span class="play-badge">▶ Play Mode</span>
        <span class="muted small" id="play-time">0.0s</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="play-exit">■ Exit (Esc)</button>
      </div>
      <div class="play-hint muted small">WASD move · Space jump · Shift sprint · drag to look</div>
      <div class="play-stick" id="play-stick" aria-label="Move"><span class="play-stick-knob"></span></div>
      <button class="play-jump" id="play-jump">↑</button>
      <div class="play-toast" id="play-toast"></div>`;
    document.body.appendChild(hud);
    this.hud = hud;

    (hud.querySelector('#play-exit') as HTMLButtonElement).onclick = () => this.exit();

    // touch: left-half joystick, right-half look drag, jump button
    const stick = hud.querySelector('#play-stick') as HTMLDivElement;
    stick.addEventListener('pointerdown', (e) => {
      this.joystick.active = true;
      this.joystick.id = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      this.updateStick(e, stick);
    });
    stick.addEventListener('pointermove', (e) => {
      if (this.joystick.active && this.joystick.id === e.pointerId) this.updateStick(e, stick);
    });
    const endStick = (e: PointerEvent): void => {
      if (this.joystick.id !== e.pointerId) return;
      this.joystick.active = false;
      this.joystick.x = 0;
      this.joystick.y = 0;
      this.joystick.id = null;
      const knob = stick.querySelector('.play-stick-knob') as HTMLElement;
      knob.style.transform = 'translate(0px, 0px)';
      this.controls ? (this.controls.moveVector.set(0, 0)) : undefined;
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    const jump = hud.querySelector('#play-jump') as HTMLButtonElement;
    jump.addEventListener('pointerdown', () => {
      if (this.controls) this.controls.jump = true;
    });

    const canvas = this.session.viewport.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onLookDown);
    canvas.addEventListener('pointermove', this.onLookMove);
    canvas.addEventListener('pointerup', this.onLookUp);
  }

  private onLookDown = (e: PointerEvent): void => {
    if (e.clientX < window.innerWidth * 0.35) return; // joystick side
    this.lookId = e.pointerId;
    this.lookLast = { x: e.clientX, y: e.clientY };
  };
  private onLookMove = (e: PointerEvent): void => {
    if (this.lookId !== e.pointerId || !this.controls) return;
    this.controls.lookBy(e.clientX - this.lookLast.x, e.clientY - this.lookLast.y);
    this.lookLast = { x: e.clientX, y: e.clientY };
  };
  private onLookUp = (e: PointerEvent): void => {
    if (this.lookId === e.pointerId) this.lookId = null;
  };

  private updateStick(e: PointerEvent, stick: HTMLElement): void {
    const rect = stick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / (rect.width / 2)));
    const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / (rect.height / 2)));
    this.joystick.x = dx;
    this.joystick.y = -dy;
    const knob = stick.querySelector('.play-stick-knob') as HTMLElement;
    knob.style.transform = `translate(${dx * 26}px, ${-dy * 26}px)`;
    if (this.controls) this.controls.moveVector.set(dx, this.joystick.y);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    if (e.code === 'Escape') {
      e.preventDefault();
      this.exit();
    }
    if (e.code === 'Space' && this.controls) this.controls.jump = true;
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** Stop the camera from walking through static bodies (axis-separated so
   *  sliding along a wall keeps working). */
  private resolveCamera(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    const radius = 0.35;
    const cursor = from.clone();
    for (const axis of ['y', 'x', 'z'] as const) {
      const test = cursor.clone();
      test[axis] = to[axis];
      if (!this.hitsStatic(test, radius)) cursor[axis] = to[axis];
    }
    if (cursor.y < 0.2) cursor.y = 0.2;
    return cursor;
  }

  private hitsStatic(p: THREE.Vector3, radius: number): boolean {
    for (const b of this.bodies) {
      if (b.trigger) continue;
      const obj = this.session.viewport.objects.get(b.id);
      if (!obj) continue;
      this.tmpBox.setFromObject(obj);
      if (this.tmpBox.isEmpty()) continue;
      if (b.shape === 'plane') {
        if (p.y < this.tmpBox.max.y + 0.02) return true;
        continue;
      }
      const closest = new THREE.Vector3(
        Math.max(this.tmpBox.min.x, Math.min(p.x, this.tmpBox.max.x)),
        Math.max(this.tmpBox.min.y, Math.min(p.y, this.tmpBox.max.y)),
        Math.max(this.tmpBox.min.z, Math.min(p.z, this.tmpBox.max.z)),
      );
      if (closest.distanceTo(p) < radius) return true;
    }
    return false;
  }

  private tick = (t: number): void => {
    if (!this.hud) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    this.elapsed += dt;

    // keep the touch joystick feeding the controller
    if (this.controls && this.joystick.active) {
      this.controls.moveVector.set(this.joystick.x, this.joystick.y);
    }

    this.stepBodies(dt);
    this.checkTriggers();

    const timeEl = this.hud.querySelector('#play-time') as HTMLElement | null;
    if (timeEl) timeEl.textContent = `${this.elapsed.toFixed(1)}s`;
  };

  /** Very small physics step: gravity, ground/wall response, damping. */
  private stepBodies(dt: number): void {
    const gravity = this.session.doc.settings.gravity ?? 18;
    for (const b of this.bodies) {
      if (!b.dynamic || b.trigger) continue;
      const obj = this.session.viewport.objects.get(b.id);
      const data = this.session.doc.objects.find((o) => o.id === b.id);
      if (!obj || !data) continue;
      obj.updateWorldMatrix(true, false);
      const world = obj.matrixWorld.clone();
      const start = new THREE.Vector3().setFromMatrixPosition(world);

      b.velocity.y -= gravity * dt;
      const next = start.clone().addScaledVector(b.velocity, dt);

      // ground: the highest static surface beneath, else y = 0
      let floor = 0;
      for (const other of this.bodies) {
        if (other.id === b.id || other.trigger) continue;
        const otherObj = this.session.viewport.objects.get(other.id);
        if (!otherObj) continue;
        this.tmpBox.setFromObject(otherObj);
        if (this.tmpBox.isEmpty()) continue;
        if (start.x > this.tmpBox.min.x && start.x < this.tmpBox.max.x && start.z > this.tmpBox.min.z && start.z < this.tmpBox.max.z) {
          if (this.tmpBox.max.y <= start.y + 0.4) floor = Math.max(floor, this.tmpBox.max.y + b.half.y);
        }
      }
      if (next.y < floor) {
        next.y = floor;
        b.velocity.y = Math.abs(b.velocity.y) > 0.6 ? -b.velocity.y * b.restitution : 0;
        b.velocity.x *= 0.86;
        b.velocity.z *= 0.86;
      }

      // apply the world-space delta to the local transform
      const delta = next.clone().sub(start);
      obj.position.add(delta);
      data.position = { x: obj.position.x, y: obj.position.y, z: obj.position.z };
    }
  }

  private checkTriggers(): void {
    const cam = this.session.viewport.camera.position;
    for (const b of this.bodies) {
      if (!b.trigger) continue;
      const obj = this.session.viewport.objects.get(b.id);
      if (!obj) continue;
      this.tmpBox.setFromObject(obj);
      if (this.tmpBox.isEmpty()) continue;
      const inside = cam.x > this.tmpBox.min.x && cam.x < this.tmpBox.max.x
        && cam.y > this.tmpBox.min.y && cam.y < this.tmpBox.max.y
        && cam.z > this.tmpBox.min.z && cam.z < this.tmpBox.max.z;
      const data = this.session.doc.objects.find((o) => o.id === b.id);
      if (inside && !this.entered.has(b.id)) {
        this.entered.add(b.id);
        this.flash(`Trigger: ${data?.name ?? 'volume'}`);
        void this.session.scriptEngine.runTrigger('play');
      } else if (!inside && this.entered.has(b.id)) {
        this.entered.delete(b.id);
      }
    }
  }

  private flash(msg: string): void {
    const el = this.hud?.querySelector('#play-toast') as HTMLElement | null;
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1600);
  }
}

export function isTouch(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

export type { SceneObjectData };
