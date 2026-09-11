import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EnvironmentManager } from './environments.js';
import { PostFx } from './postfx.js';
import { FirstPersonControls } from './fps-controls.js';
import type { EnvironmentPreset, FogSettings, PostFxSettings } from '../state/models.js';
import { createRenderer, detectCaps, type GpuCaps } from './renderer.js';
import { makePrimitiveGeometry, disposeGeometry } from './geometry.js';
import { MaterialManager } from './materials.js';
import type { CameraState, CameraType, MaterialData, SceneObjectData, ShadingMode } from '../state/models.js';

export interface PointerModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface ViewportEvents {
  onSelect: (id: string | null, mods?: PointerModifiers) => void;
  onFrame: (dt: number) => void;
  /** Touch long-press (mobile selection gesture). */
  onLongPress?: (clientX: number, clientY: number) => void;
  /** Double tap / double click (mobile focus gesture). */
  onDoubleTap?: (clientX: number, clientY: number) => void;
  /** Drag-rectangle selection, in client coordinates. */
  onBoxSelect?: (rect: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => void;
  /** Pointer moved over the viewport — used to broadcast live cursors. */
  onPointerMove?: (ndcX: number, ndcY: number) => void;
}

export const NO_MODS: PointerModifiers = { shift: false, ctrl: false, alt: false };

/**
 * Attach an object under its data parent. Data transforms are ALWAYS local
 * (`EditorSession.setParent` bakes world→local into data before calling), so
 * attaching keeps them verbatim.
 *
 * Never derive anything from `matrixWorld` here: a freshly loaded object's
 * matrix is still identity, and doing so resets every object to the origin
 * on project reopen. Exported pure for unit tests.
 */
export function attachToParent(
  objects: Map<string, THREE.Object3D>,
  scene: THREE.Object3D,
  data: { id: string; parentId: string | null },
): void {
  const obj = objects.get(data.id);
  if (!obj) return;
  // Missing parent (not loaded yet / deleted peer-side): park at root. The
  // load path re-runs this via fixParenting once every object exists.
  const parent = data.parentId ? (objects.get(data.parentId) ?? scene) : scene;
  if (obj.parent === parent) return;
  // Cycle defense: docs saved by older builds could contain parentId loops.
  // Attaching a node inside its own subtree would hang matrix traversal, so
  // skip the (re)parenting and leave the object where it is (root-parked).
  for (let a: THREE.Object3D | null = parent; a; a = a.parent) {
    if (a === obj) return;
  }
  parent.add(obj);
}

/**
 * Selection highlight: tints the selected object's materials blue, restoring
 * the previous emissive on (de)select. Exported pure for unit tests.
 *
 * The base snapshot MUST be guarded by `=== undefined`: the default emissive
 * is black (0x000000, falsy), and a falsy check re-snapshots the blue
 * highlight itself as the "base" — so deselecting never restores the color.
 */
export function applyOutline(objects: Map<string, THREE.Object3D>, id: string | null): void {
  objects.forEach((obj, key) => {
    const on = key === id;
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        const std = m as THREE.MeshStandardMaterial;
        if (!('emissive' in std)) return;
        if (std.userData.baseEmissive === undefined) {
          std.userData.baseEmissive = std.emissive.getHex();
          std.userData.baseEmissiveIntensity = std.emissiveIntensity;
        }
        std.userData.highlighted = on;
        // NOTE: shared materials — highlight affects all users; acceptable V1,
        // replaced by outline-pass in Phase 7.
        if (on) {
          std.emissive.setHex(0x2266ff);
          std.emissiveIntensity = Math.max(0.35, std.userData.baseEmissiveIntensity as number);
        } else {
          std.emissive.setHex(std.userData.baseEmissive as number);
          std.emissiveIntensity = std.userData.baseEmissiveIntensity as number;
        }
      });
    });
  });
}

/** Multi-selection highlight: tints every member of `ids`, restores the rest. */
export function applyOutlineSet(objects: Map<string, THREE.Object3D>, ids: ReadonlySet<string>): void {
  objects.forEach((obj, key) => {
    const on = ids.has(key);
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        const std = m as THREE.MeshStandardMaterial;
        if (!('emissive' in std)) return;
        if (std.userData.baseEmissive === undefined) {
          std.userData.baseEmissive = std.emissive.getHex();
          std.userData.baseEmissiveIntensity = std.emissiveIntensity;
        }
        std.userData.highlighted = on;
        if (on) {
          std.emissive.setHex(0x2266ff);
          std.emissiveIntensity = Math.max(0.35, std.userData.baseEmissiveIntensity as number);
        } else {
          std.emissive.setHex(std.userData.baseEmissive as number);
          std.emissiveIntensity = std.userData.baseEmissiveIntensity as number;
        }
      });
    });
  });
}

