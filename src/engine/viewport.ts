import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRenderer, detectCaps, type GpuCaps } from './renderer.js';
import { makePrimitiveGeometry, disposeGeometry } from './geometry.js';
import { MaterialManager } from './materials.js';
import type { CameraType, MaterialData, SceneObjectData, ShadingMode } from '../state/models.js';

export interface ViewportEvents {
  onSelect: (id: string | null) => void;
  onFrame: (dt: number) => void;
}

export class Viewport {
  readonly caps: GpuCaps;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly materials = new MaterialManager();
  readonly objects = new Map<string, THREE.Object3D>();

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
  private downPos: { x: number; y: number; t: number } | null = null;
  private disposed = false;

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

    // Input: tap-to-select (mouse click or touch tap)
    this.canvas.addEventListener('pointerdown', (e) => {
      this.downPos = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.downPos) return;
      const dx = e.clientX - this.downPos.x;
      const dy = e.clientY - this.downPos.y;
      const dt = performance.now() - this.downPos.t;
      this.downPos = null;
      if (Math.hypot(dx, dy) < 8 && dt < 400) this.pick(e.clientX, e.clientY);
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
    this.cameraType = t;
    const to = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    to.position.copy(from.position);
    this.controls.dispose();
    this.controls = this.makeControls(to);
    this.controls.target.set(0, 0, 0);
    this.resize();
  }

  setShading(mode: ShadingMode): void {
    this.shading = mode;
    this.materials.setWireframe(mode === 'wireframe');
    this.materials.setEnvIntensity(mode === 'material' ? 1 : 0.35);
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
        if ('envMapIntensity' in std) std.envMapIntensity = mode === 'material' ? 1 : 0.35;
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
    this.setShading(this.shading);
  }

  private buildMesh(data: SceneObjectData): THREE.Object3D {
    if (data.type === 'group') return new THREE.Group();
    if (data.type === 'light') {
      const l = new THREE.PointLight(0xffffff, 8, 20);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffdd88 }),
      );
      l.add(marker);
      return l;
    }
    if (data.type === 'imported') return new THREE.Group(); // content attached async
    const geo = makePrimitiveGeometry(data.primitive?.kind ?? 'cube', data.primitive?.params ?? {});
    const mat = this.materials.getById(data.materialId) ?? new THREE.MeshStandardMaterial({ color: 0x8b9bb4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !this.caps.lowPower;
    mesh.receiveShadow = true;
    return mesh;
  }

  addObject(data: SceneObjectData): THREE.Object3D {
    this.removeObject(data.id);
    const obj = this.buildMesh(data);
    obj.name = data.name;
    obj.userData.objectId = data.id;
    this.applyTransform(obj, data);
    obj.visible = data.visible;
    this.objects.set(data.id, obj);
    this.reparent(data);
    return obj;
  }

  /** Attach parsed GLB content under an `imported` placeholder. */
  attachImported(id: string, content: THREE.Object3D): void {
    const holder = this.objects.get(id);
    if (!holder) return;
    holder.clear();
    holder.add(content);
    content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = !this.caps.lowPower;
        mesh.receiveShadow = true;
      }
    });
    this.setShading(this.shading);
  }

  updateObject(data: SceneObjectData): void {
    const obj = this.objects.get(data.id);
    if (!obj) {
      this.addObject(data);
      return;
    }
    obj.name = data.name;
    this.applyTransform(obj, data);
    obj.visible = data.visible;
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && data.type !== 'imported' && data.type !== 'group' && data.type !== 'light') {
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
    const obj = this.objects.get(data.id);
    if (!obj) return;
    const parent = data.parentId ? this.objects.get(data.parentId) : this.scene;
    if (parent && obj.parent !== parent) {
      // preserve world transform
      parent.updateWorldMatrix(true, false);
      const m = new THREE.Matrix4().copy(obj.matrixWorld);
      parent.add(obj);
      const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      m.premultiply(inv);
      m.decompose(obj.position, obj.quaternion, obj.scale);
      obj.rotation.setFromQuaternion(obj.quaternion);
    } else if (!parent) {
      this.scene.add(obj);
    }
  }

  removeObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.parent?.remove(obj);
    disposeGeometry(obj);
    this.objects.delete(id);
  }

  clearAll(): void {
    for (const id of [...this.objects.keys()]) this.removeObject(id);
  }

  focus(id: string | null): void {
    const target = new THREE.Vector3();
    if (id) {
      const obj = this.objects.get(id);
      if (!obj) return;
      new THREE.Box3().setFromObject(obj).getCenter(target);
    }
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const dir = new THREE.Vector3().subVectors(cam.position, this.controls.target).normalize();
    const dist = id ? 4 : 8;
    cam.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private pick(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots = [...this.objects.values()].filter((o) => this.isVisible(o));
    const hits = this.raycaster.intersectObjects(roots, true);
    if (!hits.length) {
      this.events.onSelect(null);
      return;
    }
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !o.userData.objectId) o = o.parent;
    this.events.onSelect(o ? (o.userData.objectId as string) : null);
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
    this.objects.forEach((obj, key) => {
      const on = key === id;
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          const std = m as THREE.MeshStandardMaterial;
          if (!('emissive' in std)) return;
          if (!std.userData.baseEmissive) {
            std.userData.baseEmissive = std.emissive.getHex();
            std.userData.baseEmissiveIntensity = std.emissiveIntensity;
          }
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
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    this.controls.update();
    this.events.onFrame(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
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
