import * as THREE from 'three';
import { Viewport } from '../engine/viewport.js';
import { TransformGizmo, type GizmoSpace } from '../engine/transform.js';
import { TransformRig, type PivotMode } from './transform-rig.js';
import { parseGlb, exportGlb, docClipsToAnimationClips, exportNodeName } from '../engine/gltf.js';
import { History } from './history.js';
import { Playback, activeClip, setKeyframe, deleteKeyframeAt, samplePose, trackValueOf } from './animation.js';
import { SyncEngine } from './sync.js';
import { Store } from '../state/store.js';
import {
  defaultMaterial, defaultObject, defaultClip, defaultScript, createProjectDoc, normalizeDoc, defaultSnap,
  type AnimTrack, type CameraState, type LightData, type LightKind, type MaterialData, type ObjectType, type PrimitiveType,
  type ProjectDoc, type ProjectMode, type SceneObjectData, type SceneScript, type ScriptTrigger, type ShadingMode, type Vec3,
  type ActivityEntry,
  type TransformMode, type CameraType, type PresenceUser, type SnapSettings,
} from '../state/models.js';
import { localDb } from '../lib/indexeddb.js';
import { auth } from '../lib/auth.js';
import { cloudEnabled } from '../lib/supabase.js';
import { cloudErrorMessage } from '../lib/cloud-errors.js';
import { uid, nowIso, debounce, throttle, makeThumb } from '../lib/utils.js';
import { generateImageSmart, generateMeshSmart } from '../ai/factory.js';
import { texturePrompt } from '../ai/pollinations.js';
import { ScriptEngine, SCRIPT_MAX_CODE, SCRIPT_MAX_COUNT, type ScriptHost, type ScriptRunResult } from './scripts.js';
import { collectSubtree, isWithinSubtree } from '../state/tree.js';
import { SelectionStore } from '../state/selection.js';
import { selectionOps, type SelectionOps } from './selection-ops.js';
import { transformOps, type TransformOps } from './transform-ops.js';
import { sceneOps, type SceneOps } from './scene-ops.js';
import { animationOps, type AnimationOps } from './animation-ops.js';
import { materialOps, type MaterialOps } from './material-ops.js';
import { exportOps, type ExportOps } from './export-ops.js';
import { aiOps, type AiOps } from './ai-ops.js';
import { nextInterp, type KeyInterp } from '../editor/animation.js';

export type SaveState = 'saved' | 'saving' | 'local' | 'offline' | 'error';

export interface PeerSelection {
  ids: string[];
  name: string;
  color: string;
}

export interface PeerCursor {
  /** Normalised device coordinates (-1..1). */
  x: number;
  y: number;
  name: string;
  color: string;
  at: number;
}

export interface SessionNotice {
  kind: 'info' | 'warn' | 'error';
  msg: string;
}

/**
 * Editing commands live in focused modules (selection, transform, scene,
 * animation, export) and are mixed into the prototype here, so the session
 * stays the single public surface for UI, scripts and the Agent API.
 */
export interface EditorSession extends SelectionOps, TransformOps, SceneOps, AnimationOps, MaterialOps, ExportOps, AiOps {}

export class EditorSession implements ScriptHost {
  doc: ProjectDoc;
  viewport: Viewport;
  rig: TransformRig;
  /** Back-compat alias: the low-level gizmo wrapper (now owned by `rig`). */
  gizmo: TransformGizmo;
  history = new History();
  playback: Playback;
  sync: SyncEngine;
  scriptEngine: ScriptEngine;
  readonly mode = 'live' as const;
  canGenerate = true;

  // UI state slices (§44)
  /** Multi-selection. `get()` still returns the primary (single) id. */
  selection = new SelectionStore();
  transformMode = new Store<TransformMode>('translate');
  /** Transform coordinate space for the gizmo. */
  gizmoSpace = new Store<GizmoSpace>('world');
  /** Multi-select pivot: object origins, median of centres, or bounds centre. */
  pivotMode = new Store<PivotMode>('origin');
  /** `object` moves geometry, `pivot` moves the transform origin. */
  transformTarget = new Store<'object' | 'pivot'>('object');
  snapSettings = new Store<SnapSettings>(defaultSnap());
  shadingMode = new Store<ShadingMode>('material');
  cameraType = new Store<CameraType>('perspective');
  saveState = new Store<SaveState>('local');
  syncError = new Store<string | null>(null);
  online = new Store<boolean>(navigator.onLine);
  peers = new Store<PresenceUser[]>([]);
  locks = new Store<Map<string, PresenceUser>>(new Map());
  /** What each peer has selected (collaboration 2.0 selection indicators). */
  peerSelections = new Store<Map<string, PeerSelection>>(new Map());
  /** Live peer pointers in normalised device coordinates. */
  peerCursors = new Store<Map<string, PeerCursor>>(new Map());
  anim = new Store<{ playing: boolean; frame: number; length: number; fps: number }>({
    playing: false, frame: 0, length: 90, fps: 30,
  });
  snap = new Store<boolean>(false); // gizmo translation/rotation/scale snapping (mirror of snapSettings.enabled)
  loop = new Store<boolean>(true); // playback loops the active clip
  rev = new Store<number>(0); // bumped on every doc mutation -> UI refresh
  canEdit = new Store<boolean>(true);
  /** Edits received from collaborators since our last undo checkpoint. */
  peerEdits = new Store<number>(0);
  autoKey = new Store<boolean>(false); // ⏺ record: transform edits write keyframes
  gridVisible = new Store<boolean>(true);
  firstPerson = new Store<boolean>(false);
  playMode = new Store<boolean>(false);

  onNotice: ((n: SessionNotice) => void) | null = null;
  onRecovery: ((local: ProjectDoc, cloud: ProjectDoc) => void) | null = null;
  pendingRecovery: ProjectDoc | null = null;

  private blobs = new Map<string, ArrayBuffer>(); // assetId -> glb bytes (runtime cache)
  private textures = new Map<string, THREE.Texture>(); // assetId -> gpu texture (owned here)
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
    this.rig = new TransformRig(this);
    const u = auth.user.get();
    if (u) {
      this.userId = u.id;
      this.userName = u.name;
    }
    // Undo entries are attributed to the local user, and a fresh checkpoint
    // means "nothing from a peer is at risk any more".
    this.history.setAuthor(() => ({ id: this.userId, name: this.userName }));
    this.history.onCheckpoint = () => this.peerEdits.set(0);

    normalizeDoc(doc);
    viewport.syncMaterials(doc.materials);
    for (const o of doc.objects) viewport.addObject(o);
    // Children listed before their parents were parked at the root — attach now.
    viewport.fixParenting(doc.objects);
    this.applySettings();

