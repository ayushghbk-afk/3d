import * as THREE from 'three';
import { Viewport } from '../engine/viewport.js';
import { TransformGizmo } from '../engine/transform.js';
import { parseGlb, exportGlb } from '../engine/gltf.js';
import { History } from './history.js';
import { Playback, activeClip, setKeyframe, deleteKeyframeAt, samplePose, trackValueOf } from './animation.js';
import { SyncEngine } from './sync.js';
import { Store } from '../state/store.js';
import {
  defaultMaterial, defaultObject, defaultClip, createProjectDoc,
  type AnimTrack, type MaterialData, type ObjectType, type PrimitiveType,
  type ProjectDoc, type ProjectMode, type SceneObjectData, type ShadingMode,
  type TransformMode, type CameraType, type PresenceUser,
} from '../state/models.js';
import { localDb } from '../lib/indexeddb.js';
import { auth } from '../lib/auth.js';
import { cloudEnabled } from '../lib/supabase.js';
import { uid, nowIso, debounce, throttle } from '../lib/utils.js';

export type SaveState = 'saved' | 'saving' | 'local' | 'offline' | 'error';

export interface SessionNotice {
  kind: 'info' | 'warn' | 'error';
  msg: string;
}

export class EditorSession {
  doc: ProjectDoc;
  viewport: Viewport;
  gizmo: TransformGizmo;
  history = new History();
  playback: Playback;
  sync: SyncEngine;

  // UI state slices (§44)
  selection = new Store<string | null>(null);
  transformMode = new Store<TransformMode>('translate');
  shadingMode = new Store<ShadingMode>('material');
  cameraType = new Store<CameraType>('perspective');
  saveState = new Store<SaveState>('saved');
  online = new Store<boolean>(navigator.onLine);
  peers = new Store<PresenceUser[]>([]);
  locks = new Store<Map<string, PresenceUser>>(new Map());
  anim = new Store<{ playing: boolean; frame: number; length: number; fps: number }>({
    playing: false, frame: 0, length: 90, fps: 30,
  });
  rev = new Store<number>(0); // bumped on every doc mutation -> UI refresh
  canEdit = new Store<boolean>(true);

  onNotice: ((n: SessionNotice) => void) | null = null;
  onRecovery: ((local: ProjectDoc, cloud: ProjectDoc) => void) | null = null;

  private blobs = new Map<string, ArrayBuffer>(); // assetId -> glb bytes (runtime cache)
  private userId = 'guest';
  private userName = 'Guest';
  private disposed = false;
  private lastThumb = 0;

  private constructor(doc: ProjectDoc, viewport: Viewport) {
    this.doc = doc;
    this.viewport = viewport;
    // Sync engine first: store subscriptions below fire synchronously on
    // subscribe and already touch `this.sync` (presence/locks).
    this.sync = new SyncEngine(this);
    const u = auth.user.get();
    if (u) {
      this.userId = u.id;
      this.userName = u.name;
    }

    viewport.syncMaterials(doc.materials);
    for (const o of doc.objects) viewport.addObject(o);

    this.gizmo = new TransformGizmo(viewport.scene, viewport.camera, viewport.renderer.domElement);
    this.gizmo.onDraggingChanged = (dragging) => {
      viewport.controls.enabled = !dragging;
      if (dragging) {
        this.history.checkpoint(this.doc, 'Transform');
        this.broadcastLock(true);
      } else {
        this.markDirty('transform');
      }
    };
    this.gizmo.onObjectChange = (delta) => {
      const id = this.selection.get();
      if (!id) return;
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o || !this.canEditObject(id)) return;
      o.position = delta.position;
      o.rotation = delta.rotation;
      o.scale = delta.scale;
      o.version++;
      o.updatedAt = nowIso();
      this.rev.set(this.rev.get() + 1);
      this.scheduleLocal();
      this.scheduleCloud();
      this.broadcastTransform(o);
    };

    viewport.events.onSelect = (id) => this.select(id);
    viewport.events.onFrame = (dt) => this.playback.tick(dt);

    this.playback = new Playback(
      () => activeClip(this.doc),
      (frame) => {
        this.applyPose(frame);
        const clip = activeClip(this.doc);
        this.anim.set({ playing: this.playback.playing, frame, length: clip?.length ?? 90, fps: clip?.fps ?? 30 });
      },
    );

