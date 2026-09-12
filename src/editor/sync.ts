import type { RealtimeChannel } from '@supabase/supabase-js';
import type { EditorSession } from './session.js';
import { cloudEnabled, supabase } from '../lib/supabase.js';
import { auth } from '../lib/auth.js';
import { cloudErrorMessage } from '../lib/cloud-errors.js';
import { localDb } from '../lib/indexeddb.js';
import { uid, nowIso } from '../lib/utils.js';
import { defaultMaterial, type MaterialData, type PresenceUser, type ProjectDoc, type ProjectMode, type SceneObjectData, type TeamRole } from '../state/models.js';

// Supabase sync: durable upserts (debounced) + Realtime Broadcast/Presence.
// Local-mode safe: every method no-ops when cloud is unavailable.

interface TransformMsg {
  objectId: string;
  position: SceneObjectData['position'];
  rotation: SceneObjectData['rotation'];
  scale: SceneObjectData['scale'];
  version: number;
  actor: string;
}

interface OpMsg {
  op: 'add' | 'delete' | 'update';
  data: SceneObjectData | { id: string };
  actor: string;
}

interface LockMsg {
  objectId: string;
  name: string | null;
  action: 'acquire' | 'release';
  user: { id: string; name: string; color: string };
}

const COLORS = ['#4ade80', '#60a5fa', '#f472b6', '#facc15', '#a78bfa', '#fb923c', '#2dd4bf'];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export class SyncEngine {
  private channel: RealtimeChannel | null = null;
  private lockSweep: ReturnType<typeof setInterval> | null = null;
  private sceneId: string | null = null;
  private selfColor = '#4ade80';
  private disposed = false;
  private pendingWrite: Promise<boolean> = Promise.resolve(true);
  /** `projects.version` as last observed (pull/ensure) or last written. CAS base
   * for durable pushes. `doc.cloudVersion` stays the *content* claim — only
   * advanced when a whole-doc push succeeded. */
  private observedHead = 0;

  constructor(private session: EditorSession) {}

  ready(): boolean {
    if (!cloudEnabled || this.disposed) return false;
    const u = auth.user.get();
    return !!u && !u.guest && navigator.onLine;
  }

  async start(): Promise<void> {
    if (!this.ready()) return;
    const u = auth.user.get();
    if (!u) return;
    this.selfColor = colorFor(u.id);
    try {
      const created = await this.ensureCloudProject();
      this.subscribe();
      this.lockSweep = setInterval(() => this.sweepLocks(), 10000);
      // reconcile: pull cloud, compare with local
      const cloud = await SyncEngine.pullStandalone(this.session.doc.id);
      if (cloud) this.observedHead = Math.max(this.observedHead, cloud.version);
      if (cloud && cloud.updatedAt > this.session.doc.updatedAt && cloud.version !== this.session.doc.version) {
        this.session.pendingRecovery = cloud;
        this.session.syncError.set('Cloud has a newer revision. Resolve the sync conflict before saving.');
        this.session.onRecovery?.(this.session.doc, cloud);
        return;
      }
      await this.flushQueue();
      if (created) await this.session.cloudSave();
      else if (this.session.doc.cloudVersion === this.session.doc.version) this.session.saveState.set('saved');
    } catch (e) {
      console.warn('sync start failed (offline mode)', e);
      this.session.saveState.set(navigator.onLine ? 'error' : 'offline');
      this.session.syncError.set(cloudErrorMessage(e));
    }
  }

  // ---------- durable persistence ----------
  private async ensureCloudProject(): Promise<boolean> {
    const sb = supabase();
    const doc = this.session.doc;
    const u = auth.user.get();
    if (!u || u.guest) return false;
    const { data: existing } = await sb.from('projects').select('id,version,owner_id').eq('id', doc.id).maybeSingle().throwOnError();
    if (!existing) {
      await sb.from('projects').insert({
        id: doc.id, name: doc.name, mode: doc.mode, owner_id: u.id, version: doc.version,
      }).throwOnError();
      // Adopt a local/guest project only after the server accepted its creation.
      doc.ownerId = u.id;
      await sb.from('project_members').insert({ project_id: doc.id, user_id: u.id, role: 'owner' }).throwOnError();
      // The row we just created holds exactly this revision — the head for future CAS writes.
      this.observedHead = doc.version;
    } else {
      doc.ownerId = existing.owner_id;
      this.observedHead = Math.max(this.observedHead, existing.version ?? 0);
    }
    const { data: me } = await sb.from('project_members').select('role').eq('project_id', doc.id).eq('user_id', u.id).maybeSingle().throwOnError();
    const role: TeamRole = doc.ownerId === u.id ? 'owner' : (me?.role ?? 'viewer');
    this.session.canEdit.set(role !== 'viewer');

    const { data: scene } = await sb.from('scenes').select('id').eq('project_id', doc.id).limit(1).maybeSingle().throwOnError();
    this.sceneId = scene?.id ?? null;
    if (!this.sceneId && this.session.canEdit.get()) {
      const { data: created } = await sb.from('scenes').insert({ project_id: doc.id, name: 'Main Scene' }).select('id').single().throwOnError();
      this.sceneId = created.id;
    }
    return !existing;
  }

  /** Serialize saves and freeze each snapshot so edits during a request cannot be
   * mistaken for an already-synced revision. Supabase resolves { error } by default.
   */
  pushDoc(doc: ProjectDoc): Promise<boolean> {
    const snapshot = JSON.parse(JSON.stringify(doc)) as ProjectDoc;
    const write = async () => {
      const ok = await this.persistDoc(snapshot);
      if (ok) {
        doc.cloudVersion = Math.max(doc.cloudVersion, snapshot.version);
        await localDb.saveProject(doc);
      }
      return ok;
    };
    const result = this.pendingWrite.then(write, write);
    this.pendingWrite = result.catch(() => false);
    return result;
  }

  private async persistDoc(doc: ProjectDoc): Promise<boolean> {
    if (!this.ready() || this.session.pendingRecovery) return false;
    try {
      const sb = supabase();
      if (!this.sceneId) await this.ensureCloudProject();
      if (!this.sceneId || !this.session.canEdit.get()) return false;
      doc.ownerId = this.session.doc.ownerId;

      // objects: upsert all, delete missing
      // scene settings ride on the scene row
      await sb.from('scenes').update({ data: { settings: doc.settings, scripts: doc.scripts ?? [] } }).eq('id', this.sceneId).select('id').single().throwOnError();
      const rows = doc.objects.map((o) => ({
        id: o.id, scene_id: this.sceneId as string, project_id: doc.id, name: o.name,
        object_type: o.type, parent_id: o.parentId,
        position: [o.position.x, o.position.y, o.position.z],
        rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
        scale: [o.scale.x, o.scale.y, o.scale.z],
        visible: o.visible, locked: o.locked, material_id: o.materialId,
        geometry: o.primitive
          ? { kind: o.primitive.kind, params: o.primitive.params }
          : o.light
            ? { light: o.light }
            : null,
        asset_id: o.assetId ?? null, version: o.version,
      }));
      if (rows.length) {
        const { error } = await sb.from('scene_objects').upsert(rows);
        if (error) throw error;
      }
      const { data: remoteObjs } = await sb.from('scene_objects').select('id').eq('scene_id', this.sceneId).throwOnError();
      const localIds = new Set(doc.objects.map((o) => o.id));
      const stale = ((remoteObjs ?? []) as { id: string }[]).map((r) => r.id).filter((id) => !localIds.has(id));
      if (stale.length) await sb.from('scene_objects').delete().in('id', stale).throwOnError();

      // materials
      if (doc.materials.length) {
        const { error } = await sb.from('materials').upsert(
          doc.materials.map((m) => ({
            id: m.id, project_id: doc.id, scene_id: this.sceneId as string, name: m.name,
            base_color: m.baseColor, metalness: m.metalness, roughness: m.roughness,
            emissive: m.emissive, emissive_intensity: m.emissiveIntensity,
            opacity: m.opacity, transparent: m.transparent,
            side: m.side, flat_shading: m.flatShading, map_asset_id: m.mapAssetId,
          })),
        );
        if (error) throw error;
      }

      // animations: replace (simple + correct at debounce scale)
      const { data: anims } = await sb.from('animations').select('id').eq('project_id', doc.id).throwOnError();
      if (anims?.length) await sb.from('animations').delete().in('id', (anims as { id: string }[]).map((a) => a.id)).throwOnError();
      for (const clip of doc.clips) {
        const { error } = await sb.from('animations').insert({
          id: clip.id, project_id: doc.id, scene_id: this.sceneId as string,
          name: clip.name, fps: clip.fps, length_frames: clip.length,
        });
        if (error) throw error;
        for (const t of clip.tracks) {
          await sb.from('animation_tracks').insert({ id: t.id, animation_id: clip.id, object_id: t.objectId, property: t.property }).throwOnError();
          if (t.keyframes.length) {
            await sb.from('keyframes').insert(
              t.keyframes.map((k) => ({ track_id: t.id, frame: k.frame, value: [...k.value], interp: k.interp })),
            ).throwOnError();
          }
        }
      }

      // Mark the cloud revision only AFTER every durable write has succeeded.
      // A thumbnail is cosmetic: a Storage failure here (missing `thumbnails`
      // bucket, a policy change, an oversized blob) used to throw out of the
      // whole push, so the scene rows written above were left behind while
      // projects.version never advanced and the badge read "✕ Error" forever.
      // Store what we can, keep the previous thumbnail_url, and keep saving.
      let thumbnailUrl: string | undefined;
      if (doc.thumbnail) {
        try {
          const response = await fetch(doc.thumbnail);
          if (!response.ok) throw new Error('Could not read the project thumbnail.');
          const blob = await response.blob();
          const path = `${doc.id}/thumb.jpg`;
          const { error } = await sb.storage.from('thumbnails').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
          if (error) throw error;
          thumbnailUrl = sb.storage.from('thumbnails').getPublicUrl(path).data.publicUrl;
        } catch (e) {
          console.warn('thumbnail upload skipped', e);
          this.session.notice('warn', `Saved without a thumbnail: ${cloudErrorMessage(e)}`);
        }
      }
      // Compare-and-swap on the cloud head revision we last observed. Without
      // this, a whole-doc push from device A silently overwrote a peer's
      // newer work (including anything A's undo had rolled back).
      const base = this.observedHead;
      const { data: updated } = await sb.from('projects')
        .update({ name: doc.name, version: doc.version, thumbnail_url: thumbnailUrl })
        .eq('id', doc.id).eq('version', base).select('id').maybeSingle().throwOnError();
      if (!updated) {
        return this.resolveVersionConflict(doc, base);
      }
      doc.cloudVersion = doc.version;
      this.observedHead = doc.version;
      this.session.syncError.set(null);
      return true;
    } catch (e) {
      console.warn('cloud push failed, queueing', e);
      this.session.syncError.set(cloudErrorMessage(e));
      await this.queuePush(doc);
      return false;
    }
  }

  /** A peer saved since our base revision. Surface the conflict through the
   * existing recovery modal (keep mine / use cloud) instead of overwriting —
   * and keep our work safely queued. */
  private async resolveVersionConflict(doc: ProjectDoc, base: number): Promise<boolean> {
    const cloud = await SyncEngine.pullStandalone(doc.id).catch(() => null);
    if (cloud && cloud.version === doc.version) {
      // Our own write actually landed (e.g. a retried push after a lost
      // response) — the row already holds this revision; count it as synced.
      this.observedHead = doc.version;
      this.session.syncError.set(null);
      await localDb.clearQueue((await localDb.listQueue(doc.id)).filter((op) => op.kind === 'push').map((op) => op.id));
      return true;
    }
    this.session.syncError.set('Someone else saved this project first — resolve the sync conflict before pushing again.');
    await this.queuePush(doc);
    if (cloud) {
      this.observedHead = cloud.version; // "keep mine" then CASes against the real head
      this.session.pendingRecovery = cloud;
      this.session.onRecovery?.(this.session.doc, cloud);
    }
    return false;
  }

  private async queuePush(doc: ProjectDoc): Promise<void> {
    // One current snapshot per project, not an unbounded duplicate on every retry.
    await localDb.enqueue({ id: `push:${doc.id}`, projectId: doc.id, kind: 'push', payload: doc, createdAt: nowIso(), attempts: 0 });
  }

  static async pullStandalone(projectId: string): Promise<ProjectDoc | null> {
    if (!cloudEnabled) return localDb.getProject(projectId);
    const u = auth.user.get();
    if (!u || u.guest) return localDb.getProject(projectId);
    try {
      const sb = supabase();
      const { data: proj, error } = await sb.from('projects').select('*').eq('id', projectId).single().throwOnError();
      if (error) throw error;
      if (!proj) return localDb.getProject(projectId);
      const p = proj as { id: string; name: string; mode: ProjectMode; owner_id: string; thumbnail_url?: string | null; version: number; updated_at: string };
      const { data: scene } = await sb.from('scenes').select('id,data').eq('project_id', projectId).limit(1).maybeSingle().throwOnError();
      const sceneId = (scene as { id: string } | null)?.id ?? null;
      const sceneData = ((scene as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
      const cloudSettings = (sceneData.settings ?? null) as ProjectDoc['settings'] | null;
      let objects: SceneObjectData[] = [];
      if (sceneId) {
        const { data } = await sb.from('scene_objects').select('*').eq('scene_id', sceneId).throwOnError();
        objects = ((data ?? []) as Record<string, never>[]).map((r) => SyncEngine.rowToObject(r as unknown as Record<string, unknown>));
      }
      const { data: mats } = await sb.from('materials').select('*').eq('project_id', projectId).throwOnError();
      const { data: anims } = await sb.from('animations').select('*').eq('project_id', projectId).throwOnError();
      const clips: ProjectDoc['clips'] = [];
      for (const a of (anims ?? []) as Record<string, unknown>[]) {
        const { data: tracks } = await sb.from('animation_tracks').select('*').eq('animation_id', a.id as string).throwOnError();
        const clipTracks: ProjectDoc['clips'][number]['tracks'] = [];
        for (const t of (tracks ?? []) as Record<string, unknown>[]) {
          const { data: keys } = await sb.from('keyframes').select('*').eq('track_id', t.id as string).order('frame').throwOnError();
          clipTracks.push({
            id: t.id as string,
            objectId: (t.object_id as string) ?? '',
            property: (t.property as 'position' | 'rotation' | 'scale') ?? 'position',
            keyframes: ((keys ?? []) as Record<string, unknown>[]).map((k) => ({
              frame: k.frame as number,
              value: (k.value as [number, number, number]) ?? [0, 0, 0],
              interp: ((k.interp as string) ?? 'linear') as 'linear' | 'step',
            })),
          });
        }
        clips.push({ id: a.id as string, name: (a.name as string) ?? 'Clip', fps: (a.fps as number) ?? 30, length: (a.length_frames as number) ?? 90, tracks: clipTracks });
      }
      const { data: assets } = await sb.from('assets').select('*').eq('project_id', projectId).throwOnError();
      const local = await localDb.getProject(projectId);
      return {
        id: p.id, name: p.name, mode: p.mode, ownerId: p.owner_id,
        thumbnail: local?.thumbnail ?? p.thumbnail_url ?? null,
        objects,
        settings: cloudSettings ?? local?.settings ?? { envIntensity: 1, shadows: true },
        materials: ((mats ?? []) as Record<string, unknown>[]).map((m) => ({
          ...defaultMaterial((m.name as string) ?? 'Material'),
          id: m.id as string,
          baseColor: (m.base_color as string) ?? '#8b9bb4',
          metalness: Number(m.metalness ?? 0.1), roughness: Number(m.roughness ?? 0.7),
          emissive: (m.emissive as string) ?? '#000000', emissiveIntensity: Number(m.emissive_intensity ?? 0),
          opacity: Number(m.opacity ?? 1), transparent: Boolean(m.transparent),
          side: ((m.side as string) ?? 'front') as 'front' | 'double',
          flatShading: Boolean(m.flat_shading),
          mapAssetId: (m.map_asset_id as string) ?? null,
          // extended PBR fields, when the cloud row carries them
          normalMapAssetId: (m.normal_map_asset_id as string) ?? null,
          normalScale: Number(m.normal_scale ?? 1),
          aoMapAssetId: (m.ao_map_asset_id as string) ?? null,
          aoIntensity: Number(m.ao_intensity ?? 1),
          transmission: Number(m.transmission ?? 0),
          ior: Number(m.ior ?? 1.5),
          thickness: Number(m.thickness ?? 0.5),
          clearcoat: Number(m.clearcoat ?? 0),
          clearcoatRoughness: Number(m.clearcoat_roughness ?? 0.1),
          updatedAt: (m.updated_at as string) ?? nowIso(),
        })),
        clips,
        collections: local?.collections ?? [],
        cameraBookmarks: local?.cameraBookmarks ?? [],
        activity: local?.activity ?? [],
        uiLayout: local?.uiLayout ?? null,
        assets: ((assets ?? []) as Record<string, unknown>[]).map((a) => ({
          id: a.id as string, name: (a.name as string) ?? 'asset', kind: ((a.kind as string) ?? 'other') as 'model' | 'texture' | 'other',
          mime: (a.mime as string) ?? '', size: Number(a.size_bytes ?? 0),
          storagePath: (a.storage_path as string) ?? null, local: false, thumb: null, createdAt: (a.created_at as string) ?? nowIso(),
        })),
        activeClipId: local?.activeClipId ?? clips[0]?.id ?? null,
        scripts: Array.isArray(sceneData.scripts) ? (sceneData.scripts as ProjectDoc['scripts']) : (local?.scripts ?? []),
        updatedAt: p.updated_at, version: p.version, cloudVersion: p.version,
      };
    } catch (e) {
      console.warn('cloud pull failed', e);
      // A local copy keeps offline-first sessions working. Without one — e.g.
      // a freshly clicked invite link — surface the real cause instead of
      // returning null, which the caller would misreport as "Project not found".
      const local = await localDb.getProject(projectId);
      if (local) return local;
      throw new Error(cloudErrorMessage(e));
    }
  }

  private static rowToObject(r: Record<string, unknown>): SceneObjectData {
    const num3 = (v: unknown, fb: [number, number, number]): [number, number, number] =>
      Array.isArray(v) && v.length === 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : fb;
    const pos = num3(r.position, [0, 0, 0]);
    const rot = num3(r.rotation, [0, 0, 0]);
    const scl = num3(r.scale, [1, 1, 1]);
    const geo = (r.geometry ?? null) as {
      kind?: SceneObjectData['type']; params?: Record<string, number>; light?: SceneObjectData['light'];
    } | null;
    return {
      id: r.id as string, name: (r.name as string) ?? 'Object',
      type: ((r.object_type as string) ?? 'cube') as SceneObjectData['type'],
      position: { x: pos[0], y: pos[1], z: pos[2] },
      rotation: { x: rot[0], y: rot[1], z: rot[2] },
      scale: { x: scl[0], y: scl[1], z: scl[2] },
      visible: r.visible !== false, locked: r.locked === true,
      parentId: (r.parent_id as string) ?? null,
      materialId: (r.material_id as string) ?? null,
      primitive: geo && geo.kind && geo.kind !== 'light'
        ? { kind: geo.kind as SceneObjectData['primitive'] extends { kind: infer K } | undefined ? K : never, params: geo.params ?? {} }
        : undefined,
      light: geo?.light ?? undefined,
      assetId: (r.asset_id as string) ?? null,
      updatedAt: (r.updated_at as string) ?? nowIso(),
      version: Number(r.version ?? 1),
    };
  }

  async flushQueue(): Promise<void> {
    if (!this.ready() || this.session.pendingRecovery) return;
    const ops = await localDb.listQueue(this.session.doc.id);
    if (!ops.length) return;
    // IndexedDB returns primary-key order, NOT chronological order. Prefer the
    // current local document when offline edits are newer than a queued snapshot.
    const latest = [...ops].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[ops.length - 1];
    const queued = latest.payload as ProjectDoc;
    const current = this.session.doc;
    const ok = await this.pushDoc(queued.updatedAt > current.updatedAt ? queued : current);
    if (ok) await localDb.clearQueue(ops.map((o) => o.id));
  }

  // ---------- assets ----------
  async uploadAsset(
    assetId: string, name: string, buf: ArrayBuffer,
    opts?: { kind?: 'model' | 'texture' | 'other'; mime?: string; ext?: string },
  ): Promise<void> {
    if (!this.ready()) return;
    try {
      const sb = supabase();
      const doc = this.session.doc;
      const kind = opts?.kind ?? 'model';
      const mime = opts?.mime ?? 'model/gltf-binary';
      const ext = opts?.ext ?? 'glb';
      const path = `${doc.id}/${assetId}.${ext}`;
      const { error } = await sb.storage.from('assets').upload(path, new Blob([buf], { type: mime }), { upsert: true, contentType: mime });
      if (error) throw error;
      await sb.from('assets').upsert({
        id: assetId, project_id: doc.id, name, kind,
        mime, size_bytes: buf.byteLength, storage_path: path,
      }).throwOnError();
      const meta = doc.assets.find((a) => a.id === assetId);
      if (meta) meta.storagePath = path;
    } catch (e) {
      console.warn('asset upload failed', e);
    }
  }

  /** Look up a storage path for an asset id (for late-joining peers). */
  async fetchAssetPath(assetId: string): Promise<string | null> {
    if (!cloudEnabled) return null;
    try {
      const { data } = await supabase().from('assets').select('storage_path').eq('id', assetId).maybeSingle();
      return ((data as { storage_path: string | null } | null)?.storage_path) ?? null;
    } catch {
      return null;
    }
  }

  async downloadAsset(storagePath: string): Promise<ArrayBuffer | null> {
    if (!cloudEnabled) return null;
    try {
      const { data, error } = await supabase().storage.from('assets').download(storagePath);
      if (error || !data) return null;
      return await data.arrayBuffer();
    } catch {
      return null;
    }
  }

  // ---------- realtime ----------
  private subscribe(): void {
    const me = this.session.user();
    this.channel = supabase()
      .channel(`project:${this.session.doc.id}`, { config: { private: true, broadcast: { self: false }, presence: { key: me.id } } })
      .on('broadcast', { event: 'transform' }, ({ payload }) => {
        const m = payload as TransformMsg;
        if (m.actor === me.id) return;
        this.session.applyRemoteTransform({
          id: m.objectId, name: '', type: 'cube', position: m.position, rotation: m.rotation,
          scale: m.scale, visible: true, locked: false, parentId: null, materialId: null,
          updatedAt: nowIso(), version: m.version,
        });
      })
      .on('broadcast', { event: 'ops' }, ({ payload }) => {
        const m = payload as OpMsg;
        if (m.actor === me.id) return;
        this.session.applyRemoteOp(m.op, m.data);
      })
      .on('broadcast', { event: 'material' }, ({ payload }) => {
        const m = payload as { data: MaterialData; actor: string };
        if (m.actor === me.id) return;
        this.session.applyRemoteMaterial(m.data);
      })
      .on('broadcast', { event: 'selection' }, ({ payload }) => {
        const p = payload as { ids: string[]; actor: string; user: { id: string; name: string; color: string } };
        if (!p || p.actor === this.session.user().id) return;
        this.session.peerSelections.update((prev) => {
          const next = new Map(prev);
          next.set(p.user.id, { ids: p.ids ?? [], name: p.user.name, color: p.user.color });
          return next;
        });
      })
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        const p = payload as { x: number; y: number; actor: string; user: { id: string; name: string; color: string } };
        if (!p || p.actor === this.session.user().id) return;
        this.session.peerCursors.update((prev) => {
          const next = new Map(prev);
          next.set(p.user.id, { x: p.x, y: p.y, name: p.user.name, color: p.user.color, at: Date.now() });
          return next;
        });
      })
      .on('broadcast', { event: 'activity' }, ({ payload }) => {
        const p = payload as { entry: import('../state/models.js').ActivityEntry; actor: string };
        if (!p || p.actor === this.session.user().id) return;
        this.session.pushActivity(p.entry, false);
      })
      .on('broadcast', { event: 'lock' }, ({ payload }) => {
        const m = payload as LockMsg;
        if (m.user.id === me.id) return;
        const locks = new Map(this.session.locks.get());
        if (m.action === 'acquire') {
          locks.set(m.objectId, { id: m.user.id, name: m.user.name, color: m.user.color, editingObjectId: m.objectId, editingObjectName: m.name, onlineAt: nowIso() });
        } else {
          const cur = locks.get(m.objectId);
          if (cur?.id === m.user.id) locks.delete(m.objectId);
        }
        this.session.locks.set(locks);
      })
      .on('presence', { event: 'sync' }, () => {
        const state = this.channel?.presenceState() ?? {};
        const users: PresenceUser[] = [];
        for (const presences of Object.values(state)) {
          for (const p of presences as unknown as Record<string, unknown>[]) {
            users.push({
              id: (p.id ?? '') as string, name: (p.name ?? 'Artist') as string,
              color: (p.color ?? '#888') as string,
              editingObjectId: (p.editingObjectId as string) ?? null,
              editingObjectName: (p.editingObjectName as string) ?? null,
              onlineAt: (p.onlineAt as string) ?? nowIso(),
            });
          }
        }
        this.session.peers.set(users);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void this.channel?.track({
            id: me.id, name: this.session.user().name, color: this.selfColor,
            editingObjectId: null, editingObjectName: null, onlineAt: nowIso(),
          });
        }
      });
  }

  presenceEditing(objectId: string | null, name: string | null): void {
    if (!this.channel) return;
    const me = this.session.user();
    void this.channel.track({
      id: me.id, name: me.name, color: this.selfColor,
      editingObjectId: objectId, editingObjectName: name, onlineAt: nowIso(),
    });
  }

  broadcastTransform(o: SceneObjectData): void {
    if (!this.channel || !this.session.canEdit.get()) return;
    const me = this.session.user();
    void this.channel.send({
      type: 'broadcast', event: 'transform',
      payload: { objectId: o.id, position: o.position, rotation: o.rotation, scale: o.scale, version: o.version, actor: me.id } satisfies TransformMsg,
    });
  }

  broadcastOp(op: OpMsg['op'], data: OpMsg['data']): void {
    if (!this.channel || !this.session.canEdit.get()) return;
    void this.channel.send({ type: 'broadcast', event: 'ops', payload: { op, data, actor: this.session.user().id } satisfies OpMsg });
  }

  broadcastMaterial(m: MaterialData): void {
    if (!this.channel || !this.session.canEdit.get()) return;
    void this.channel.send({ type: 'broadcast', event: 'material', payload: { data: m, actor: this.session.user().id } });
  }

  /** Share what we have selected so peers see coloured selection indicators. */
  broadcastSelection(ids: string[]): void {
    if (!this.channel) return;
    const u = this.session.user();
    void this.channel.send({
      type: 'broadcast', event: 'selection',
      payload: { ids, actor: u.id, user: { id: u.id, name: u.name, color: this.selfColor } },
    });
  }

  /** Live pointer position in normalised device coordinates (live cursors). */
  broadcastCursor(x: number, y: number): void {
    if (!this.channel) return;
    const u = this.session.user();
    void this.channel.send({
      type: 'broadcast', event: 'cursor',
      payload: { x, y, actor: u.id, user: { id: u.id, name: u.name, color: this.selfColor } },
    });
  }

  /** Share an activity-feed entry (adds, deletes, saves…). */
  broadcastActivity(entry: import('../state/models.js').ActivityEntry): void {
    if (!this.channel) return;
    const u = this.session.user();
    void this.channel.send({ type: 'broadcast', event: 'activity', payload: { entry, actor: u.id } });
  }

  broadcastLock(objectId: string, name: string | null, acquire: boolean): void {
    if (!this.channel || !this.session.canEdit.get()) return;
    const me = this.session.user();
    void this.channel.send({
      type: 'broadcast', event: 'lock',
      payload: { objectId, name, action: acquire ? 'acquire' : 'release', user: { id: me.id, name: me.name, color: this.selfColor } } satisfies LockMsg,
    });
    // locally mirror own lock so gizmo state is consistent
    const locks = new Map(this.session.locks.get());
    if (acquire) {
      locks.set(objectId, { id: me.id, name: me.name, color: this.selfColor, editingObjectId: objectId, editingObjectName: name, onlineAt: nowIso() });
    } else if (locks.get(objectId)?.id === me.id) {
      locks.delete(objectId);
    }
    this.session.locks.set(locks);
  }

  private sweepLocks(): void {
    const locks = new Map(this.session.locks.get());
    let changed = false;
    const now = Date.now();
    for (const [id, l] of locks) {
      if (l.id !== this.session.user().id && now - new Date(l.onlineAt).getTime() > 45000) {
        locks.delete(id);
        changed = true;
      }
    }
    if (changed) this.session.locks.set(locks);
  }

  // ---------- versions ----------
  async createCheckpoint(label: string): Promise<boolean> {
    if (!this.ready()) {
      this.session.notice('warn', 'Checkpoints need cloud connection');
      return false;
    }
    try {
      const doc = this.session.doc;
      const { data } = await supabase().from('project_versions')
        .select('version').eq('project_id', doc.id).order('version', { ascending: false }).limit(1).maybeSingle();
      const next = (((data as { version: number } | null)?.version) ?? 0) + 1;
      const { error } = await supabase().from('project_versions').insert({
        project_id: doc.id, version: next, label,
        snapshot: JSON.parse(JSON.stringify({ objects: doc.objects, materials: doc.materials, clips: doc.clips, scripts: doc.scripts })),
        created_by: auth.user.get()?.id ?? null,
      });
      if (error) throw error;
      await supabase().from('project_changes').insert({
        project_id: doc.id, user_id: auth.user.get()?.id ?? null,
        kind: 'checkpoint', summary: label || `Version ${next}`,
      });
      return true;
    } catch (e) {
      console.warn('checkpoint failed', e);
      return false;
    }
  }

  async listVersions(): Promise<{ id: string; version: number; label: string | null; createdAt: string; by: string | null }[]> {
    if (!this.ready()) return [];
    const { data } = await supabase().from('project_versions')
      .select('id,version,label,created_at,created_by').eq('project_id', this.session.doc.id).order('version', { ascending: false }).limit(30);
    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string, version: r.version as number, label: (r.label as string) ?? null,
      createdAt: (r.created_at as string) ?? '', by: (r.created_by as string) ?? null,
    }));
  }

  async restoreVersion(id: string): Promise<boolean> {
    if (!this.ready()) return false;
    const { data } = await supabase().from('project_versions').select('snapshot,label,version').eq('id', id).single();
    if (!data) return false;
    const d = data as { snapshot: { objects: ProjectDoc['objects']; materials: ProjectDoc['materials']; clips: ProjectDoc['clips']; scripts?: ProjectDoc['scripts'] }; label: string | null; version: number };
    this.session.restoreSnapshot(d.snapshot, d.label || `v${d.version}`);
    return true;
  }

  // ---------- members ----------
  async listMembers(): Promise<{ userId: string; role: TeamRole; name: string | null }[]> {
    if (!this.ready()) return [];
    const { data } = await supabase().from('project_members').select('user_id,role').eq('project_id', this.session.doc.id);
    const rows = (data ?? []) as { user_id: string; role: TeamRole }[];
    const { data: profiles } = await supabase().from('profiles').select('id,display_name').in('id', rows.map((r) => r.user_id));
    const names = new Map(((profiles ?? []) as { id: string; display_name: string | null }[]).map((p) => [p.id, p.display_name]));
    return rows.map((r) => ({ userId: r.user_id, role: r.role, name: names.get(r.user_id) ?? null }));
  }

  async setRole(userId: string, role: TeamRole): Promise<boolean> {
    if (!this.ready()) return false;
    const { error } = await supabase().from('project_members').update({ role }).eq('project_id', this.session.doc.id).eq('user_id', userId);
    return !error;
  }

  async removeMember(userId: string): Promise<boolean> {
    if (!this.ready()) return false;
    const { error } = await supabase().from('project_members').delete().eq('project_id', this.session.doc.id).eq('user_id', userId);
    return !error;
  }

  async addMemberById(userId: string, role: TeamRole): Promise<string | null> {
    if (!this.ready()) return 'Cloud unavailable';
    const { error } = await supabase().from('project_members').insert({ project_id: this.session.doc.id, user_id: userId, role });
    return error ? error.message : null;
  }

  async getInviteCode(): Promise<string | null> {
    if (!this.ready()) return null;
    const { data } = await supabase().from('projects').select('invite_code').eq('id', this.session.doc.id).single();
    return ((data as { invite_code: string | null } | null)?.invite_code) ?? null;
  }

  async rotateInviteCode(): Promise<string | null> {
    if (!this.ready()) return null;
    const code = uid().slice(0, 8);
    const { error } = await supabase().from('projects').update({ invite_code: code }).eq('id', this.session.doc.id);
    return error ? null : code;
  }

  static async joinWithCode(projectId: string, code: string): Promise<string | null> {
    if (!cloudEnabled) return 'Cloud unavailable';
    const { error } = await supabase().rpc('join_project', { p_project_id: projectId, p_code: code });
    // Map through cloudErrorMessage so a missing RPC (PGRST202) or incomplete
    // schema says "run the migrations" instead of a raw PostgREST message.
    return error ? cloudErrorMessage(error) : null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.lockSweep) clearInterval(this.lockSweep);
    if (this.channel) {
      // release own locks + untrack
      const me = this.session.user();
      for (const [id, l] of this.session.locks.get()) {
        if (l.id === me.id) {
          void this.channel.send({
            type: 'broadcast', event: 'lock',
            payload: { objectId: id, name: null, action: 'release', user: { id: me.id, name: me.name, color: this.selfColor } } satisfies LockMsg,
          });
        }
      }
      void this.channel.untrack();
      void supabase().removeChannel(this.channel);
      this.channel = null;
    }
  }
}