export class Viewport {
  readonly caps: GpuCaps;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly materials = new MaterialManager();
  readonly objects = new Map<string, THREE.Object3D>();
  /** Last data row applied per object (used by import baking and helpers). */
  private datas = new Map<string, SceneObjectData>();

  perspCam: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera;
  cameraType: CameraType = 'perspective';
  controls: OrbitControls;
  events: ViewportEvents = { onSelect: () => undefined, onFrame: () => undefined };

  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private dirLight: THREE.DirectionalLight;
  private clock = new THREE.Clock();
  private raf = 0;
  private resizeObs: ResizeObserver;
  private shading: ShadingMode = 'material';
  private baseEnv = 1;
  private downPos: { x: number; y: number; t: number } | null = null;
  private disposed = false;
  private envManager: EnvironmentManager | null = null;
  private postfx: PostFx | null = null;
  private fps: FirstPersonControls | null = null;
  private fogSettings: FogSettings | null = null;
  private envSettings: { preset: EnvironmentPreset; intensity: number; rotation: number; background: boolean } | null = null;
  /** Last known pointer position in client coordinates (snap/drop/targeting). */
  private pointerClient = { x: 0, y: 0 };
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTapAt = 0;
  private lastTapPos = { x: 0, y: 0 };
  private boxStart: { x: number; y: number } | null = null;
  private boxEl: HTMLDivElement | null = null;
  /** When true, a plain left drag draws a selection rectangle instead of orbiting. */
  private boxMode = false;
  private gridSize = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    this.caps = detectCaps();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-canvas';
    this.canvas.setAttribute('aria-label', '3D viewport');
    container.appendChild(this.canvas);
    this.renderer = createRenderer(this.canvas, this.caps);

    this.scene.background = new THREE.Color('#11141b');
    this.scene.fog = null;

    // Environment for PBR preview
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    pmrem.dispose();

    // Cameras
    const aspect = Math.max(0.5, container.clientWidth / Math.max(1, container.clientHeight));
    this.perspCam = new THREE.PerspectiveCamera(50, aspect, 0.05, 500);
    this.perspCam.position.set(4, 3, 6);
    this.orthoCam = new THREE.OrthographicCamera(-5 * aspect, 5 * aspect, 5, -5, 0.05, 500);
    this.orthoCam.position.set(4, 3, 6);
    this.orthoCam.zoom = 1;

    this.controls = this.makeControls(this.perspCam);

