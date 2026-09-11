import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { uid, nowIso } from '../lib/utils.js';
import { mergeObjects, subdivideGeometry, simplifyGeometry, geometryStats } from '../engine/modeling.js';
import { exportGlb } from '../engine/gltf.js';
import type {
  CameraBookmark, Collection, EnvironmentPreset, FogSettings, ObjectPhysics, PostFxSettings, SceneObjectData,
} from '../state/models.js';
import { defaultPhysics, defaultFog, defaultPostFx, defaultEnvironment, defaultMaterial } from '../state/models.js';

/**
 * Scene-level commands: viewport presentation (grid, environment, fog, post
 * processing), camera bookmarks, collections, physics bodies and the mesh
 * operations that don't need a full modelling toolset.
 */
export interface SceneOps {
  toggleGrid(this: EditorSession): void;
  persistCamera(this: EditorSession): void;
  addCameraBookmark(this: EditorSession, name?: string): CameraBookmark | null;
  gotoBookmark(this: EditorSession, id: string): void;
  removeBookmark(this: EditorSession, id: string): void;
  toggleFirstPerson(this: EditorSession): void;
  setEnvironment(this: EditorSession, patch: Partial<{ preset: EnvironmentPreset; intensity: number; rotation: number; background: boolean }>): void;
  setFog(this: EditorSession, patch: Partial<FogSettings>): void;
  setPostFx(this: EditorSession, patch: Partial<PostFxSettings>): void;
  createCollection(this: EditorSession, name?: string, color?: string): Collection;
  renameCollection(this: EditorSession, id: string, name: string): void;
  deleteCollection(this: EditorSession, id: string): void;
  assignToCollection(this: EditorSession, collectionId: string | null, ids?: string[]): void;
  setPhysics(this: EditorSession, patch: Partial<ObjectPhysics>, ids?: string[]): void;
  fillWithMaterial(this: EditorSession, materialId: string | null, ids?: string[]): void;
  mergeSelection(this: EditorSession): Promise<void>;
  subdivideSelection(this: EditorSession, iterations?: number): Promise<void>;
  simplifySelection(this: EditorSession, ratio?: number): Promise<void>;
  selectionStats(this: EditorSession): { tris: number; verts: number; objects: number };
  applySettingsFromDoc(this: EditorSession): void;
}

const COLLECTION_COLORS = ['#5b8cff', '#4ade80', '#f472b6', '#facc15', '#a78bfa', '#fb923c', '#2dd4bf'];