    this.selection.subscribe((id) => {
      viewport.outline(id);
      const obj = id ? viewport.objects.get(id) ?? null : null;
      const editable = id ? this.canEditObject(id) : false;
      this.gizmo.attach(obj && editable ? obj : null);
      const target = id ? this.doc.objects.find((o) => o.id === id) : undefined;
      this.sync.presenceEditing(id, target?.name ?? null);
      if (id && !editable) {
        const locker = this.locks.get().get(id);
        this.notice('warn', locker ? `${locker.name} is editing this object` : 'Object is locked');
      }
      if (id) this.broadcastLock(true);
    });
    this.transformMode.subscribe((m) => this.gizmo.setMode(m));
    this.shadingMode.subscribe((m) => viewport.setShading(m));
    this.cameraType.subscribe((t) => {
      viewport.setCameraType(t);
      this.gizmo.setCamera(viewport.camera);
    });
    this.history.onChange = () => this.rev.set(this.rev.get() + 1);

    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  static async open(projectId: string | null, container: HTMLElement, opts?: { name?: string; mode?: ProjectMode }): Promise<EditorSession> {
    const viewport = new Viewport(container);
    const u = auth.user.get();
    const userId = u?.id ?? 'guest';
    let doc: ProjectDoc | null = null;

    if (projectId) {
      // Local-first: load local copy immediately, reconcile with cloud after.
      doc = await localDb.getProject(projectId);
      if (!doc && cloudEnabled && u && !u.guest) {
        doc = await SyncEngine.pullStandalone(projectId);
      }
      if (!doc) throw new Error('Project not found');
    } else {
      doc = createProjectDoc(opts?.name ?? 'Untitled', opts?.mode ?? 'solo', userId);
      await localDb.saveProject(doc);
    }

    const session = new EditorSession(doc, viewport);
    await session.hydrateBlobs();
    // attach imported contents
    for (const o of doc.objects) {
      if (o.type === 'imported' && o.assetId) await session.attachAsset(o);
    }
    const clip = activeClip(doc);
    session.anim.set({ playing: false, frame: 0, length: clip?.length ?? 90, fps: clip?.fps ?? 30 });
    await session.sync.start();
    session.history.checkpoint(doc, 'Open');
    // drop the open checkpoint so undo starts empty
    session.history.clear();
    return session;
  }

  // ---------- helpers ----------
  notice(kind: SessionNotice['kind'], msg: string): void {
    this.onNotice?.({ kind, msg });
  }

  selectedObject(): SceneObjectData | null {
    const id = this.selection.get();
    return id ? this.doc.objects.find((o) => o.id === id) ?? null : null;
  }