    // Lights
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1d24, 0.9);
    this.scene.add(hemi);
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.dirLight.position.set(5, 8, 4);
    this.dirLight.castShadow = !this.caps.lowPower;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.left = -8;
    this.dirLight.shadow.camera.right = 8;
    this.dirLight.shadow.camera.top = 8;
    this.dirLight.shadow.camera.bottom = -8;
    this.scene.add(this.dirLight);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-6, 3, -4);
    this.scene.add(fill);

    // Helpers
    this.grid = new THREE.GridHelper(20, 20, 0x3a4356, 0x232936);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1.2);
    this.scene.add(this.axes);

    // Input: tap-to-select, drag-to-box-select, long-press (touch), double-tap
    this.canvas.addEventListener('pointerdown', (e) => {
      this.pointerClient = { x: e.clientX, y: e.clientY };
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.downPos = { x: e.clientX, y: e.clientY, t: performance.now() };
      const wantBox = this.boxMode || e.ctrlKey || e.metaKey;
      if (wantBox && e.pointerType === 'mouse') {
        this.startBox(e.clientX, e.clientY, e.shiftKey);
        return;
      }
      // touch long-press = select (mobile editing gesture)
      if (e.pointerType !== 'mouse') {
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          this.downPos = null;
          this.events.onLongPress?.(e.clientX, e.clientY);
        }, 450);
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.pointerClient = { x: e.clientX, y: e.clientY };
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width && rect.height) {
        const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.events.onPointerMove?.(nx, ny);
      }
      if (this.boxStart) this.updateBox(e.clientX, e.clientY);
      if (this.downPos && Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 8) {
        if (this.longPressTimer) {
          clearTimeout(this.longPressTimer);
          this.longPressTimer = null;
        }
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      this.pointerClient = { x: e.clientX, y: e.clientY };
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
      if (this.boxStart) {
        this.endBox(e.clientX, e.clientY);
        this.downPos = null;
        return;
      }
      if (!this.downPos) return;
      const dx = e.clientX - this.downPos.x;
      const dy = e.clientY - this.downPos.y;
      const dt = performance.now() - this.downPos.t;
      this.downPos = null;
      if (Math.hypot(dx, dy) < 8 && dt < 400) {
        const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
        // double tap / double click focuses the hit object
        const now = performance.now();
        const isDouble = now - this.lastTapAt < 320 && Math.hypot(e.clientX - this.lastTapPos.x, e.clientY - this.lastTapPos.y) < 24;
        this.lastTapAt = now;
        this.lastTapPos = { x: e.clientX, y: e.clientY };
        if (isDouble) {
          this.events.onDoubleTap?.(e.clientX, e.clientY);
          this.pick(e.clientX, e.clientY, mods);
        } else {
          this.pick(e.clientX, e.clientY, mods);
        }
      }
    });
    this.canvas.addEventListener('pointercancel', () => {
      if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
      this.cancelBox();
      this.downPos = null;
    });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.loop();
  }

  get camera(): THREE.Camera {
    return this.cameraType === 'perspective' ? this.perspCam : this.orthoCam;
  }

  private makeControls(cam: THREE.Camera): OrbitControls {
    const c = new OrbitControls(cam, this.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.maxDistance = 100;
    c.minDistance = 0.1;
    return c;
  }

  setCameraType(t: CameraType): void {
    if (this.cameraType === t) return;
    // carry position/target across
    const from = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const target = this.controls.target.clone();
    this.cameraType = t;
    const to = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    to.position.copy(from.position);
    this.controls.dispose();
    this.controls = this.makeControls(to);
    this.controls.target.copy(target);
    this.controls.update();
    this.resize();
  }

  getCameraState(): CameraState {
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const t = this.controls.target;
    return {
      type: this.cameraType,
      position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      target: { x: t.x, y: t.y, z: t.z },
      fov: this.perspCam.fov,
    };
  }

  setCameraState(patch: Partial<CameraState>): CameraState {
    if (patch.type && patch.type !== this.cameraType) this.setCameraType(patch.type);
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (patch.position) {
      cam.position.set(
        patch.position.x ?? cam.position.x,
        patch.position.y ?? cam.position.y,
        patch.position.z ?? cam.position.z,
      );
    }
    if (patch.target) {
      this.controls.target.set(
        patch.target.x ?? this.controls.target.x,
        patch.target.y ?? this.controls.target.y,
        patch.target.z ?? this.controls.target.z,
      );
    }
    if (typeof patch.fov === 'number' && Number.isFinite(patch.fov)) {
      this.perspCam.fov = Math.max(10, Math.min(120, patch.fov));
      this.perspCam.updateProjectionMatrix();
    }
    this.controls.update();
    return this.getCameraState();
  }

  /** Spherical orbit around the current look-at target. polarDeg: 0 = top, 90 = horizon. */
  orbitCamera(azimuthDeg: number, polarDeg: number, distance?: number): CameraState {
    const t = this.controls.target;
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const az = (azimuthDeg * Math.PI) / 180;
    const pol = (Math.max(1, Math.min(179, polarDeg)) * Math.PI) / 180;
    const dist = distance ?? cam.position.distanceTo(t) ?? 8;
    cam.position.set(
      t.x + dist * Math.sin(pol) * Math.sin(az),
      t.y + dist * Math.cos(pol),
      t.z + dist * Math.sin(pol) * Math.cos(az),
    );
    this.controls.update();
    return this.getCameraState();
  }

  setShading(mode: ShadingMode, baseEnv = 1): void {
    this.shading = mode;
    this.baseEnv = baseEnv;
    const env = mode === 'material' ? baseEnv : baseEnv * 0.35;
    this.materials.setWireframe(mode === 'wireframe');
    this.materials.setEnvIntensity(env);
    // imported materials (not in manager): traverse unique set
    const seen = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        if (seen.has(m)) return;
        seen.add(m);
        const std = m as THREE.MeshStandardMaterial;
        if ('wireframe' in std) std.wireframe = mode === 'wireframe';
        if ('envMapIntensity' in std) std.envMapIntensity = env;
      });
    });
  }

  getShading(): ShadingMode {
    return this.shading;
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.axes.visible = v;
  }

  syncMaterials(all: MaterialData[]): void {
    this.materials.sync(all);
    this.setShading(this.shading, this.baseEnv);
  }

  private buildMesh(data: SceneObjectData): THREE.Object3D {
    if (data.type === 'group') return new THREE.Group();
    if (data.type === 'light') {
      return this.buildLight(data);
    }
    if (data.type === 'imported') return new THREE.Group(); // content attached async
    const geo = makePrimitiveGeometry(data.primitive?.kind ?? 'cube', data.primitive?.params ?? {});
    // Apply-transforms bakes a matrix into the geometry (see TransformOps.applyTransforms)
    if (data.baked && data.baked.length === 16) {
      geo.applyMatrix4(new THREE.Matrix4().fromArray(data.baked));
    }
    const mat = this.materials.getById(data.materialId) ?? new THREE.MeshStandardMaterial({ color: 0x8b9bb4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !this.caps.lowPower;
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildLight(data: SceneObjectData): THREE.Object3D {
    const l = data.light ?? { kind: 'point', color: '#ffffff', intensity: 10, distance: 20, angle: 0.6, penumbra: 0.4, castShadow: false } as const;
    const group = new THREE.Group();
    let light: THREE.Light;
    switch (l.kind) {
      case 'directional':
        light = new THREE.DirectionalLight(l.color, l.intensity);
        break;
      case 'spot':
        light = new THREE.SpotLight(l.color, l.intensity, l.distance || 0, l.angle, l.penumbra);
        break;
      case 'ambient':
        light = new THREE.AmbientLight(l.color, l.intensity);
        break;
      case 'hemisphere':
        light = new THREE.HemisphereLight(l.color, 0x1a1d24, l.intensity);
        break;
      case 'point':
      default:
        light = new THREE.PointLight(l.color, l.intensity, l.distance || 0);
        break;
    }
    // aimable lights point down local -Z so the rotate gizmo aims them
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      light.target.position.set(0, 0, -1);
      group.add(light.target);
      if (l.castShadow && !this.caps.lowPower) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
      }
    } else if (light instanceof THREE.PointLight && l.castShadow && !this.caps.lowPower) {
      light.castShadow = true;
      light.shadow.mapSize.set(512, 512);
    }
    group.add(light);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 8),
      new THREE.MeshBasicMaterial({ color: l.color }),
    );
    marker.name = '__marker';
    group.add(marker);
    return group;
  }

  /** Global shadow toggle (project setting). */
  setShadowsEnabled(v: boolean): void {
    const enabled = v && !this.caps.lowPower;
    this.renderer.shadowMap.enabled = enabled;
    this.dirLight.castShadow = enabled;
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mats = mesh.isMesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      mats.forEach((m) => {
        m.needsUpdate = true;
      });
    });
    this.materials.touchAll();
  }

  addObject(data: SceneObjectData): THREE.Object3D {
    this.removeObject(data.id);
    const obj = this.buildMesh(data);
    obj.name = data.name;
    obj.userData.objectId = data.id;
    this.applyTransform(obj, data);
    obj.visible = data.visible;
    this.objects.set(data.id, obj);
    this.datas.set(data.id, data);
    this.reparent(data);
    return obj;
  }

  /** Attach parsed GLB content under an `imported` placeholder. */
  attachImported(id: string, content: THREE.Object3D): void {
    const holder = this.objects.get(id);
    if (!holder) return;
    holder.clear();
    const data = this.datas.get(id);
    if (data?.baked && data.baked.length === 16) {
      // baked transforms (Apply transforms) wrap the imported content
      const wrapper = new THREE.Object3D();
      wrapper.matrixAutoUpdate = false;
      wrapper.matrix.fromArray(data.baked);
      wrapper.add(content);
      holder.add(wrapper);
    } else {
      holder.add(content);
    }
    content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = !this.caps.lowPower;
        mesh.receiveShadow = true;
      }
    });
    this.setShading(this.shading, this.baseEnv);
  }

  updateObject(data: SceneObjectData): void {
    const obj = this.objects.get(data.id);
    if (!obj) {
      this.addObject(data);
      return;
    }
    if (data.type === 'light') {
      // light class/params can't be patched in place — rebuild (addObject reparents)
      this.removeObject(data.id);
      this.addObject(data);
      return;
    }
    obj.name = data.name;
    this.applyTransform(obj, data);
    obj.visible = data.visible;
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && data.type !== 'imported' && data.type !== 'group') {
      const mat = this.materials.getById(data.materialId);
      if (mat && mesh.material !== mat) mesh.material = mat;
    }
    this.reparent(data);
  }

  private applyTransform(obj: THREE.Object3D, d: SceneObjectData): void {
    obj.position.set(d.position.x, d.position.y, d.position.z);
    obj.rotation.set(d.rotation.x, d.rotation.y, d.rotation.z);
    obj.scale.set(d.scale.x, d.scale.y, d.scale.z);
  }

  private reparent(data: SceneObjectData): void {
    attachToParent(this.objects, this.scene, data);
  }

  /**
   * Second pass after a bulk load: children whose parents arrived later in the
   * array were parked at the scene root — attach them now (locals intact).
   */
  fixParenting(all: SceneObjectData[]): void {
    for (const d of all) attachToParent(this.objects, this.scene, d);
  }

  removeObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.parent?.remove(obj);
    disposeGeometry(obj);
    this.objects.delete(id);
    this.datas.delete(id);
  }

  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.removeObject(id);
  }

  focus(id: string | null): void {
    this.focusIds(id ? [id] : null);
  }

  /** Frame the union of `ids` (or the whole scene when empty). */
  focusIds(ids: string[] | null): void {
    const target = new THREE.Vector3();
    let radius = 1;
    if (ids && ids.length) {
      const box = new THREE.Box3();
      let found = false;
      for (const id of ids) {
        const obj = this.objects.get(id);
        if (!obj) continue;
        const b = new THREE.Box3().setFromObject(obj);
        if (b.isEmpty()) continue;
        box.union(b);
        found = true;
      }
      if (!found) return;
      box.getCenter(target);
      radius = Math.max(0.35, box.getSize(new THREE.Vector3()).length() / 2);
    } else {
      radius = 4;
    }
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const dir = new THREE.Vector3().subVectors(cam.position, this.controls.target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1).normalize();
    // frame the bounds: distance from fov (or frustum height) + a little margin
    const fov = this.cameraType === 'perspective'
      ? THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov)
      : 0.6;
    const dist = Math.max(0.6, (radius / Math.max(0.15, Math.sin(fov / 2))) * 1.15);
    cam.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }

  // ---------- environment, fog, post-processing, camera ----------
  setEnvironment(preset: EnvironmentPreset, intensity: number, rotation: number, background: boolean): void {
    this.envSettings = { preset, intensity, rotation, background };
    if (!this.envManager) this.envManager = new EnvironmentManager(this.renderer);
    this.envManager.apply(this.scene, preset, intensity, rotation, background);
    this.setShading(this.shading, this.baseEnv);
  }

  setFog(cfg: FogSettings | null): void {
    this.fogSettings = cfg;
    if (!cfg || !cfg.enabled) {
      this.scene.fog = null;
      return;
    }
    this.scene.fog = new THREE.Fog(new THREE.Color(cfg.color), cfg.near, cfg.far);
  }

  setPostFx(cfg: PostFxSettings | null): void {
    const want = !!cfg && cfg.enabled;
    if (!want) {
      this.postfx?.dispose();
      this.postfx = null;
      return;
    }
    if (!this.postfx) {
      this.postfx = new PostFx(this.renderer, this.scene, this.camera, cfg as PostFxSettings);
      const { clientWidth: w, clientHeight: h } = this.container;
      this.postfx.setSize(Math.max(1, w), Math.max(1, h));
    } else {
      this.postfx.configure(cfg as PostFxSettings);
    }
  }

  getPostFx(): PostFx | null {
    return this.postfx;
  }

  /** Orbit to a named view (degrees). Distance is preserved. */
  setView(azimuthDeg: number, polarDeg: number): void {
    const t = this.controls.target;
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const dist = cam.position.distanceTo(t);
    this.orbitCamera(azimuthDeg, polarDeg, dist);
  }

  /** Walk/fly camera (edit-time preview + Play Mode). */
  setFirstPerson(on: boolean, opts: { speed?: number; eyeHeight?: number; gravity?: number; onExit?: () => void } = {}): void {
    if (on) {
      if (!this.fps) {
        this.fps = new FirstPersonControls(this.camera, this.canvas, opts);
      }
      this.fps.speed = opts.speed ?? this.fps.speed;
      this.fps.eyeHeight = opts.eyeHeight ?? this.fps.eyeHeight;
      this.fps.gravity = opts.gravity ?? this.fps.gravity;
      this.fps.enable();
      this.controls.enabled = false;
    } else {
      this.fps?.disable();
      this.controls.enabled = true;
      // sync orbit target to wherever the first-person camera ended up
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.controls.target.copy(this.camera.position).addScaledVector(dir, 5);
      this.controls.update();
    }
  }

  isFirstPerson(): boolean {
    return !!this.fps?.enabled;
  }

  getFirstPerson(): FirstPersonControls | null {
    return this.fps;
  }

  /** Render the scene at `width × height` and return a PNG data URL. */
  capturePng(width = 1920, height = 1080): string | null {
    const prevW = this.container.clientWidth;
    const prevH = this.container.clientHeight;
    const prevRatio = this.renderer.getPixelRatio();
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.perspCam.aspect = width / height;
      this.perspCam.updateProjectionMatrix();
      const half = 5;
      this.orthoCam.left = (-half * width) / height;
      this.orthoCam.right = (half * width) / height;
      this.orthoCam.updateProjectionMatrix();
      if (this.postfx) {
        this.postfx.setSize(width, height);
        this.postfx.render(0.016);
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      return this.renderer.domElement.toDataURL('image/png');
    } catch {
      return null;
    } finally {
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(Math.max(1, prevW), Math.max(1, prevH), false);
      this.resize();
    }
  }

  private pick(clientX: number, clientY: number, mods: PointerModifiers = NO_MODS): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots = [...this.objects.values()].filter((o) => this.isVisible(o));
    const hits = this.raycaster.intersectObjects(roots, true);
    if (!hits.length) {
      this.events.onSelect(null, mods);
      return;
    }
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !o.userData.objectId) o = o.parent;
    this.events.onSelect(o ? (o.userData.objectId as string) : null, mods);
  }

  /** Raycast from the last known pointer position (snap-to-surface, drops). */
  raycastPointer(excludeIds: readonly string[] = [], clientX?: number, clientY?: number): { point: THREE.Vector3; objectId: string | null; normal: THREE.Vector3 } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cx = clientX ?? this.pointerClient.x;
    const cy = clientY ?? this.pointerClient.y;
    this.pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const skip = new Set(excludeIds);
    const roots = [...this.objects.values()].filter((o) => this.isVisible(o) && !skip.has(o.userData.objectId as string));
    const hits = this.raycaster.intersectObjects(roots, true);
    if (!hits.length) return null;
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !o.userData.objectId) o = o.parent;
    return {
      point: hits[0].point.clone(),
      objectId: (o?.userData.objectId as string) ?? null,
      normal: (hits[0].face?.normal.clone().transformDirection(hits[0].object.matrixWorld) ?? new THREE.Vector3(0, 1, 0)),
    };
  }

  /** Raycast onto the ground plane (y = 0) — used for drag & drop placement. */
  groundPointAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  /** Screen-space (client) position of an object's centre, for overlay labels. */
  screenPositionOf(id: string): { x: number; y: number; behind: boolean } | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const rect = this.canvas.getBoundingClientRect();
    const p = center.clone().project(this.camera);
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
      behind: p.z > 1,
    };
  }

  // ---------- box selection ----------
  setBoxSelectMode(on: boolean): void {
    this.boxMode = on;
    this.controls.enabled = !on || this.controls.enabled;
    if (on) this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN } as unknown as typeof this.controls.mouseButtons;
    else this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  private startBox(x: number, y: number, additive: boolean): void {
    if (!this.boxEl) {
      this.boxEl = document.createElement('div');
      this.boxEl.className = 'vp-select-box';
      this.container.appendChild(this.boxEl);
    }
    this.boxEl.style.display = 'block';
    this.boxEl.dataset.additive = additive ? '1' : '0';
    this.boxStart = { x, y };
    this.updateBox(x, y);
  }

  private updateBox(x: number, y: number): void {
    if (!this.boxStart || !this.boxEl) return;
    const rect = this.container.getBoundingClientRect();
    const x0 = Math.min(this.boxStart.x, x) - rect.left;
    const y0 = Math.min(this.boxStart.y, y) - rect.top;
    const x1 = Math.max(this.boxStart.x, x) - rect.left;
    const y1 = Math.max(this.boxStart.y, y) - rect.top;
    this.boxEl.style.left = `${x0}px`;
    this.boxEl.style.top = `${y0}px`;
    this.boxEl.style.width = `${x1 - x0}px`;
    this.boxEl.style.height = `${y1 - y0}px`;
  }

  private endBox(x: number, y: number): void {
    const start = this.boxStart;
    const additive = this.boxEl?.dataset.additive === '1';
    this.cancelBox();
    if (!start) return;
    if (Math.hypot(x - start.x, y - start.y) < 6) return;
    this.events.onBoxSelect?.({ x0: start.x, y0: start.y, x1: x, y1: y }, additive);
  }

  private cancelBox(): void {
    this.boxStart = null;
    if (this.boxEl) this.boxEl.style.display = 'none';
  }

  /**
   * Ids whose projected bounds intersect a client-space rectangle.
   * Objects hidden by an invisible ancestor never match.
   */
  objectsInRect(rect: { x0: number; y0: number; x1: number; y1: number }, includePartial = true): string[] {
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return [];
    const minX = Math.min(rect.x0, rect.x1);
    const maxX = Math.max(rect.x0, rect.x1);
    const minY = Math.min(rect.y0, rect.y1);
    const maxY = Math.max(rect.y0, rect.y1);
    const out: string[] = [];
    const corner = new THREE.Vector3();
    for (const [id, obj] of this.objects) {
      if (!this.isVisible(obj)) continue;
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) continue;
      let inside = 0;
      for (let i = 0; i < 8; i++) {
        corner.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        );
        corner.project(this.camera);
        const sx = bounds.left + ((corner.x + 1) / 2) * bounds.width;
        const sy = bounds.top + ((1 - corner.y) / 2) * bounds.height;
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) inside++;
      }
      if (inside === 8 || (includePartial && inside > 0)) out.push(id);
    }
    return out;
  }

  /** Highlight every selected object (multi-select aware). */
  outlineSet(ids: readonly string[]): void {
    const set = new Set(ids);
    applyOutlineSet(this.objects, set);
  }

  setGridSize(size: number): void {
    const s = Math.max(0.01, size || 1);
    if (Math.abs(s - this.gridSize) < 1e-6) return;
    this.gridSize = s;
    const visible = this.grid.visible;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    const span = 20;
    this.grid = new THREE.GridHelper(span, Math.max(2, Math.round(span / s)), 0x3a4356, 0x232936);
    this.grid.visible = visible;
    this.scene.add(this.grid);
  }

  private isVisible(o: THREE.Object3D): boolean {
    let c: THREE.Object3D | null = o;
    while (c) {
      if (!c.visible) return false;
      c = c.parent;
    }
    return true;
  }

  outline(id: string | null): void {
    applyOutline(this.objects, id);
  }

  captureThumbnail(maxSize = 320): string | null {
    try {
      this.renderer.render(this.scene, this.camera);
      const src = this.renderer.domElement;
      const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(src.width * scale));
      c.height = Math.max(1, Math.floor(src.height * scale));
      c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    const half = 5;
    this.orthoCam.left = (-half * w) / h;
    this.orthoCam.right = (half * w) / h;
    this.orthoCam.top = half;
    this.orthoCam.bottom = -half;
    this.orthoCam.updateProjectionMatrix();
    this.postfx?.setSize(w, h);
  }

  /** Optional collision resolver used by the first-person / play-mode camera. */
  physicsCollider: ((from: THREE.Vector3, to: THREE.Vector3) => THREE.Vector3) | null = null;

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    if (this.fps?.enabled) this.fps.update(dt, this.physicsCollider ?? undefined);
    else this.controls.update();
    this.events.onFrame(dt);
    if (this.postfx) this.postfx.render(dt);
    else this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.boxEl?.remove();
    this.fps?.dispose();
    this.postfx?.dispose();
    this.envManager?.dispose();
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.clearAll();
    this.materials.dispose();
    this.scene.environment?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