    this.gizmo = this.rig.gizmo;

    this.playback = new Playback(
      () => activeClip(this.doc),
      (frame) => {
        this.applyPose(frame);
        const clip = activeClip(this.doc);
        this.anim.set({ playing: this.playback.playing, frame, length: clip?.length ?? 90, fps: clip?.fps ?? 30 });
      },
    );
    this.scriptEngine = new ScriptEngine(this);
    viewport.events.onSelect = (id) => this.select(id);
    viewport.events.onFrame = (dt) => {
      this.playback.tick(dt);
      this.scriptEngine.tick(dt, this.playback.playing, this.playback.frame);
    };
    if (doc.settings?.camera) {
      try { viewport.setCameraState(doc.settings.camera); } catch { /* camera restore is best-effort */ }
    }

    this.selection.subscribe((id) => {
      viewport.outlineSet([...this.selection.all()]);
      const editable = id ? this.canEditObject(id) : false;
      this.rig.sync();
      const target = id ? this.doc.objects.find((o) => o.id === id) : undefined;
      this.sync.presenceEditing(id, target?.name ?? null);
      if (id && !editable) {
        const locker = this.locks.get().get(id);
        this.notice('warn', locker ? `${locker.name} is editing this object` : 'Object is locked');
      }
      if (id) this.broadcastLock(true);
    });
    this.selection.subscribeIds(() => {
      viewport.outlineSet([...this.selection.all()]);
      this.rig.sync();
      this.sync.broadcastSelection([...this.selection.all()]);
    });
    this.transformMode.subscribe((m) => this.gizmo.setMode(m));
    this.gizmoSpace.subscribe((sp) => this.rig.setSpace(sp));
    this.pivotMode.subscribe((m) => this.rig.setPivotMode(m));
    this.transformTarget.subscribe((t) => this.rig.setPivotEditing(t === 'pivot'));
    this.snapSettings.subscribe((cfg) => {
      this.gizmo.setSnap(cfg);
      this.snap.set(cfg.enabled);
      viewport.setGridSize(cfg.enabled ? cfg.grid : 1);
    });
    this.snap.subscribe((on) => {
      const cfg = this.snapSettings.get();
      if (cfg.enabled !== on) this.snapSettings.set({ ...cfg, enabled: on });
    });
    void localDb.getSetting('gizmo.space').then((v) => { if (v === 'local') this.gizmoSpace.set('local'); });
    void localDb.getSetting('gizmo.pivot').then((v) => { if (v === 'median' || v === 'bounds') this.pivotMode.set(v); });
    void localDb.getSetting('gizmo.snapcfg').then((raw) => {
      if (!raw) return;
      try {
        const cfg = JSON.parse(raw) as Partial<SnapSettings>;
        this.snapSettings.set({ ...this.snapSettings.get(), ...cfg });
      } catch { /* ignore malformed persisted snapping */ }
    });
    // keep the gizmo frame glued to the objects when data changes underneath it
    this.rev.subscribe(() => { if (!this.rig.gizmo.isDragging) this.rig.sync(); });
    this.loop.subscribe((on) => { this.playback.loop = on; });
    void localDb.getSetting('gizmo.snap').then((v) => { if (v === '1') this.snap.set(true); });
    this.shadingMode.subscribe((m) => viewport.setShading(m, this.doc.settings?.envIntensity ?? 1));
    this.cameraType.subscribe((t) => {
      viewport.setCameraType(t);
      this.gizmo.setCamera(viewport.camera);
    });
    this.playback.onPlayingChange = (playing) => {
      if (playing) this.rig.gizmo.attach(null);
      else this.rig.sync();
    };
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
    await session.hydrateTextures();
    const clip = activeClip(doc);
    session.anim.set({ playing: false, frame: 0, length: clip?.length ?? 90, fps: clip?.fps ?? 30 });
    await session.sync.start();
    session.history.checkpoint(doc, 'Open');
    // drop the open checkpoint so undo starts empty
    session.history.clear();
    void session.scriptEngine.runTrigger('open');
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
    this.saveState.set('saving');
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
        // same leak as GLB export: never bake the blue selection highlight
        const thumb = this.withHighlightOff(() => this.viewport.captureThumbnail());
        if (thumb) this.doc.thumbnail = thumb;
      }
      await localDb.saveProject(this.doc);
      if (this.saveState.get() !== 'offline') this.saveState.set(cloudEnabled && auth.user.get() && !auth.user.get()?.guest ? this.saveState.get() : 'local');
    } catch (e) {
      console.error('local save failed', e);
      this.saveState.set('error');
    }
  }

  async cloudSave(): Promise<void> {
    if (this.disposed || !this.canEdit.get()) return;
    if (!navigator.onLine) {
      this.saveState.set('offline');
      return;
    }
    if (!this.sync.ready()) return;
    this.saveState.set('saving');
    try {
      const ok = await this.sync.pushDoc(this.doc);
      this.saveState.set(ok ? (this.doc.cloudVersion === this.doc.version ? 'saved' : 'saving') : (navigator.onLine ? 'error' : 'offline'));
    } catch (e) {
      this.syncError.set(cloudErrorMessage(e));
      this.saveState.set('error');
    }
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

  // ---------- activity feed ----------
  /** Append to the project activity feed (persisted, capped, broadcast). */
  logActivity(kind: ActivityEntry['kind'], message: string, broadcast = true): void {
    const entry: ActivityEntry = { id: uid(), at: nowIso(), actor: this.userName, kind, message };
    this.doc.activity = [entry, ...this.doc.activity].slice(0, 80);
    this.markDirty('activity');
    if (broadcast) this.sync.broadcastActivity(entry);
  }

  /** Add an entry that arrived from a peer (never re-broadcast). */
  pushActivity(entry: ActivityEntry, _broadcast = false): void {
    if (!entry || typeof entry.message !== 'string') return;
    const safe: ActivityEntry = {
      id: typeof entry.id === 'string' ? entry.id : uid(),
      at: typeof entry.at === 'string' ? entry.at : nowIso(),
      actor: typeof entry.actor === 'string' ? entry.actor : 'Peer',
      kind: entry.kind ?? 'system',
      message: String(entry.message).slice(0, 240),
    };
    this.doc.activity = [safe, ...this.doc.activity].slice(0, 80);
    this.rev.set(this.rev.get() + 1);
  }

  // ---------- selection ----------
  select(id: string | null): void {
    const prev = this.selection.get();
    for (const released of this.selection.ids()) {
      if (released !== id) this.sync.broadcastLock(released, null, false);
    }
    this.selection.only(id);
    void prev;
  }

  /** Replace the selection with a set of ids (first-class multi-select). */
  selectIds(ids: string[], primary?: string | null): void {
    const keep = new Set(ids);
    for (const released of this.selection.ids()) {
      if (!keep.has(released)) this.sync.broadcastLock(released, null, false);
    }
    this.selection.setIds(ids, primary ?? null);
  }

  /** Shift/Ctrl-click: add or remove one object without clearing the rest. */
  toggleSelect(id: string): void {
    if (!id) return;
    if (this.selection.has(id)) {
      this.sync.broadcastLock(id, null, false);
      this.selection.remove(id);
    } else {
      this.selection.add(id);
      this.broadcastLock(true);
    }
  }

  selectedIds(): string[] {
    return this.selection.ids();
  }

  /** All selected object data rows (missing ids are ignored). */
  selectedObjects(): SceneObjectData[] {
    const ids = new Set(this.selection.ids());
    if (!ids.size) return [];
    return this.doc.objects.filter((o) => ids.has(o.id));
  }

  // ---------- transform plumbing (used by TransformRig) ----------
  /** Write a decomposed local transform straight to data + viewport. */
  writeLocalTransform(id: string, local: { position: Vec3; rotation: Vec3; scale: Vec3 }): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o || !this.canEditObject(id)) return;
    o.position = { ...local.position };
    o.rotation = { ...local.rotation };
    o.scale = { ...local.scale };
    o.version++;
    o.updatedAt = nowIso();
    const obj = this.viewport.objects.get(id);
    if (obj) {
      obj.position.set(o.position.x, o.position.y, o.position.z);
      obj.rotation.set(o.rotation.x, o.rotation.y, o.rotation.z);
      obj.scale.set(o.scale.x, o.scale.y, o.scale.z);
    }
    this.rev.set(this.rev.get() + 1);
    this.scheduleLocal();
    this.scheduleCloud();
    this.broadcastTransform(o);
  }

  /** Called when a gizmo drag starts — lock the objects being edited. */
  beginTransformBroadcast(): void {
    this.broadcastLock(true);
  }

  /** Called when a gizmo drag ends — release locks and persist. */
  endTransformBroadcast(): void {
    for (const id of this.selection.ids()) this.sync.broadcastLock(id, null, false);
  }

  /**
   * Snap-to-objects: after a translate drag, drop the selection onto whatever
   * surface sits under the cursor (ignoring the selection itself).
   */
  dropToSurface(): void {
    const cfg = this.snapSettings.get();
    if (!cfg.enabled || !cfg.toObjects) return;
    if (this.transformMode.get() !== 'translate') return;
    const hit = this.viewport.raycastPointer([...this.selection.all()]);
    if (!hit) return;
    const origin = this.rig.frameOrigin();
    const delta = hit.point.clone().sub(origin);
    if (delta.lengthSq() < 1e-8) return;
    this.translateWorld(delta, [...this.selection.all()]);
  }

  /** Move objects by a world-space offset, keeping parented locals correct. */
  translateWorld(delta: THREE.Vector3, ids = this.selection.ids()): void {
    if (!ids.length) return;
    const byId = new Map(this.doc.objects.map((o) => [o.id, o]));
    const set = new Set(ids);
    const roots = ids.filter((id) => {
      let p = byId.get(id)?.parentId ?? null;
      let hops = 0;
      while (p && hops++ < 64) {
        if (set.has(p)) return false;
        p = byId.get(p)?.parentId ?? null;
      }
      return true;
    });
    for (const id of roots) {
      const obj = this.viewport.objects.get(id);
      const data = byId.get(id);
      if (!obj || !data || !this.canEditObject(id)) continue;
      obj.updateWorldMatrix(true, false);
      const world = obj.matrixWorld.clone();
      const parentInv = obj.parent ? obj.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
      const moved = new THREE.Matrix4().multiplyMatrices(
        parentInv,
        new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z), world),
      );
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      moved.decompose(pos, quat, scl);
      const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
      this.writeLocalTransform(id, {
        position: { x: pos.x, y: pos.y, z: pos.z },
        rotation: { x: euler.x, y: euler.y, z: euler.z },
        scale: { x: scl.x, y: scl.y, z: scl.z },
      });
    }
  }

  /** Set the transform origin (pivot) of an object, in its own local space. */
  setPivot(id: string, pivot: Vec3): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o) return;
    o.pivot = { ...pivot };
    o.updatedAt = nowIso();
    o.version++;
    this.markDirty('pivot');
    this.sync.broadcastOp('update', o);
  }

  selectedId(): string | null {
    return this.selection.get();
  }

  persist(kind: string): void {
    this.markDirty(kind);
  }

  // ---------- object ops ----------
  addObject(type: ObjectType, name: string): SceneObjectData {
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
  addLight(kind: LightKind = 'point'): SceneObjectData {
    const o = this.addObject('light', kind.charAt(0).toUpperCase() + kind.slice(1));
    o.light = { ...((o.light ?? {}) as LightData), kind } as LightData;
    // rebuild the three object as the right light class
    this.viewport.removeObject(o.id);
    this.viewport.addObject(o);
    this.select(o.id);
    this.markDirty('add');
    this.sync.broadcastOp('update', o);
    return o;
  }

  updateLight(id: string, patch: Partial<LightData>): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o || o.type !== 'light' || !this.canEditObject(id)) return;
    o.light = { ...(o.light ?? { kind: 'point', color: '#ffffff', intensity: 10, distance: 20, angle: 0.6, penumbra: 0.4, castShadow: false }), ...patch };
    o.version++;
    this.viewport.removeObject(id);
    this.viewport.addObject(o);
    if (this.selection.get() === id) this.select(id); // re-attach gizmo
    this.markDirty('edit');
    this.sync.broadcastOp('update', o);
  }

  private uniqueName(base: string): string {
    const names = new Set(this.doc.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  /**
   * Deletes the whole subtree — a Group must not orphan its grandchildren
   * (the old one-level filter did exactly that, and peers received a
   * different scene because only the root id was broadcast).
   */
  deleteObject(id?: string): void {
    const target = id ?? this.selection.get();
    if (!target || !this.canEditObject(target)) return;
    this.history.checkpoint(this.doc, 'Delete');
    const ids = new Set(collectSubtree(this.doc.objects, target).map((o) => o.id));
    this.doc.objects = this.doc.objects.filter((o) => !ids.has(o.id));
    ids.forEach((x) => this.viewport.removeObject(x));
    // Drop animation tracks pointing at deleted objects, so clips don't
    // accumulate ghost lanes that reference ids nobody can select.
    const survivors = new Set(this.doc.objects.map((o) => o.id));
    for (const c of this.doc.clips) c.tracks = c.tracks.filter((t) => survivors.has(t.objectId));
    if (this.selection.get() && ids.has(this.selection.get() as string)) this.select(null);
    this.markDirty('delete');
    ids.forEach((x) => this.sync.broadcastOp('delete', { id: x }));
  }

  /** Duplicates the selected object INCLUDING its descendants (a Group copy
   * without children was silently losing the point of grouping). */
  duplicateObject(id?: string): SceneObjectData | null {
    const target = id ?? this.selection.get();
    const src = target ? this.doc.objects.find((o) => o.id === target) : null;
    if (!src) return null;
    this.history.checkpoint(this.doc, 'Duplicate');
    const subtree = collectSubtree(this.doc.objects, src.id);
    const idMap = new Map<string, string>();
    for (const node of subtree) idMap.set(node.id, uid());
    const rootCopy: SceneObjectData | null = null;
    const created: SceneObjectData[] = [];
    for (const node of subtree) {
      const copy = JSON.parse(JSON.stringify(node)) as SceneObjectData;
      copy.id = idMap.get(node.id) as string;
      copy.name = node.id === src.id ? this.uniqueName(`${src.name} copy`) : node.name;
      if (node.id === src.id) copy.position = { ...src.position, x: src.position.x + 0.5 };
      copy.parentId = node.parentId && idMap.has(node.parentId) ? idMap.get(node.parentId) as string : node.parentId;
      copy.version = 1;
      this.doc.objects.push(copy);
      this.viewport.addObject(copy); // parents pushed first — children attach via reparent
      if (copy.type === 'imported' && copy.assetId) void this.attachAsset(copy);
      this.sync.broadcastOp('add', copy);
      created.push(copy);
    }
    if (created.length) this.select(created[0].id);
    this.markDirty('add');
    void rootCopy;
    return created[0] ?? null;
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
    if (!this.canEditObject(childId)) return;
    // Cycle defense: the parent must not be the object itself or any of its
    // descendants — a THREE parent loop hangs the matrix/render walk and used
    // to freeze the whole tab (the inspector dropdown offered exactly that).
    if (parentId && isWithinSubtree(this.doc.objects, childId, parentId)) {
      this.notice('warn', 'Cannot parent an object inside itself');
      return;
    }
    this.history.checkpoint(this.doc, 'Reparent');
    this.reparentData(o, parentId);
    this.markDirty('edit');
    this.sync.broadcastOp('update', o);
  }

  /**
   * Shared reparent core: reassign parentId and bake the current world
   * transform into the new local space. No checkpoint/dirty/broadcast —
   * callers wrap it (single reparent vs. ungroup bulk).
   */
  private reparentData(o: SceneObjectData, parentId: string | null): void {
    o.parentId = parentId;
    o.version++;
    o.updatedAt = nowIso();
    const obj = this.viewport.objects.get(o.id);
    if (obj) {
      const parent = parentId ? this.viewport.objects.get(parentId) : this.viewport.scene;
      if (parent) {
        // refresh BOTH chains first: freshly added objects still hold an
        // identity matrixWorld until the next render tick (same trap as
        // fixParenting — see viewport.ts), and baking from it zeroed transforms
        obj.updateWorldMatrix(true, false);
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
  }

  /** Rail "Group": wraps the current selection in a new Group (title said
   * "Group selected objects" but it only ever added an empty group). */
  groupSelection(): SceneObjectData {
    const sel = this.selectedObject();
    const group = this.addGroup();
    if (sel && this.canEditObject(sel.id) && sel.id !== group.id) {
      this.reparentData(sel, group.id);
      this.markDirty('edit');
      this.sync.broadcastOp('update', sel);
    }
    return group;
  }

  /** Dissolve a Group: children are re-parented (world transforms preserved)
   * and the now-empty container is removed. */
  ungroupObject(id?: string): void {
    const target = id ?? this.selection.get();
    const o = target ? this.doc.objects.find((x) => x.id === target) : null;
    if (!o || o.type !== 'group') return;
    const kids = this.doc.objects.filter((x) => x.parentId === o.id);
    if (!kids.length) {
      this.deleteObject(o.id);
      return;
    }
    this.history.checkpoint(this.doc, 'Ungroup');
    for (const kid of kids) {
      this.reparentData(kid, o.parentId);
      this.sync.broadcastOp('update', kid);
    }
    this.doc.objects = this.doc.objects.filter((x) => x.id !== o.id);
    this.viewport.removeObject(o.id);
    this.markDirty('edit');
    this.sync.broadcastOp('delete', { id: o.id });
  }

  setVisible(id: string, visible: boolean): void {
    const o = this.doc.objects.find((x) => x.id === id);
    if (!o || o.visible === visible) return;
    this.toggleVisible(id);
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
    o.updatedAt = nowIso();
    this.viewport.updateObject(o);
    this.rig.sync();
    if (this.autoKey.get()) {
      if (pos) this.keyProp(o, 'position');
      if (rotDeg) this.keyProp(o, 'rotation');
      if (scl) this.keyProp(o, 'scale');
    }
    this.markDirty('transform');
    this.broadcastTransform(o);
  }

  /** Record-mode helper: key one property of an object at the playhead. */
  private keyProp(o: SceneObjectData, prop: AnimTrack['property']): void {
    this.history.checkpoint(this.doc, 'Auto key', 1200);
    setKeyframe(this.doc, o.id, prop, this.playback.frame, trackValueOf(o, prop));
  }

  /** Auto-key: write a keyframe for whatever the gizmo just changed. */
  autokeyFromGizmo(): void {
    if (!this.autoKey.get()) return;
    const map = { translate: 'position', rotate: 'rotation', scale: 'scale' } as const;
    const prop = map[this.transformMode.get()];
    const targets = this.selectedObjects();
    if (!targets.length) return;
    for (const o of targets) this.keyProp(o, prop);
    this.markDirty('animation');
  }

  // ---------- remote apply (no history, local-save only to avoid echo) ----------
  applyRemoteTransform(o: SceneObjectData): void {
    const local = this.doc.objects.find((x) => x.id === o.id);
    if (!local || o.version < local.version) return;
    // don't fight an active local drag
    if (this.selection.has(o.id) && this.rig.gizmo.isDragging) return;
    local.position = o.position;
    local.rotation = o.rotation;
    local.scale = o.scale;
    local.version = o.version;
    this.viewport.updateObject(local);
    this.rev.set(this.rev.get() + 1);
    this.peerEdits.set(this.peerEdits.get() + 1);
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
        // A child may have arrived before its parent — attach it now.
        for (const o of this.doc.objects) {
          if (o.parentId === incoming.id) this.viewport.updateObject(o);
        }
        if (incoming.type === 'imported' && incoming.assetId) void this.attachAsset(incoming);
      } else if (incoming.version >= local.version) {
        Object.assign(local, JSON.parse(JSON.stringify(incoming)) as SceneObjectData);
        this.viewport.updateObject(local);
      }
    }
    this.rev.set(this.rev.get() + 1);
    this.peerEdits.set(this.peerEdits.get() + 1);
    this.scheduleLocal();
  }

  applyRemoteMaterial(m: MaterialData): void {
    const local = this.doc.materials.find((x) => x.id === m.id);
    if (local) Object.assign(local, m);
    else this.doc.materials.push(m);
    normalizeDoc(this.doc);
    if (m.mapAssetId) void this.attachTextureById(m.mapAssetId);
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.updateObject(o);
    this.rev.set(this.rev.get() + 1);
    this.peerEdits.set(this.peerEdits.get() + 1);
    this.scheduleLocal();
  }

  // ---------- materials ----------
  addMaterial(name?: string): MaterialData {
    this.history.checkpoint(this.doc, 'Add material');
    const m = defaultMaterial(name ?? `Material ${this.doc.materials.length + 1}`);
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

  /** Single-undo-step bulk paint used by AI auto-paint (dedupes materials). */
  applyPaint(
    items: { objectId: string; materialName: string; patch: Partial<MaterialData> }[],
  ): { objectId: string; materialId: string }[] {
    if (!items.length) return [];
    this.history.checkpoint(this.doc, 'AI auto-paint');
    const byKey = new Map<string, MaterialData>();
    const applied: { objectId: string; materialId: string }[] = [];
    for (const it of items) {
      const key = JSON.stringify(it.patch);
      let mat = byKey.get(key);
      if (!mat) {
        mat = defaultMaterial(it.materialName.slice(0, 60));
        Object.assign(mat, it.patch, { updatedAt: nowIso() });
        this.doc.materials.push(mat);
        byKey.set(key, mat);
        this.sync.broadcastMaterial(mat);
      }
      const o = this.doc.objects.find((x) => x.id === it.objectId);
      if (o && this.canEditObject(it.objectId)) {
        o.materialId = mat.id;
        o.version++;
        this.sync.broadcastOp('update', o);
      }
      applied.push({ objectId: it.objectId, materialId: mat.id });
    }
    normalizeDoc(this.doc);
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.updateObject(o);
    this.markDirty('material');
    return applied;
  }

  /** Public undo checkpoint for bulk agent operations. */
  checkpoint(label: string): void {
    this.history.checkpoint(this.doc, label);
  }

  // ---------- GLB assets ----------
  /** Import a model file; resolves to the created object (null on failure). */
  async importGlbFile(file: File): Promise<SceneObjectData | null> {
    const buf = await file.arrayBuffer();
    return this.importGlbBytes(file.name.replace(/\.(glb|gltf)$/i, '') || 'Model', buf, file.name);
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
      mime: 'model/gltf-binary', size: buf.byteLength, storagePath: null, local: true, thumb: null, createdAt: nowIso(),
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

  async attachAsset(o: SceneObjectData): Promise<void> {
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

  // ---------- textures (base-color maps) ----------
  /**
   * Upload an image and assign it to a material slot.
   * `slot` picks which map is written: base colour, normal or ambient
   * occlusion (normal maps are NOT colour-space converted).
   */
  async uploadTexture(materialId: string, file: File, slot: 'base' | 'normal' | 'ao' = 'base'): Promise<void> {
    const m = this.doc.materials.find((x) => x.id === materialId);
    if (!m) return;
    const slotField = slot === 'base' ? 'mapAssetId' : slot === 'normal' ? 'normalMapAssetId' : 'aoMapAssetId';
    const buf = await file.arrayBuffer();
    const blob = new Blob([buf], { type: file.type || 'image/png' });
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      this.notice('error', 'Could not decode that image');
      return;
    }
    this.history.checkpoint(this.doc, 'Add texture');
    // drop the previous map for this slot
    const previous = m[slotField] as string | null;
    if (previous) this.dropTexture(previous, materialId);
    const assetId = uid();
    await localDb.saveBlob(assetId, blob);
    const tex = this.textureFromBitmap(bitmap);
    if (slot === 'normal') tex.colorSpace = THREE.NoColorSpace;
    this.textures.set(assetId, tex);
    this.doc.assets.push({
      id: assetId, name: file.name, kind: 'texture', mime: blob.type,
      size: buf.byteLength, storagePath: null, local: true,
      thumb: makeThumb(bitmap), createdAt: nowIso(),
    });
    (m[slotField] as string | null) = assetId;
    m.updatedAt = nowIso();
    if (slot === 'base') this.viewport.materials.setMap(materialId, tex, m);
    else this.viewport.materials.setSlotMap(materialId, slot, tex);
    for (const o of this.doc.objects) if (o.materialId === materialId) this.viewport.updateObject(o);
    this.markDirty('material');
    this.sync.broadcastMaterial(m);
    const ext = (file.name.split('.').pop() ?? 'png').toLowerCase().slice(0, 4) || 'png';
    void this.sync.uploadAsset(assetId, file.name, buf, { kind: 'texture', mime: blob.type, ext });
  }

  removeTexture(materialId: string): void {
    const m = this.doc.materials.find((x) => x.id === materialId);
    if (!m || !m.mapAssetId) return;
    this.history.checkpoint(this.doc, 'Remove texture');
    this.dropTexture(m.mapAssetId, materialId);
    m.mapAssetId = null;
    m.updatedAt = nowIso();
    for (const o of this.doc.objects) if (o.materialId === materialId) this.viewport.updateObject(o);
    this.markDirty('material');
    this.sync.broadcastMaterial(m);
  }

  private dropTexture(assetId: string, materialId: string): void {
    this.viewport.materials.setMap(materialId, null);
    const tex = this.textures.get(assetId);
    if (tex) {
      tex.dispose();
      this.textures.delete(assetId);
    }
    // keep the blob for undo/redo + other materials
  }

  private textureFromBitmap(bitmap: ImageBitmap): THREE.Texture {
    const tex = new THREE.Texture(bitmap);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /** Load + assign texture maps for all textured materials (open / rebuild). */
  async hydrateTextures(): Promise<void> {
    for (const m of this.doc.materials) {
      if (m.mapAssetId) await this.attachTextureById(m.mapAssetId);
    }
    this.viewport.syncMaterials(this.doc.materials);
    // re-link maps after sync (sync() preserves the map registry)
    for (const m of this.doc.materials) {
      if (m.mapAssetId && this.textures.has(m.mapAssetId)) {
        this.viewport.materials.setMap(m.id, this.textures.get(m.mapAssetId) ?? null, m);
      }
    }
  }

  private async attachTextureById(assetId: string): Promise<void> {
    if (this.textures.has(assetId)) return;
    let blob = await localDb.getBlob(assetId);
    if (!blob) {
      let path = this.doc.assets.find((a) => a.id === assetId)?.storagePath ?? null;
      if (!path) path = await this.sync.fetchAssetPath(assetId); // late-joining peer
      if (path) {
        const buf = await this.sync.downloadAsset(path);
        if (buf) {
          const meta = this.doc.assets.find((a) => a.id === assetId);
          blob = new Blob([buf], { type: meta?.mime || 'image/png' });
          await localDb.saveBlob(assetId, blob);
        }
      }
    }
    if (!blob) return;
    try {
      const bitmap = await createImageBitmap(blob);
      this.textures.set(assetId, this.textureFromBitmap(bitmap));
    } catch {
      /* corrupt image — leave untextured */
    }
  }

  textureThumb(assetId: string): string | null {
    return this.doc.assets.find((a) => a.id === assetId)?.thumb ?? null;
  }

  /**
   * Runs `fn` with the selection highlight un-applied. The highlight mutates
   * SHARED material emissive (viewport.applyOutline) and clones reference the
   * same material instances — without this, every export/thumbnail taken
   * while an object was selected baked a blue glow into the saved project.
   */
  private withHighlightOff<T>(fn: () => T): T {
    const sel = this.selection.get();
    if (!sel) return fn();
    this.viewport.outline(null);
    try {
      return fn();
    } finally {
      this.viewport.outline(sel);
    }
  }

  async exportGlb(): Promise<void> {
    // Export is authored from the DOCUMENT, not the live viewport:
    //  - playback/scrubbing writes sampled poses straight onto viewport
    //    objects, so cloning them mid-animation baked a random frame into the
    //    file ("looks correct in the app, broken in every viewer" class);
    //  - the selection highlight must not leak (withHighlightOff).
    const group = new THREE.Group();
    const restore: { obj: THREE.Object3D; p: THREE.Vector3; r: THREE.Euler; s: THREE.Vector3; name: string }[] = [];
    const idToNode = new Map<string, THREE.Object3D>();
    const byId = new Map(this.doc.objects.map((o) => [o.id, o]));
    this.doc.objects.forEach((o, i) => {
      const obj = this.viewport.objects.get(o.id);
      if (!obj) return;
      restore.push({ obj, p: obj.position.clone(), r: obj.rotation.clone(), s: obj.scale.clone(), name: obj.name });
      obj.position.set(o.position.x, o.position.y, o.position.z);
      obj.rotation.set(o.rotation.x, o.rotation.y, o.rotation.z);
      obj.scale.set(o.scale.x, o.scale.y, o.scale.z);
      // stable, binding-safe names for animation tracks
      obj.name = exportNodeName(o.name, i);
    });
    try {
      this.withHighlightOff(() => {
        this.viewport.scene.updateMatrixWorld(true);
        for (const o of this.doc.objects) {
          // roots only; children ride along. Orphans (parentId set but the
          // parent object is gone) export as roots instead of vanishing.
          if (o.parentId && byId.has(o.parentId)) continue;
          const obj = this.viewport.objects.get(o.id);
          if (!obj) continue;
          const clone = obj.clone(true);
          group.add(clone);
          idToNode.set(o.id, clone);
        }
      });
      const animations = docClipsToAnimationClips(this.doc.clips, idToNode);
      const buf = await exportGlb(group, animations);
      const blob = new Blob([buf], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.doc.name.replace(/\s+/g, '-').toLowerCase() || 'scene'}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      this.notice('error', `GLB export failed: ${(e as Error).message}`);
    } finally {
      for (const r of restore) {
        r.obj.position.copy(r.p);
        r.obj.rotation.copy(r.r);
        r.obj.scale.copy(r.s);
        r.obj.name = r.name;
      }
      // if a clip is active, put the viewport back on the sampled pose
      if (this.playback.playing || this.playback.frame > 0) this.applyPose(this.playback.frame);
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

  /** All keyed frames in the active clip (selected object, else whole clip). */
  private keyFrames(): number[] {
    const clip = activeClip(this.doc);
    if (!clip) return [];
    const sel = this.selection.get();
    const frames = new Set<number>();
    for (const t of clip.tracks) {
      if (sel && t.objectId !== sel) continue;
      for (const k of t.keyframes) frames.add(k.frame);
    }
    return [...frames].sort((a, b) => a - b);
  }

  gotoPrevKey(): void {
    const frames = this.keyFrames().filter((f) => f < this.playback.frame);
    if (!frames.length) {
      this.notice('info', 'No earlier keyframe');
      return;
    }
    this.playback.setFrame(frames[frames.length - 1]);
  }

  gotoNextKey(): void {
    const frames = this.keyFrames().filter((f) => f > this.playback.frame);
    if (!frames.length) {
      this.notice('info', 'No later keyframe');
      return;
    }
    this.playback.setFrame(frames[0]);
  }

  /** Toggle linear/step interpolation for the selected object's keys at playhead. */
  toggleInterpAtPlayhead(): void {
    const o = this.selectedObject();
    const clip = activeClip(this.doc);
    if (!o || !clip) {
      this.notice('warn', 'Select an object first');
      return;
    }
    this.history.checkpoint(this.doc, 'Toggle interpolation', 800);
    let mode: KeyInterp | null = null;
    for (const t of clip.tracks) {
      if (t.objectId !== o.id) continue;
      for (const k of t.keyframes) {
        if (k.frame !== this.playback.frame) continue;
        k.interp = nextInterp(k.interp);
        mode = k.interp;
      }
    }
    if (!mode) {
      this.notice('info', 'No keyframe at the playhead');
      return;
    }
    this.markDirty('animation');
    this.notice('info', `Interpolation: ${mode}`);
  }

  interpAtPlayhead(): KeyInterp | null {
    const o = this.selectedObject();
    const clip = activeClip(this.doc);
    if (!o || !clip) return null;
    for (const t of clip.tracks) {
      if (t.objectId !== o.id) continue;
      const k = t.keyframes.find((x) => x.frame === this.playback.frame);
      if (k) return k.interp;
    }
    return null;
  }

  addKeyframe(objectId: string, property: AnimTrack['property'], frame: number, value: [number, number, number]): void {
    setKeyframe(this.doc, objectId, property, frame, value);
    this.markDirty('animation');
  }

  deleteKeyframe(objectId: string, property: AnimTrack['property'], frame: number): void {
    deleteKeyframeAt(this.doc, objectId, property, frame);
    this.markDirty('animation');
  }

  play(): void {
    this.playback.play();
    this.syncAnim();
  }
  pause(): void {
    this.playback.pause();
    this.syncAnim();
  }
  stop(): void {
    this.playback.stop();
    this.syncAnim();
  }
  setFrame(n: number): void {
    this.playback.setFrame(n);
    this.syncAnim();
  }
  getPlayback(): { playing: boolean; frame: number; length: number; fps: number } {
    return this.anim.get();
  }
  private syncAnim(): void {
    const clip = activeClip(this.doc);
    this.anim.set({ playing: this.playback.playing, frame: this.playback.frame, length: clip?.length ?? 90, fps: clip?.fps ?? 30 });
  }

  getCamera(): CameraState {
    return this.viewport.getCameraState();
  }
  setCamera(patch: Partial<CameraState>, persist = true): void {
    this.viewport.setCameraState(patch);
    if (patch.type) this.cameraType.set(this.viewport.cameraType);
    if (persist) {
      this.doc.settings.camera = this.viewport.getCameraState();
      this.markDirty('camera');
    }
  }
  orbitCamera(azimuthDeg: number, polarDeg: number, distance?: number): void {
    this.viewport.orbitCamera(azimuthDeg, polarDeg, distance);
  }
  focus(id: string | null): void {
    this.viewport.focus(id);
  }

  addScript(patch?: Partial<SceneScript>): SceneScript {
    if (this.doc.scripts.length >= SCRIPT_MAX_COUNT) {
      throw new Error(`At most ${SCRIPT_MAX_COUNT} scripts per project.`);
    }
    this.history.checkpoint(this.doc, 'Add script');
    const s = defaultScript(patch?.name ?? `Script ${this.doc.scripts.length + 1}`);
    if (typeof patch?.code === 'string') s.code = patch.code.slice(0, SCRIPT_MAX_CODE);
    if (patch?.trigger) s.trigger = patch.trigger;
    if (typeof patch?.enabled === 'boolean') s.enabled = patch.enabled;
    this.doc.scripts.push(s);
    this.markDirty('script');
    return s;
  }

  updateScript(id: string, patch: Partial<Pick<SceneScript, 'name' | 'code' | 'enabled' | 'trigger'>>): SceneScript {
    const s = this.doc.scripts.find((x) => x.id === id);
    if (!s) throw new Error(`Script ${id} not found.`);
    this.history.checkpoint(this.doc, 'Edit script', 800);
    if (typeof patch.name === 'string' && patch.name.trim()) s.name = patch.name.trim().slice(0, 80);
    if (typeof patch.code === 'string') {
      s.code = patch.code.slice(0, SCRIPT_MAX_CODE);
      this.scriptEngine.invalidate(id);
    }
    if (typeof patch.enabled === 'boolean') s.enabled = patch.enabled;
    if (patch.trigger) {
      if (!(['manual', 'open', 'play', 'frame'] as ScriptTrigger[]).includes(patch.trigger)) {
        throw new Error('trigger must be manual, open, play or frame.');
      }
      s.trigger = patch.trigger;
    }
    s.updatedAt = nowIso();
    this.markDirty('script');
    return s;
  }

  deleteScript(id: string): void {
    const i = this.doc.scripts.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.history.checkpoint(this.doc, 'Delete script');
    this.doc.scripts.splice(i, 1);
    this.scriptEngine.invalidate(id);
    this.markDirty('script');
  }

  async runScript(id: string): Promise<ScriptRunResult> {
    const s = this.doc.scripts.find((x) => x.id === id);
    if (!s) throw new Error(`Script ${id} not found.`);
    this.history.checkpoint(this.doc, `Run ${s.name}`);
    return this.scriptEngine.run(s, { allowHeavy: true, frame: this.playback.frame, time: this.scriptEngine.time });
  }

  async runAdhoc(code: string): Promise<ScriptRunResult> {
    this.history.checkpoint(this.doc, 'Run script');
    return this.scriptEngine.run({ id: 'adhoc', name: 'Ad hoc', code }, { allowHeavy: true, frame: this.playback.frame, time: this.scriptEngine.time });
  }

  async generateTexture(
    prompt: string,
    opts: { materialId?: string; objectId?: string; size?: number; seamless?: boolean } = {},
  ): Promise<{ materialId: string; provider: string; seed: number }> {
    const size = Math.max(64, Math.min(1024, opts.size ?? 512));
    const { result } = await generateImageSmart(texturePrompt(prompt, opts.seamless !== false), { width: size, height: size });
    let matId = opts.materialId;
    if (matId) {
      if (!this.doc.materials.some((m) => m.id === matId)) throw new Error(`Material ${matId} not found.`);
    } else {
      const mat = this.addMaterial(prompt.slice(0, 32) || 'AI texture');
      matId = mat.id;
    }
    const file = new File([result.blob], `${prompt.slice(0, 40) || 'texture'}.png`, { type: result.mime });
    await this.uploadTexture(matId, file);
    if (opts.objectId) this.assignMaterial(opts.objectId, matId);
    return { materialId: matId, provider: result.provider, seed: result.seed };
  }

  async generateModel(
    prompt: string,
    opts: { name?: string; quality?: 'fast' | 'balanced' | 'high' } = {},
  ): Promise<{ objectId?: string; objectIds?: string[]; provider: string }> {
    const name = opts.name ?? prompt.slice(0, 40) ?? 'AI model';
    const outcome = await generateMeshSmart(prompt, { quality: opts.quality ?? 'balanced' });
    if (outcome.kind === 'glb') {
      const obj = await this.importGlbBytes(name, outcome.result.glb.slice(0), `${name}.glb`);
      if (!obj) throw new Error('The generated file was not a valid 3D model.');
      return { objectId: obj.id, provider: outcome.result.provider };
    }
    const objectIds: string[] = [];
    for (const part of outcome.parts) {
      const created = part.kind === 'group' ? this.addGroup() : this.addPrimitive(part.kind as PrimitiveType);
      this.renameObject(created.id, part.name);
      this.setTransform(
        created.id,
        { x: part.position[0], y: part.position[1], z: part.position[2] },
        undefined,
        part.scale ? { x: part.scale[0], y: part.scale[1], z: part.scale[2] } : undefined,
      );
      if (part.color) {
        const mat = this.addMaterial(`${part.name} color`);
        this.updateMaterial(mat.id, { name: `${part.name} color`, baseColor: part.color });
        this.assignMaterial(created.id, mat.id);
      }
      objectIds.push(created.id);
    }
    return { objectIds, provider: 'procedural-mesh' };
  }

  applyPose(frame: number): void {
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

  // ---------- undo/redo (collaboration aware) ----------

  /**
   * Undo is snapshot based, so reverting our own change also rolls back any
   * edit a collaborator made after it. Rather than silently throwing their work
   * away, the first request explains what is at stake and asks to confirm;
   * solo editing (no peer edits pending) is never interrupted.
   */
  private undoArmed = false;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  /** What `undo()` would revert, with its author. */
  undoPreview(): { label: string; author: string | null; peerEdits: number } | null {
    const entry = this.history.undoInfo();
    if (!entry) return null;
    return { label: entry.label, author: entry.author?.name ?? null, peerEdits: this.peerEdits.get() };
  }

  /** Recent undo entries (newest first) for the activity / history panel. */
  recentChanges(limit = 12): { label: string; author: string | null; at: number }[] {
    return this.history.entries(limit).map((e) => ({ label: e.label, author: e.author?.name ?? null, at: e.at }));
  }

  /** Cancel a pending "press again to confirm" undo. */
  private disarmUndo(): void {
    this.undoArmed = false;
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = null;
  }

  undo(force = false): void {
    if (!this.history.canUndo()) {
      this.notice('info', 'Nothing to undo');
      return;
    }
    const peers = this.peerEdits.get();
    if (!force && peers > 0 && !this.undoArmed) {
      this.undoArmed = true;
      this.undoTimer = setTimeout(() => this.disarmUndo(), 8000);
      this.notice('warn', `Undoing also reverts ${peers} change${peers === 1 ? '' : 's'} from collaborators — press undo again to confirm`);
      return;
    }
    this.disarmUndo();
    const entry = this.history.undoInfo();
    if (!this.history.undo(this.doc)) return;
    this.peerEdits.set(0);
    this.scriptEngine.invalidate();
    this.rebuildFromDoc();
    this.markDirty('undo');
    if (entry) this.notice('info', `Undid ${this.history.describe(entry)}`);
  }

  redo(): void {
    if (!this.history.canRedo()) {
      this.notice('info', 'Nothing to redo');
      return;
    }
    if (!this.history.redo(this.doc)) return;
    this.scriptEngine.invalidate();
    this.rebuildFromDoc();
    this.markDirty('undo');
  }

  /**
   * Undo only my own work: walks back to my newest entry and reverts it (plus
   * everything above it) as a single step, so one Ctrl+Z never eats a
   * collaborator's edit by accident without saying so.
   */
  undoMine(force = false): void {
    const depth = this.history.depthOfMine(this.userId);
    if (depth === null) {
      this.undo(force);
      return;
    }
    if (!force && (depth > 0 || this.peerEdits.get() > 0) && !this.undoArmed) {
      this.undoArmed = true;
      this.undoTimer = setTimeout(() => this.disarmUndo(), 8000);
      const reason = depth > 0
        ? `your last change is ${depth} step${depth === 1 ? '' : 's'} back`
        : `${this.peerEdits.get()} collaborator change${this.peerEdits.get() === 1 ? '' : 's'} came after it`;
      this.notice('warn', `Undoing your change also reverts what came after (${reason}) — press again to confirm`);
      return;
    }
    this.disarmUndo();
    const entry = this.history.undoInfo();
    if (!this.history.undoThrough(this.doc, depth)) return;
    this.peerEdits.set(0);
    this.scriptEngine.invalidate();
    this.rebuildFromDoc();
    this.markDirty('undo');
    if (entry) this.notice('info', `Undid ${this.history.describe(entry)}`);
  }

  /** Redo counterpart of `undoMine()`. */
  redoMine(): void {
    const depth = this.history.depthOfMine(this.userId);
    if (depth === null || depth === 0) {
      this.redo();
      return;
    }
    if (!this.history.redoThrough(this.doc, depth)) return;
    this.scriptEngine.invalidate();
    this.rebuildFromDoc();
    this.markDirty('undo');
  }

  rebuildFromDoc(): void {
    const sel = this.selection.get();
    this.gizmo.attach(null);
    this.viewport.clearAll();
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.addObject(o);
    this.viewport.fixParenting(this.doc.objects);
    for (const o of this.doc.objects) {
      if (o.type === 'imported' && o.assetId) void this.attachAsset(o);
    }
    if (sel && this.doc.objects.some((o) => o.id === sel)) this.select(sel);
    else this.select(null);
    this.playback.setFrame(this.playback.frame);
    void this.hydrateTextures();
  }

  restoreSnapshot(snapshot: { objects: ProjectDoc['objects']; materials: ProjectDoc['materials']; clips: ProjectDoc['clips']; scripts?: ProjectDoc['scripts'] }, label: string): void {
    this.history.checkpoint(this.doc, `Restore ${label}`);
    this.doc.objects = JSON.parse(JSON.stringify(snapshot.objects)) as ProjectDoc['objects'];
    this.doc.materials = JSON.parse(JSON.stringify(snapshot.materials)) as ProjectDoc['materials'];
    this.doc.clips = JSON.parse(JSON.stringify(snapshot.clips)) as ProjectDoc['clips'];
    if (snapshot.scripts) this.doc.scripts = JSON.parse(JSON.stringify(snapshot.scripts)) as ProjectDoc['scripts'];
    normalizeDoc(this.doc);
    this.scriptEngine.invalidate();
    this.rebuildFromDoc();
    this.applySettings();
    this.markDirty('restore');
  }

  // ---------- misc ----------
  // ---------- scene settings ----------
  applySettings(): void {
    const st = this.doc.settings ?? { envIntensity: 1, shadows: true };
    this.viewport.setShading(this.viewport.getShading(), st.envIntensity);
    this.viewport.setShadowsEnabled(st.shadows);
  }

  updateSettings(patch: Partial<{ envIntensity: number; shadows: boolean }>): void {
    Object.assign(this.doc.settings, patch);
    this.applySettings();
    this.markDirty('settings');
  }

  focusSelected(): void {
    this.viewport.focus(this.selection.get());
  }
  setTransformMode(m: TransformMode): void {
    this.transformMode.set(m);
  }
  user(): { id: string; name: string } {
    return { id: this.userId, name: this.userName };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    void this.localSave();
    this.sync.dispose();
    this.rig.dispose();
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
    this.viewport.dispose();
  }
}

// Mix the focused command modules into the session prototype.
Object.assign(EditorSession.prototype, selectionOps, transformOps, sceneOps, animationOps, materialOps, exportOps, aiOps);