export const sceneOps: SceneOps = {
  toggleGrid(): void {
    const next = !this.gridVisible.get();
    this.gridVisible.set(next);
    this.viewport.setGridVisible(next);
  },

  persistCamera(): void {
    this.doc.settings.camera = this.viewport.getCameraState();
    this.markDirty('camera');
  },

  addCameraBookmark(name): CameraBookmark | null {
    const camera = this.viewport.getCameraState();
    const bookmark: CameraBookmark = {
      id: uid(),
      name: name?.trim() || `View ${this.doc.cameraBookmarks.length + 1}`,
      camera,
    };
    this.doc.cameraBookmarks = [...this.doc.cameraBookmarks, bookmark];
    this.markDirty('camera bookmark');
    this.logActivity('camera', `saved camera bookmark “${bookmark.name}”`);
    return bookmark;
  },

  gotoBookmark(id): void {
    const b = this.doc.cameraBookmarks.find((x) => x.id === id);
    if (!b) return;
    this.viewport.setCameraState(b.camera);
    this.cameraType.set(b.camera.type);
    this.persistCamera();
  },

  removeBookmark(id): void {
    this.doc.cameraBookmarks = this.doc.cameraBookmarks.filter((b) => b.id !== id);
    this.markDirty('camera bookmark');
  },

  toggleFirstPerson(): void {
    const on = !this.viewport.isFirstPerson();
    this.viewport.setFirstPerson(on, {
      speed: 4.5,
      onExit: () => {
        this.viewport.setFirstPerson(false);
        this.firstPerson.set(false);
        this.notice('info', 'Left first-person mode');
      },
    });
    this.firstPerson.set(on);
    this.notice('info', on ? 'First-person: WASD to move, drag to look, Esc to exit' : 'First-person off');
  },

  setEnvironment(patch): void {
    const cur = this.doc.settings.environment ?? defaultEnvironment();
    const next = { ...cur, ...patch };
    this.doc.settings.environment = next;
    this.viewport.setEnvironment(next.preset, next.intensity, next.rotation, next.background);
    this.markDirty('environment');
  },

  setFog(patch): void {
    const cur = this.doc.settings.fog ?? defaultFog();
    const next = { ...cur, ...patch };
    this.doc.settings.fog = next;
    this.viewport.setFog(next);
    this.markDirty('fog');
  },

  setPostFx(patch): void {
    const cur = this.doc.settings.postfx ?? defaultPostFx();
    const next = { ...cur, ...patch };
    this.doc.settings.postfx = next;
    this.viewport.setPostFx(next.enabled ? next : null);
    this.markDirty('postfx');
  },

  createCollection(name, color): Collection {
    const c: Collection = {
      id: uid(),
      name: name?.trim() || `Collection ${this.doc.collections.length + 1}`,
      color: color ?? COLLECTION_COLORS[this.doc.collections.length % COLLECTION_COLORS.length],
    };
    this.history.checkpoint(this.doc, 'New collection');
    this.doc.collections.push(c);
    this.markDirty('collection');
    return c;
  },

  renameCollection(id, name): void {
    const c = this.doc.collections.find((x) => x.id === id);
    if (!c || !name.trim()) return;
    c.name = name.trim().slice(0, 60);
    this.markDirty('collection');
  },

  deleteCollection(id): void {
    this.history.checkpoint(this.doc, 'Delete collection');
    this.doc.collections = this.doc.collections.filter((c) => c.id !== id);
    for (const o of this.doc.objects) {
      if (!o.collectionIds?.length) continue;
      o.collectionIds = o.collectionIds.filter((c) => c !== id);
    }
    this.markDirty('collection');
  },

  assignToCollection(collectionId, ids): void {
    const targets = ids?.length ? ids : this.selection.ids();
    if (!targets.length) return;
    this.history.checkpoint(this.doc, 'Assign collection');
    for (const id of targets) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o) continue;
      const list = new Set(o.collectionIds ?? []);
      if (collectionId) list.add(collectionId);
      o.collectionIds = [...list];
      o.version++;
    }
    this.markDirty('collection');
  },

  setPhysics(patch, ids): void {
    const targets = ids?.length ? ids : this.selection.ids();
    if (!targets.length) return;
    this.history.checkpoint(this.doc, 'Physics');
    for (const id of targets) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o) continue;
      o.physics = { ...(o.physics ?? defaultPhysics()), ...patch };
      o.version++;
    }
    this.markDirty('physics');
  },

  fillWithMaterial(materialId, ids): void {
    const targets = ids?.length ? ids : this.selection.ids();
    if (!targets.length) return;
    for (const id of targets) this.assignMaterial(id, materialId);
  },

  async mergeSelection(): Promise<void> {
    const ids = this.selection.ids();
    if (ids.length < 2) {
      this.notice('warn', 'Select two or more objects to merge');
      return;
    }
    const objects = ids.map((id) => this.viewport.objects.get(id)).filter((o): o is THREE.Object3D => !!o);
    if (objects.length < 2) return;
    this.history.checkpoint(this.doc, 'Merge');
    const bounds = new THREE.Box3();
    for (const o of objects) {
      const b = new THREE.Box3().setFromObject(o);
      if (!b.isEmpty()) bounds.union(b);
    }
    const origin = bounds.getCenter(new THREE.Vector3());
    const geo = mergeObjects(objects, origin);
    if (!geo) {
      this.notice('warn', 'Nothing to merge (no meshes found)');
      return;
    }
    const first = this.doc.objects.find((o) => o.id === ids[0]) as SceneObjectData | undefined;
    if (!first) return;
    const created = await freezeGeometry(this, first, geo, `Merged (${ids.length})`, origin);
    if (!created) {
      this.notice('warn', 'Merge failed');
      return;
    }
    for (const id of ids.slice(1)) this.deleteObject(id);
    this.select(created.id);
    this.markDirty('merge');
    this.notice('info', `Merged ${ids.length} objects into one`);
  },

  async subdivideSelection(iterations = 2): Promise<void> {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Subdivide');
    let n = 0;
    for (const id of ids) {
      const obj = this.viewport.objects.get(id);
      const data = this.doc.objects.find((o) => o.id === id);
      if (!obj || !data) continue;
      const geos: THREE.BufferGeometry[] = [];
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) geos.push(mesh.geometry);
      });
      if (!geos.length) continue;
      const sub = subdivideGeometry(geos[0], iterations);
      obj.updateWorldMatrix(true, true);
      const created = await freezeGeometry(this, data, sub, data.name);
      if (created) n++;
    }
    this.markDirty('subdivide');
    this.notice('info', n ? `Subdivided ${n} object${n === 1 ? '' : 's'}` : 'Nothing to subdivide');
  },

  async simplifySelection(ratio = 0.5): Promise<void> {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Simplify');
    let n = 0;
    for (const id of ids) {
      const obj = this.viewport.objects.get(id);
      const data = this.doc.objects.find((o) => o.id === id);
      if (!obj || !data) continue;
      let source: THREE.BufferGeometry | null = null;
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!source && mesh.isMesh && mesh.geometry) source = mesh.geometry;
      });
      if (!source) continue;
      const reduced = simplifyGeometry(source as THREE.BufferGeometry, ratio);
      const created = await freezeGeometry(this, data, reduced, data.name);
      if (created) n++;
    }
    this.markDirty('simplify');
    this.notice('info', n ? `Simplified ${n} object${n === 1 ? '' : 's'}` : 'Nothing to simplify');
  },

  selectionStats(): { tris: number; verts: number; objects: number } {
    let tris = 0;
    let verts = 0;
    for (const id of this.selection.ids()) {
      const obj = this.viewport.objects.get(id);
      if (!obj) continue;
      const s = geometryStats(obj);
      tris += s.tris;
      verts += s.verts;
    }
    return { tris, verts, objects: this.selection.count() };
  },

  applySettingsFromDoc(): void {
    const st = this.doc.settings;
    this.viewport.setFog(st.fog ?? null);
    this.viewport.setPostFx(st.postfx?.enabled ? st.postfx : null);
    const env = st.environment ?? defaultEnvironment();
    this.viewport.setEnvironment(env.preset, env.intensity, env.rotation, env.background);
    this.viewport.setGridVisible(this.gridVisible.get());
  },
};