  canEditObject(id: string): boolean {
    if (!this.canEdit.get()) return false;
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o || o.locked) return false;
    const lock = this.locks.get().get(id);
    if (lock && lock.id !== this.userId) return false;
    return true;
  }

  markDirty(_kind: string): void {
    this.doc.updatedAt = nowIso();
    this.doc.version++;
    this.rev.set(this.rev.get() + 1);
    this.scheduleLocal();
    this.scheduleCloud();
  }

  private scheduleLocal = debounce(() => void this.localSave(), 400);
  private scheduleCloud = debounce(() => void this.cloudSave(), 2000);
  private broadcastTransform = throttle((o: SceneObjectData) => {
    this.sync.broadcastTransform(o);
  }, 66);

  private broadcastLock(acquire: boolean): void {
    const sel = this.selectedObject();
    if (!sel) return;
    this.sync.broadcastLock(sel.id, sel.name, acquire);
  }

  async localSave(): Promise<void> {
    if (this.disposed) return;
    try {
      if (Date.now() - this.lastThumb > 10000) {
        this.lastThumb = Date.now();
        const thumb = this.viewport.captureThumbnail();
        if (thumb) this.doc.thumbnail = thumb;
      }
      await localDb.saveProject(this.doc);
      if (this.saveState.get() !== 'offline') this.saveState.set(cloudEnabled ? this.saveState.get() : 'local');
    } catch (e) {
      console.error('local save failed', e);
      this.saveState.set('error');
    }
  }

  async cloudSave(): Promise<void> {
    if (this.disposed || !this.sync.ready()) return;
    if (!navigator.onLine) {
      this.saveState.set('offline');
      return;
    }
    this.saveState.set('saving');
    const ok = await this.sync.pushDoc(this.doc);
    this.saveState.set(ok ? 'saved' : 'offline');
  }

  async forceSave(): Promise<void> {
    await this.localSave();
    await this.cloudSave();
  }

  private handleOnline = (): void => {
    this.online.set(true);
    void this.sync.flushQueue().then(() => this.cloudSave());
    this.notice('info', 'Back online — syncing changes');
  };
  private handleOffline = (): void => {
    this.online.set(false);
    this.saveState.set('offline');
    this.notice('warn', 'Connection lost — changes are saved locally');
  };

  // ---------- selection ----------
  select(id: string | null): void {
    const prev = this.selection.get();
    if (prev && prev !== id) this.sync.broadcastLock(prev, null, false);
    this.selection.set(id);
  }

  // ---------- object ops ----------
  private addObject(type: ObjectType, name: string): SceneObjectData {
    this.history.checkpoint(this.doc, `Add ${name}`);
    const o = defaultObject(type, this.uniqueName(name));
    if (type !== 'group' && type !== 'light' && type !== 'imported') {
      o.materialId = this.doc.materials[0]?.id ?? null;
    }
    this.doc.objects.push(o);
    this.viewport.addObject(o);
    this.select(o.id);
    this.markDirty('add');
    this.sync.broadcastOp('add', o);
    return o;
  }

  addPrimitive(kind: PrimitiveType): SceneObjectData {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    return this.addObject(kind, label);
  }
  addGroup(): SceneObjectData {
    return this.addObject('group', 'Group');
  }
  addLight(): SceneObjectData {
    return this.addObject('light', 'Light');
  }

  private uniqueName(base: string): string {
    const names = new Set(this.doc.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  deleteObject(id?: string): void {
    const target = id ?? this.selection.get();
    if (!target || !this.canEditObject(target)) return;
    this.history.checkpoint(this.doc, 'Delete');
    const ids = new Set([target, ...this.doc.objects.filter((o) => o.parentId === target).map((o) => o.id)]);
    this.doc.objects = this.doc.objects.filter((o) => !ids.has(o.id));
    ids.forEach((x) => this.viewport.removeObject(x));
    if (this.selection.get() && ids.has(this.selection.get() as string)) this.select(null);
    this.markDirty('delete');
    this.sync.broadcastOp('delete', { id: target });
  }

  duplicateObject(id?: string): void {
    const target = id ?? this.selection.get();
    const src = target ? this.doc.objects.find((o) => o.id === target) : null;
    if (!src) return;
    this.history.checkpoint(this.doc, 'Duplicate');
    const copy: SceneObjectData = JSON.parse(JSON.stringify(src)) as SceneObjectData;
    copy.id = uid();
    copy.name = this.uniqueName(`${src.name} copy`);
    copy.position = { ...src.position, x: src.position.x + 0.5 };
    copy.version = 1;
    this.doc.objects.push(copy);
    this.viewport.addObject(copy);
    if (copy.type === 'imported' && copy.assetId) void this.attachAsset(copy);
    this.select(copy.id);
    this.markDirty('add');
    this.sync.broadcastOp('add', copy);
  }

  renameObject(id: string, name: string): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o || !this.canEditObject(id)) return;
    this.history.checkpoint(this.doc, 'Rename');
    o.name = name || o.name;
    o.version++;
    this.viewport.updateObject(o);
    this.markDirty('edit');
    this.sync.broadcastOp('update', o);
  }

  setParent(childId: string, parentId: string | null): void {
    const o = this.doc.objects.find((x) => x.id === childId);
    if (!o || childId === parentId) return;
    this.history.checkpoint(this.doc, 'Reparent');
    o.parentId = parentId;
    o.version++;
    // bake current world transform into local
    const obj = this.viewport.objects.get(childId);
    if (obj) {
      const parent = parentId ? this.viewport.objects.get(parentId) : this.viewport.scene;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        const m = new THREE.Matrix4().copy(obj.matrixWorld).premultiply(new THREE.Matrix4().copy(parent.matrixWorld).invert());
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        m.decompose(p, q, s);
        const e = new THREE.Euler().setFromQuaternion(q);
        o.position = { x: p.x, y: p.y, z: p.z };
        o.rotation = { x: e.x, y: e.y, z: e.z };
        o.scale = { x: s.x, y: s.y, z: s.z };
      }
    }
    this.viewport.updateObject(o);
    this.markDirty('edit');
    this.sync.broadcastOp('update', o);
  }

  toggleVisible(id: string): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o) return;
    o.visible = !o.visible;
    o.version++;
    this.viewport.updateObject(o);
    this.markDirty('edit');
    this.sync.broadcastOp('update', o);
  }

  toggleLock(id: string): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o) return;
    this.history.checkpoint(this.doc, o.locked ? 'Unlock' : 'Lock');
    o.locked = !o.locked;
    o.version++;
    this.markDirty('edit');
    this.sync.broadcastOp('update', o);
    if (this.selection.get() === id) this.select(id); // refresh gizmo attach
  }

  setTransform(id: string, pos?: Partial<SceneObjectData['position']>, rotDeg?: { x?: number; y?: number; z?: number }, scl?: Partial<SceneObjectData['scale']>): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o || !this.canEditObject(id)) return;
    if (pos) o.position = { ...o.position, ...pos };
    if (rotDeg) {
      const d = THREE.MathUtils.degToRad;
      o.rotation = {
        x: rotDeg.x !== undefined ? d(rotDeg.x) : o.rotation.x,
        y: rotDeg.y !== undefined ? d(rotDeg.y) : o.rotation.y,
        z: rotDeg.z !== undefined ? d(rotDeg.z) : o.rotation.z,
      };
    }
    if (scl) o.scale = { ...o.scale, ...scl };
    o.version++;
    this.viewport.updateObject(o);
    this.markDirty('transform');
    this.broadcastTransform(o);
  }

  // ---------- remote apply (no history, local-save only to avoid echo) ----------
  applyRemoteTransform(o: SceneObjectData): void {
    const local = this.doc.objects.find((x) => x.id === o.id);
    if (!local || o.version < local.version) return;
    // don't fight an active local drag
    if (this.selection.get() === o.id && this.gizmo.controls.dragging) return;
    local.position = o.position;
    local.rotation = o.rotation;
    local.scale = o.scale;
    local.version = o.version;
    this.viewport.updateObject(local);
    this.rev.set(this.rev.get() + 1);
    this.scheduleLocal();
  }

  applyRemoteOp(op: 'add' | 'delete' | 'update', data: SceneObjectData | { id: string }): void {
    if (op === 'delete') {
      const id = (data as { id: string }).id;
      this.doc.objects = this.doc.objects.filter((o) => o.id !== id);
      this.viewport.removeObject(id);
      if (this.selection.get() === id) this.select(null);
    } else {
      const incoming = data as SceneObjectData;
      const local = this.doc.objects.find((o) => o.id === incoming.id);
      if (!local) {
        this.doc.objects.push(incoming);
        this.viewport.addObject(incoming);
        if (incoming.type === 'imported' && incoming.assetId) void this.attachAsset(incoming);
      } else if (incoming.version >= local.version) {
        Object.assign(local, JSON.parse(JSON.stringify(incoming)) as SceneObjectData);
        this.viewport.updateObject(local);
      }
    }
    this.rev.set(this.rev.get() + 1);
    this.scheduleLocal();
  }

  applyRemoteMaterial(m: MaterialData): void {
    const local = this.doc.materials.find((x) => x.id === m.id);
    if (local) Object.assign(local, m);
    else this.doc.materials.push(m);
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.updateObject(o);
    this.rev.set(this.rev.get() + 1);
    this.scheduleLocal();
  }

  // ---------- materials ----------
  addMaterial(): MaterialData {
    this.history.checkpoint(this.doc, 'Add material');
    const m = defaultMaterial(`Material ${this.doc.materials.length + 1}`);
    this.doc.materials.push(m);
    this.viewport.syncMaterials(this.doc.materials);
    this.markDirty('material');
    return m;
  }

  updateMaterial(id: string, patch: Partial<MaterialData>): void {
    const m = this.doc.materials.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch, { updatedAt: nowIso() });
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) if (o.materialId === id) this.viewport.updateObject(o);
    this.markDirty('material');
    this.sync.broadcastMaterial(m);
  }

  assignMaterial(objectId: string, materialId: string | null): void {
    const o = this.doc.objects.find((x) => x.id === objectId);
    if (!o || !this.canEditObject(objectId)) return;
    this.history.checkpoint(this.doc, 'Assign material');
    o.materialId = materialId;
    o.version++;
    this.viewport.updateObject(o);
    this.markDirty('material');
    this.sync.broadcastOp('update', o);
  }

  // ---------- GLB assets ----------
  async importGlbFile(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    await this.importGlbBytes(file.name.replace(/\.(glb|gltf)$/i, '') || 'Model', buf, file.name);
  }

  async importGlbBytes(name: string, buf: ArrayBuffer, filename?: string): Promise<SceneObjectData | null> {
    let parsed;
    try {
      parsed = await parseGlb(buf.slice(0));
    } catch (e) {
      this.notice('error', `Invalid GLB: ${(e as Error).message}`);
      return null;
    }
    this.history.checkpoint(this.doc, 'Import model');
    const assetId = uid();
    this.blobs.set(assetId, buf);
    await localDb.saveBlob(assetId, new Blob([buf], { type: 'model/gltf-binary' }));
    this.doc.assets.push({
      id: assetId, name: filename ?? `${name}.glb`, kind: 'model',
      mime: 'model/gltf-binary', size: buf.byteLength, storagePath: null, local: true, createdAt: nowIso(),
    });
    const o = defaultObject('imported', this.uniqueName(name));
    o.assetId = assetId;
    this.doc.objects.push(o);
    this.viewport.addObject(o);
    this.viewport.attachImported(o.id, parsed.scene);
    this.select(o.id);
    this.markDirty('add');
    this.sync.broadcastOp('add', o);
    // upload bytes in background (cloud)
    void this.sync.uploadAsset(assetId, filename ?? `${name}.glb`, buf);
    return o;
  }

  private async hydrateBlobs(): Promise<void> {
    for (const a of this.doc.assets) {
      if (this.blobs.has(a.id)) continue;
      const blob = await localDb.getBlob(a.id);
      if (blob) this.blobs.set(a.id, await blob.arrayBuffer());
      else if (a.storagePath) {
        const buf = await this.sync.downloadAsset(a.storagePath);
        if (buf) {
          this.blobs.set(a.id, buf);
          await localDb.saveBlob(a.id, new Blob([buf]));
        }
      }
    }
  }

  private async attachAsset(o: SceneObjectData): Promise<void> {
    if (!o.assetId) return;
    let buf = this.blobs.get(o.assetId);
    if (!buf) {
      const blob = await localDb.getBlob(o.assetId);
      if (blob) {
        buf = await blob.arrayBuffer();
        this.blobs.set(o.assetId, buf);
      }
    }
    if (!buf) {
      this.notice('warn', `Missing asset bytes for ${o.name}`);
      return;
    }
    try {
      const parsed = await parseGlb(buf.slice(0));
      this.viewport.attachImported(o.id, parsed.scene);
    } catch {
      this.notice('error', `Could not parse ${o.name}`);
    }
  }

  getAssetBytes(assetId: string): ArrayBuffer | null {
    return this.blobs.get(assetId) ?? null;
  }

  async exportGlb(): Promise<void> {
    const group = new THREE.Group();
    for (const o of this.doc.objects) {
      if (o.parentId) continue; // roots only; children ride along
      const obj = this.viewport.objects.get(o.id);
      if (obj) group.add(obj.clone(true));
    }
    try {
      const buf = await exportGlb(group);
      const blob = new Blob([buf], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.doc.name.replace(/\s+/g, '-').toLowerCase() || 'scene'}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      this.notice('error', `GLB export failed: ${(e as Error).message}`);
    }
  }

  // ---------- animation ----------
  addClip(name?: string): void {
    this.history.checkpoint(this.doc, 'Add clip');
    const c = defaultClip(name ?? `Clip ${this.doc.clips.length + 1}`);
    this.doc.clips.push(c);
    this.doc.activeClipId = c.id;
    this.markDirty('animation');
    this.playback.setFrame(0);
  }

  setActiveClip(id: string): void {
    this.doc.activeClipId = id;
    this.playback.setFrame(0);
    this.markDirty('animation');
  }

  setClipProps(fps: number, length: number): void {
    const clip = activeClip(this.doc);
    if (!clip) return;
    clip.fps = Math.max(1, Math.min(120, Math.round(fps)));
    clip.length = Math.max(1, Math.min(2000, Math.round(length)));
    this.markDirty('animation');
    this.playback.setFrame(Math.min(this.playback.frame, clip.length));
  }

  addKeyframeSelected(prop: AnimTrack['property'] = 'position'): void {
    const o = this.selectedObject();
    if (!o) {
      this.notice('warn', 'Select an object first');
      return;
    }
    this.history.checkpoint(this.doc, 'Add keyframe', 800);
    setKeyframe(this.doc, o.id, prop, this.playback.frame, trackValueOf(o, prop));
    this.markDirty('animation');
  }

  addKeyframeAll(): void {
    const o = this.selectedObject();
    if (!o) {
      this.notice('warn', 'Select an object first');
      return;
    }
    this.history.checkpoint(this.doc, 'Add keyframe', 800);
    (['position', 'rotation', 'scale'] as AnimTrack['property'][]).forEach((p) =>
      setKeyframe(this.doc, o.id, p, this.playback.frame, trackValueOf(o, p)),
    );
    this.markDirty('animation');
  }

  deleteKeyframeSelected(prop: AnimTrack['property'] = 'position'): void {
    const o = this.selectedObject();
    if (!o) return;
    this.history.checkpoint(this.doc, 'Delete keyframe', 800);
    deleteKeyframeAt(this.doc, o.id, prop, this.playback.frame);
    this.markDirty('animation');
  }

  private applyPose(frame: number): void {
    const clip = activeClip(this.doc);
    if (!clip) return;
    const pose = samplePose(clip, frame);
    // reset animated objects to doc, then apply pose (viewport only)
    const touched = new Set<string>();
    for (const [id] of pose) touched.add(id);
    for (const track of clip.tracks) touched.add(track.objectId);
    for (const id of touched) {
      const data = this.doc.objects.find((o) => o.id === id);
      const obj = this.viewport.objects.get(id);
      if (!data || !obj) continue;
      const p = pose.get(id);
      obj.position.set(p?.position?.[0] ?? data.position.x, p?.position?.[1] ?? data.position.y, p?.position?.[2] ?? data.position.z);
      obj.rotation.set(p?.rotation?.[0] ?? data.rotation.x, p?.rotation?.[1] ?? data.rotation.y, p?.rotation?.[2] ?? data.rotation.z);
      obj.scale.set(p?.scale?.[0] ?? data.scale.x, p?.scale?.[1] ?? data.scale.y, p?.scale?.[2] ?? data.scale.z);
    }
  }

  // ---------- undo/redo ----------
  undo(): void {
    if (!this.history.undo(this.doc)) return;
    this.rebuildFromDoc();
    this.markDirty('undo');
  }
  redo(): void {
    if (!this.history.redo(this.doc)) return;
    this.rebuildFromDoc();
    this.markDirty('undo');
  }

  rebuildFromDoc(): void {
    const sel = this.selection.get();
    this.gizmo.attach(null);
    this.viewport.clearAll();
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.addObject(o);
    for (const o of this.doc.objects) {
      if (o.type === 'imported' && o.assetId) void this.attachAsset(o);
    }
    if (sel && this.doc.objects.some((o) => o.id === sel)) this.select(sel);
    else this.select(null);
    this.playback.setFrame(this.playback.frame);
  }

  restoreSnapshot(snapshot: { objects: ProjectDoc['objects']; materials: ProjectDoc['materials']; clips: ProjectDoc['clips'] }, label: string): void {
    this.history.checkpoint(this.doc, `Restore ${label}`);
    this.doc.objects = JSON.parse(JSON.stringify(snapshot.objects)) as ProjectDoc['objects'];
    this.doc.materials = JSON.parse(JSON.stringify(snapshot.materials)) as ProjectDoc['materials'];
    this.doc.clips = JSON.parse(JSON.stringify(snapshot.clips)) as ProjectDoc['clips'];
    this.rebuildFromDoc();
    this.markDirty('restore');
  }

  // ---------- misc ----------
  focusSelected(): void {
    this.viewport.focus(this.selection.get());
  }
  setTransformMode(m: TransformMode): void {
    this.transformMode.set(m);
  }
  user(): { id: string; name: string } {
    return { id: this.userId, name: this.userName };
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    void this.localSave();
    this.sync.dispose();
    this.gizmo.dispose();
    this.viewport.dispose();
  }
}