/** Ensure a scene has at least one material (used after deleting the last one). */
export function ensureMaterial(session: EditorSession): string {
  if (!session.doc.materials.length) {
    const m = defaultMaterial('Default');
    session.doc.materials.push(m);
    return m.id;
  }
  return session.doc.materials[0].id;
}

/**
 * Persist a modified geometry by exporting it to a GLB asset and swapping the
 * object for an `imported` one at the same world transform.
 *
 * Without this, any mesh edit (merge/subdivide/simplify) would silently vanish
 * the next time the object is rebuilt from its primitive parameters — e.g.
 * after undo/redo, a remote update or a reload.
 */
export async function freezeGeometry(
  session: EditorSession,
  data: SceneObjectData,
  geo: THREE.BufferGeometry,
  name: string,
  /** Geometry is expressed in world space minus this offset. */
  origin = new THREE.Vector3(),
): Promise<SceneObjectData | null> {
  const obj = session.viewport.objects.get(data.id);
  if (!obj) return null;
  obj.updateWorldMatrix(true, false);
  const world = obj.matrixWorld.clone();
  const parentInv = obj.parent ? obj.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
  const local = new THREE.Matrix4().multiplyMatrices(parentInv, world);

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8b9bb4 }));
  mesh.name = 'geo';
  const holder = new THREE.Group();
  holder.add(mesh);
  let buf: ArrayBuffer;
  try {
    buf = await exportGlb(holder);
  } catch (e) {
    session.notice('warn', `Could not bake geometry: ${(e as Error).message}`);
    return null;
  }
  const created = await session.importGlbBytes(name, buf, `${name.replace(/[^a-z0-9-_]+/gi, '-')}.glb`);
  if (!created) return null;

  // move the new object to where the original was, and keep its children
  const kids = session.doc.objects.filter((o) => o.parentId === data.id);
  session.setParent(created.id, data.parentId);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  local.decompose(pos, quat, scl);
  const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  // the exported geometry is centred on `origin`, so shift by it
  const shifted = new THREE.Matrix4().multiplyMatrices(
    local,
    new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z),
  );
  shifted.decompose(pos, quat, scl);
  const e2 = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  session.writeLocalTransform(created.id, {
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: e2.x, y: e2.y, z: e2.z },
    scale: { x: scl.x, y: scl.y, z: scl.z },
  });
  void euler;
  for (const kid of kids) session.setParent(kid.id, created.id);
  if (data.materialId) session.assignMaterial(created.id, data.materialId);
  session.deleteObject(data.id);
  return created;
}
