// Agent API — lets an AI agent (local script, browser extension, iframe, or the
// optional relay server) list projects and make changes: objects, materials,
// textures, 3D models, animation keyframes, history and saves.
//
// Works two ways:
// - LIVE: an editor is open → mutations go through EditorSession (viewport,
//   undo/redo, realtime sync all work).
// - HEADLESS: no editor open → mutations apply to the IndexedDB copy directly
//   (loads in full when the project is opened; cloud sync runs on open).
import {
  createProjectDoc, defaultClip, defaultLight, defaultMaterial, defaultObject, normalizeDoc,
  type AnimTrack, type LightKind, type MaterialData, type ObjectType, type PrimitiveType,
  type ProjectDoc, type ProjectMode, type SceneObjectData,
} from '../state/models.js';
import { localDb } from '../lib/indexeddb.js';
import { uid, nowIso } from '../lib/utils.js';
import { toAiContext, toProjectJson, toSceneJson } from '../editor/serialization.js';
import { deleteKeyframeAt, setKeyframe, trackValueOf } from '../editor/animation.js';
import { analyzeScene, planPaint, planTidy } from './scene-iq.js';
import { answerLocally } from './local-answer.js';
import { aiSettings, logActivity, verifyAgentToken } from './settings.js';
import { generateImageSmart, generateMeshSmart, getChatProvider } from './factory.js';
import { texturePrompt } from './pollinations.js';
import { blobToDataUrl } from './providers.js';
import type { AgentScope, AgentSessionLike, AgentTokenMeta, AgentTransport } from './types.js';

export const AGENT_API_VERSION = '1.0.0';

export class AgentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export interface AgentContext {
  actor: string;
  transport: AgentTransport;
  token: AgentTokenMeta | null;
}

export interface AgentMethodInfo {
  name: string;
  scope: AgentScope | 'none';
  summary: string;
}

type Params = Record<string, unknown>;

// ---------- validation helpers ----------

function str(p: Params, key: string, required = true, max = 500): string {
  const v = p[key];
  if (v === undefined || v === null) {
    if (!required) return '';
    throw new AgentError('VALIDATION', `Missing required parameter "${key}".`);
  }
  if (typeof v !== 'string' || !v.trim()) throw new AgentError('VALIDATION', `Parameter "${key}" must be a non-empty string.`);
  if (v.length > max) throw new AgentError('VALIDATION', `Parameter "${key}" exceeds ${max} characters.`);
  return v;
}

function optStr(p: Params, key: string, max = 500): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AgentError('VALIDATION', `Parameter "${key}" must be a string.`);
  if (v.length > max) throw new AgentError('VALIDATION', `Parameter "${key}" exceeds ${max} characters.`);
  return v;
}

function num(p: Params, key: string, required = true, min = -1e6, max = 1e6): number {
  const v = p[key];
  if (v === undefined || v === null) {
    if (!required) return 0;
    throw new AgentError('VALIDATION', `Missing required parameter "${key}".`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new AgentError('VALIDATION', `Parameter "${key}" must be a number.`);
  if (v < min || v > max) throw new AgentError('VALIDATION', `Parameter "${key}" is out of range.`);
  return v;
}

function vec(p: Params, key: string): { x?: number; y?: number; z?: number } | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new AgentError('VALIDATION', `Parameter "${key}" must be {x?,y?,z?}.`);
  const out: { x?: number; y?: number; z?: number } = {};
  for (const axis of ['x', 'y', 'z'] as const) {
    const n = (v as Record<string, unknown>)[axis];
    if (n !== undefined) {
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new AgentError('VALIDATION', `Parameter "${key}.${axis}" must be a number.`);
      out[axis] = Math.max(-1e6, Math.min(1e6, n));
    }
  }
  return out;
}

function bool(p: Params, key: string, fallback = false): boolean {
  const v = p[key];
  return v === undefined ? fallback : v === true;
}

const PRIMITIVES: PrimitiveType[] = ['cube', 'sphere', 'cylinder', 'cone', 'plane', 'torus'];
const LIGHT_KINDS: LightKind[] = ['point', 'directional', 'spot', 'ambient', 'hemisphere'];

function shortDoc(doc: ProjectDoc): Record<string, unknown> {
  return {
    id: doc.id,
    name: doc.name,
    mode: doc.mode,
    version: doc.version,
    updatedAt: doc.updatedAt,
    objects: doc.objects.length,
    materials: doc.materials.length,
    clips: doc.clips.length,
    assets: doc.assets.length,
  };
}

// ---------- headless doc mutation (no editor open) ----------

function touchDoc(doc: ProjectDoc): void {
  doc.version++;
  doc.updatedAt = nowIso();
}

function findObject(doc: ProjectDoc, id: string): SceneObjectData {
  const o = doc.objects.find((x) => x.id === id);
  if (!o) throw new AgentError('NOT_FOUND', `Object ${id} not found in project ${doc.name}.`);
  return o;
}

function findMaterial(doc: ProjectDoc, id: string): MaterialData {
  const m = doc.materials.find((x) => x.id === id);
  if (!m) throw new AgentError('NOT_FOUND', `Material ${id} not found.`);
  return m;
}

function uniqueName(doc: ProjectDoc, base: string): string {
  const names = new Set(doc.objects.map((o) => o.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function headlessAdd(doc: ProjectDoc, type: ObjectType, name: string): SceneObjectData {
  const o = defaultObject(type, uniqueName(doc, name));
  if (type !== 'group' && type !== 'light' && type !== 'imported') {
    o.materialId = doc.materials[0]?.id ?? null;
  }
  doc.objects.push(o);
  touchDoc(doc);
  return o;
}

// =====================================================================
export class AgentAPI {
  private getSession: () => AgentSessionLike | null;
  private rate = new Map<string, number[]>();

  constructor(getSession: () => AgentSessionLike | null) {
    this.getSession = getSession;
  }

  methods(): AgentMethodInfo[] {
    return (Object.keys(METHOD_SCOPES) as AgentMethod[]).map((name) => ({
      name,
      scope: METHOD_SCOPES[name],
      summary: METHOD_DOCS[name] ?? '',
    }));
  }

  /** Direct call for trusted in-page code (UI, relay loop after its own auth). */
  async call(method: string, params: Params = {}, ctx: AgentContext): Promise<unknown> {
    const fn = (this as unknown as Record<string, (p: Params, c: AgentContext) => Promise<unknown>>)[`m_${method.replace(/\./g, '_')}`];
    if (typeof fn !== 'function') throw new AgentError('NOT_FOUND', `Unknown method "${method}". See agent.capabilities.`);
    return fn.call(this, params, ctx);
  }

  /** Token-authenticated entry for external transports. */
  async authorizedCall(
    method: string,
    params: Params,
    transport: AgentTransport,
    tokenSecret: string | null,
  ): Promise<unknown> {
    const started = performance.now();
    const s = aiSettings.get();
    let actor = `${transport}:anonymous`;
    let projectId: string | null = typeof params?.projectId === 'string' ? (params.projectId as string) : null;
    const fail = (e: unknown): never => {
      const err = e instanceof AgentError ? e : new AgentError('INTERNAL', (e as Error).message || 'Internal error');
      logActivity({ actor, method, projectId, ok: false, ms: Math.round(performance.now() - started), error: `${err.code}: ${err.message}` });
      throw err;
    };
    if (!s.agent.enabled) return fail(new AgentError('AUTH_DISABLED', 'Agent API is disabled — enable it in ✨ AI → Agent API.'));
    const scope = METHOD_SCOPES[method as AgentMethod];
    if (!scope) return fail(new AgentError('NOT_FOUND', `Unknown method "${method}".`));
    let token: AgentTokenMeta | null = null;
    if (scope !== 'none') {
      if (!tokenSecret) return fail(new AgentError('AUTH_REQUIRED', 'This method needs a Bearer API token.'));
      try {
        token = await verifyAgentToken(tokenSecret);
      } catch {
        token = null;
      }
      if (!token) return fail(new AgentError('AUTH_INVALID', 'Invalid or expired API token.'));
      if (!token.scopes.includes(scope)) {
        return fail(new AgentError('FORBIDDEN_SCOPE', `Token "${token.label}" lacks the "${scope}" scope.`));
      }
      actor = `${transport}:${token.label}`;
      this.checkRate(token.id, actor, s.agent.rateLimitPerMin);
    } else {
      actor = `${transport}:public`;
    }
    try {
      const result = await this.call(method, params, { actor, transport, token });
      logActivity({ actor, method, projectId, ok: true, ms: Math.round(performance.now() - started) });
      return result;
    } catch (e) {
      return fail(e);
    }
  }

  private checkRate(key: string, actor: string, perMin: number): void {
    const now = Date.now();
    const window = (this.rate.get(key) ?? []).filter((t) => now - t < 60000);
    if (window.length >= perMin) {
      throw new AgentError('RATE_LIMITED', `Rate limit exceeded for ${actor} (${perMin}/min). Slow down and retry.`);
    }
    window.push(now);
    this.rate.set(key, window);
  }

  // ---------- project resolution ----------

  private liveSession(): AgentSessionLike | null {
    try {
      return this.getSession();
    } catch {
      return null;
    }
  }

  /** Live session when it already has the project open, else headless IO. */
  private async resolve(projectId?: string): Promise<
    | { mode: 'live'; session: AgentSessionLike; doc: ProjectDoc }
    | { mode: 'headless'; session: null; doc: ProjectDoc }
  > {
    const live = this.liveSession();
    if (projectId) {
      if (live && live.doc.id === projectId) return { mode: 'live', session: live, doc: live.doc };
      const doc = await localDb.getProject(projectId);
      if (!doc) throw new AgentError('NOT_FOUND', `Project ${projectId} not found on this device.`);
      return { mode: 'headless', session: null, doc: normalizeDoc(doc) };
    }
    if (live) return { mode: 'live', session: live, doc: live.doc };
    throw new AgentError('NO_SESSION', 'No project is open — pass "projectId" (see project.list).');
  }

  private async persist(t: { mode: string; session: AgentSessionLike | null; doc: ProjectDoc }, kind: string): Promise<void> {
    if (t.mode === 'live' && t.session) {
      t.session.markDirty(kind);
      return;
    }
    await localDb.saveProject(t.doc);
  }

  // ===================================================================
  // methods: agent.*
  // ===================================================================

  private async m_agent_ping(): Promise<unknown> {
    return { ok: true, version: AGENT_API_VERSION, time: nowIso(), sessionOpen: !!this.liveSession() };
  }

  private async m_agent_capabilities(): Promise<unknown> {
    const s = aiSettings.get();
    return {
      version: AGENT_API_VERSION,
      methods: this.methods(),
      sessionOpen: !!this.liveSession(),
      sessionProjectId: this.liveSession()?.doc.id ?? null,
      providers: {
        chat: s.assistantProvider,
        image: s.imageProvider,
        mesh: s.meshProvider,
      },
      transports: ['page', 'postmessage', 'channel', 'relay'],
    };
  }

  private async m_agent_activity(p: Params): Promise<unknown> {
    const limit = Math.max(1, Math.min(120, (p.limit as number) || 20));
    return { entries: aiSettings.get().activity.slice(-limit).reverse() };
  }

  // ===================================================================
  // methods: project.*
  // ===================================================================

  private async m_project_list(): Promise<unknown> {
    const docs = await localDb.listProjects();
    return {
      projects: docs
        .map(shortDoc)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    };
  }

  private async m_project_get(p: Params): Promise<unknown> {
    const t = await this.resolve(str(p, 'id', true, 120));
    return { mode: t.mode, project: t.doc };
  }

  private async m_project_create(p: Params): Promise<unknown> {
    const name = str(p, 'name', true, 80);
    const mode = (optStr(p, 'mode', 10) ?? 'solo') as ProjectMode;
    if (mode !== 'solo' && mode !== 'team') throw new AgentError('VALIDATION', 'mode must be "solo" or "team".');
    const doc = createProjectDoc(name, mode, 'agent');
    await localDb.saveProject(doc);
    return { project: doc };
  }

  private async m_project_update(p: Params): Promise<unknown> {
    const t = await this.resolve(str(p, 'id', true, 120));
    const name = optStr(p, 'name', 80);
    if (name) t.doc.name = name;
    await this.persist(t, 'rename');
    return { mode: t.mode, project: shortDoc(t.doc) };
  }

  private async m_project_delete(p: Params): Promise<unknown> {
    const id = str(p, 'id', true, 120);
    const live = this.liveSession();
    if (live && live.doc.id === id) {
      throw new AgentError('VALIDATION', 'Close the project in the editor before deleting it via the API.');
    }
    const doc = await localDb.getProject(id);
    if (!doc) throw new AgentError('NOT_FOUND', `Project ${id} not found.`);
    for (const a of doc.assets) {
      await localDb.deleteBlob(a.id).catch(() => undefined);
    }
    await localDb.deleteProject(id);
    return { deleted: id };
  }

  private async m_project_context(p: Params): Promise<unknown> {
    const id = optStr(p, 'projectId', 120) ?? optStr(p, 'id', 120);
    const t = await this.resolve(id || undefined);
    return { mode: t.mode, projectId: t.doc.id, context: toAiContext(t.doc) };
  }

  private async m_project_scene(p: Params): Promise<unknown> {
    const id = optStr(p, 'projectId', 120) ?? optStr(p, 'id', 120);
    const t = await this.resolve(id || undefined);
    return { mode: t.mode, project: toProjectJson(t.doc), scene: toSceneJson(t.doc) };
  }

  // ===================================================================
  // methods: object.*
  // ===================================================================

  private async m_object_list(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    return { mode: t.mode, projectId: t.doc.id, objects: t.doc.objects };
  }

  private resolveKind(p: Params): ObjectType | 'light' {
    const kind = str(p, 'kind', true, 20).toLowerCase();
    if ((PRIMITIVES as string[]).includes(kind)) return kind as PrimitiveType;
    if (kind === 'group' || kind === 'light') return kind;
    throw new AgentError('VALIDATION', `kind must be one of ${[...PRIMITIVES, 'group', 'light'].join(', ')}.`);
  }

  private async m_object_add(p: Params, _ctx: AgentContext): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const kind = this.resolveKind(p);
    const name = optStr(p, 'name', 80) ?? kind.charAt(0).toUpperCase() + kind.slice(1);
    let obj: SceneObjectData;
    if (t.mode === 'live' && t.session) {
      if (kind === 'group') obj = t.session.addGroup();
      else if (kind === 'light') {
        const lightKind = (optStr(p, 'lightKind', 20) ?? 'point') as LightKind;
        if (!LIGHT_KINDS.includes(lightKind)) throw new AgentError('VALIDATION', `lightKind must be one of ${LIGHT_KINDS.join(', ')}.`);
        obj = t.session.addLight(lightKind);
      } else obj = t.session.addPrimitive(kind as PrimitiveType);
      if (p.name !== undefined) t.session.renameObject(obj.id, name);
      const pos = vec(p, 'position');
      const scl = vec(p, 'scale');
      const rot = vec(p, 'rotationDeg');
      if (pos || scl || rot) t.session.setTransform(obj.id, pos, rot, scl);
      const color = optStr(p, 'color', 20);
      if (color) this.applyColorLive(t.session, obj, color);
    } else {
      obj = headlessAdd(t.doc, kind, name);
      if (kind === 'light') {
        const lightKind = (optStr(p, 'lightKind', 20) ?? 'point') as LightKind;
        if (!LIGHT_KINDS.includes(lightKind)) throw new AgentError('VALIDATION', `lightKind must be one of ${LIGHT_KINDS.join(', ')}.`);
        obj.light = { ...defaultLight(lightKind), kind: lightKind };
      }
      const pos = vec(p, 'position');
      const scl = vec(p, 'scale');
      const rot = vec(p, 'rotationDeg');
      if (pos) obj.position = { ...obj.position, ...pos };
      if (scl) obj.scale = { ...obj.scale, ...scl };
      if (rot) {
        const d = (deg: number): number => (deg * Math.PI) / 180;
        obj.rotation = {
          x: rot.x !== undefined ? d(rot.x) : obj.rotation.x,
          y: rot.y !== undefined ? d(rot.y) : obj.rotation.y,
          z: rot.z !== undefined ? d(rot.z) : obj.rotation.z,
        };
      }
      const color = optStr(p, 'color', 20);
      if (color) this.applyColorHeadless(t.doc, obj, color);
      await this.persist(t, 'add');
    }
    return { mode: t.mode, object: obj };
  }

  private applyColorLive(session: AgentSessionLike, obj: SceneObjectData, color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AgentError('VALIDATION', 'color must be a hex string like "#ff8800".');
    const mat = session.addMaterial();
    session.updateMaterial(mat.id, { name: `${obj.name} color`, baseColor: color });
    session.assignMaterial(obj.id, mat.id);
  }

  private applyColorHeadless(doc: ProjectDoc, obj: SceneObjectData, color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AgentError('VALIDATION', 'color must be a hex string like "#ff8800".');
    const mat = defaultMaterial(`${obj.name} color`);
    mat.baseColor = color;
    doc.materials.push(mat);
    obj.materialId = mat.id;
  }

  private async m_object_update(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const id = str(p, 'id', true, 120);
    const name = optStr(p, 'name', 80);
    const pos = vec(p, 'position');
    const scl = vec(p, 'scale');
    const rot = vec(p, 'rotationDeg');
    const visible = p.visible as boolean | undefined;
    const locked = p.locked as boolean | undefined;
    const materialId = p.materialId === null ? null : optStr(p, 'materialId', 120);
    const parentId = p.parentId === null ? null : optStr(p, 'parentId', 120);
    if (t.mode === 'live' && t.session) {
      findObject(t.doc, id); // 404 early with a clear error
      if (name !== undefined) t.session.renameObject(id, name);
      if (pos || scl || rot) t.session.setTransform(id, pos, rot, scl);
      const current = t.doc.objects.find((o) => o.id === id);
      if (visible !== undefined && current && current.visible !== visible) t.session.toggleVisible(id);
      if (locked !== undefined && current && current.locked !== locked) t.session.toggleLock(id);
      if (materialId !== undefined) t.session.assignMaterial(id, materialId);
      if (parentId !== undefined) t.session.setParent(id, parentId);
      const light = p.light as Partial<SceneObjectData['light']> | undefined;
      if (light && typeof light === 'object') t.session.updateLight(id, light as Partial<import('../state/models.js').LightData>);
      const color = optStr(p, 'color', 20);
      if (color) {
        const obj = t.doc.objects.find((o) => o.id === id);
        if (obj) this.applyColorLive(t.session, obj, color);
      }
    } else {
      const obj = findObject(t.doc, id);
      if (name !== undefined) obj.name = name;
      if (pos) obj.position = { ...obj.position, ...pos };
      if (scl) obj.scale = { ...obj.scale, ...scl };
      if (rot) {
        const d = (deg: number): number => (deg * Math.PI) / 180;
        obj.rotation = {
          x: rot.x !== undefined ? d(rot.x) : obj.rotation.x,
          y: rot.y !== undefined ? d(rot.y) : obj.rotation.y,
          z: rot.z !== undefined ? d(rot.z) : obj.rotation.z,
        };
      }
      if (visible !== undefined) obj.visible = visible;
      if (locked !== undefined) obj.locked = locked;
      if (materialId !== undefined) {
        if (materialId) findMaterial(t.doc, materialId);
        obj.materialId = materialId;
      }
      if (parentId !== undefined) {
        if (parentId === id) throw new AgentError('VALIDATION', 'An object cannot be its own parent.');
        if (parentId) findObject(t.doc, parentId);
        obj.parentId = parentId;
      }
      const light = p.light as Record<string, unknown> | undefined;
      if (light && typeof light === 'object' && obj.type === 'light' && obj.light) {
        for (const [k, v] of Object.entries(light)) {
          if (k in obj.light && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
            (obj.light as unknown as Record<string, unknown>)[k] = v;
          }
        }
      }
      const color = optStr(p, 'color', 20);
      if (color) this.applyColorHeadless(t.doc, obj, color);
      obj.version++;
      obj.updatedAt = nowIso();
      touchDoc(t.doc);
      await this.persist(t, 'edit');
    }
    const obj = t.doc.objects.find((o) => o.id === id);
    return { mode: t.mode, object: obj };
  }

  private async m_object_delete(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const id = str(p, 'id', true, 120);
    if (t.mode === 'live' && t.session) {
      findObject(t.doc, id);
      t.session.deleteObject(id);
    } else {
      findObject(t.doc, id);
      const ids = new Set([id, ...t.doc.objects.filter((o) => o.parentId === id).map((o) => o.id)]);
      t.doc.objects = t.doc.objects.filter((o) => !ids.has(o.id));
      touchDoc(t.doc);
      await this.persist(t, 'delete');
    }
    return { mode: t.mode, deleted: id };
  }

  private async m_object_duplicate(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const id = str(p, 'id', true, 120);
    if (t.mode === 'live' && t.session) {
      const before = new Set(t.session.doc.objects.map((o) => o.id));
      findObject(t.doc, id);
      t.session.duplicateObject(id);
      const copy = t.session.doc.objects.find((o) => !before.has(o.id));
      return { mode: t.mode, object: copy };
    }
    const src = findObject(t.doc, id);
    const copy: SceneObjectData = JSON.parse(JSON.stringify(src)) as SceneObjectData;
    copy.id = uid();
    copy.name = uniqueName(t.doc, `${src.name} copy`);
    copy.position = { ...src.position, x: src.position.x + 0.5 };
    copy.version = 1;
    t.doc.objects.push(copy);
    touchDoc(t.doc);
    await this.persist(t, 'add');
    return { mode: t.mode, object: copy };
  }

  // ===================================================================
  // methods: material.* / asset.* / clip.*
  // ===================================================================

  private async m_material_list(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    return { mode: t.mode, projectId: t.doc.id, materials: t.doc.materials };
  }

  private async m_material_add(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const name = optStr(p, 'name', 80);
    const patch = this.materialPatch(p);
    if (t.mode === 'live' && t.session) {
      const mat = t.session.addMaterial();
      t.session.updateMaterial(mat.id, { ...(name ? { name } : {}), ...patch });
      return { mode: t.mode, material: t.doc.materials.find((m) => m.id === mat.id) };
    }
    const mat = defaultMaterial(name ?? `Material ${t.doc.materials.length + 1}`);
    Object.assign(mat, patch, { updatedAt: nowIso() });
    t.doc.materials.push(mat);
    touchDoc(t.doc);
    await this.persist(t, 'material');
    return { mode: t.mode, material: mat };
  }

  private async m_material_update(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const id = str(p, 'id', true, 120);
    const patch = this.materialPatch(p);
    const name = optStr(p, 'name', 80);
    if (name) patch.name = name;
    if (t.mode === 'live' && t.session) {
      findMaterial(t.doc, id);
      t.session.updateMaterial(id, patch);
    } else {
      const mat = findMaterial(t.doc, id);
      Object.assign(mat, patch, { updatedAt: nowIso() });
      touchDoc(t.doc);
      await this.persist(t, 'material');
    }
    return { mode: t.mode, material: t.doc.materials.find((m) => m.id === id) };
  }

  private materialPatch(p: Params): Partial<MaterialData> {
    const patch: Partial<MaterialData> = {};
    const color = optStr(p, 'baseColor', 20) ?? optStr(p, 'color', 20);
    if (color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AgentError('VALIDATION', 'baseColor must be like "#ff8800".');
      patch.baseColor = color;
    }
    for (const key of ['metalness', 'roughness', 'emissiveIntensity', 'opacity'] as const) {
      if (p[key] !== undefined) {
        const v = p[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new AgentError('VALIDATION', `${key} must be a number.`);
        patch[key] = Math.max(0, Math.min(key === 'opacity' ? 1 : 2, v));
      }
    }
    const emissive = optStr(p, 'emissive', 20);
    if (emissive !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(emissive)) throw new AgentError('VALIDATION', 'emissive must be like "#ff8800".');
      patch.emissive = emissive;
    }
    if (p.transparent !== undefined) patch.transparent = bool(p, 'transparent');
    if (p.flatShading !== undefined) patch.flatShading = bool(p, 'flatShading');
    const side = optStr(p, 'side', 10);
    if (side !== undefined) {
      if (side !== 'front' && side !== 'double') throw new AgentError('VALIDATION', 'side must be "front" or "double".');
      patch.side = side;
    }
    return patch;
  }

  private async m_asset_list(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    return { mode: t.mode, projectId: t.doc.id, assets: t.doc.assets };
  }

  private async m_asset_import(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const name = str(p, 'name', true, 80);
    const dataBase64 = str(p, 'dataBase64', true, 40_000_000);
    if (dataBase64.length > 40_000_000) throw new AgentError('VALIDATION', 'dataBase64 exceeds ~30MB.');
    let bytes: Uint8Array;
    try {
      const bin = atob(dataBase64.replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      throw new AgentError('VALIDATION', 'dataBase64 is not valid base64.');
    }
    const buf = bytes.buffer as ArrayBuffer;
    if (t.mode === 'live' && t.session) {
      const obj = await t.session.importGlbBytes(name, buf, `${name}.glb`);
      if (!obj) throw new AgentError('VALIDATION', 'Bytes are not a valid GLB model.');
      return { mode: t.mode, object: obj };
    }
    const assetId = uid();
    await localDb.saveBlob(assetId, new Blob([buf], { type: 'model/gltf-binary' }));
    t.doc.assets.push({
      id: assetId, name: `${name}.glb`, kind: 'model', mime: 'model/gltf-binary',
      size: buf.byteLength, storagePath: null, local: true, thumb: null, createdAt: nowIso(),
    });
    const obj = headlessAdd(t.doc, 'imported', name);
    obj.assetId = assetId;
    await this.persist(t, 'add');
    return { mode: t.mode, object: obj };
  }

  private async m_clip_list(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    return { mode: t.mode, projectId: t.doc.id, activeClipId: t.doc.activeClipId, clips: t.doc.clips };
  }

  private async m_clip_add(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const clip = defaultClip(optStr(p, 'name', 80) ?? `Clip ${t.doc.clips.length + 1}`);
    t.doc.clips.push(clip);
    t.doc.activeClipId = clip.id;
    if (t.mode === 'live' && t.session) t.session.markDirty('animation');
    else {
      touchDoc(t.doc);
      await this.persist(t, 'animation');
    }
    return { mode: t.mode, clip };
  }

  private async m_keyframe_add(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const objectId = str(p, 'objectId', true, 120);
    const property = (optStr(p, 'property', 20) ?? 'position') as AnimTrack['property'];
    if (!['position', 'rotation', 'scale'].includes(property)) {
      throw new AgentError('VALIDATION', 'property must be position, rotation or scale.');
    }
    const frame = p.frame === undefined ? 0 : num(p, 'frame', true, 0, 2000);
    const obj = findObject(t.doc, objectId);
    let value = trackValueOf(obj, property);
    const triple = p.value as unknown;
    if (triple !== undefined) {
      if (!Array.isArray(triple) || triple.length !== 3 || !triple.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new AgentError('VALIDATION', 'value must be [x, y, z] numbers.');
      }
      value = triple as [number, number, number];
    }
    const clipId = optStr(p, 'clipId', 120);
    if (clipId && !t.doc.clips.some((c) => c.id === clipId)) throw new AgentError('NOT_FOUND', `Clip ${clipId} not found.`);
    if (clipId) t.doc.activeClipId = clipId;
    setKeyframe(t.doc, objectId, property, Math.round(frame), value);
    if (t.mode === 'live' && t.session) t.session.markDirty('animation');
    else {
      touchDoc(t.doc);
      await this.persist(t, 'animation');
    }
    return { mode: t.mode, objectId, property, frame: Math.round(frame), value };
  }

  private async m_keyframe_delete(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const objectId = str(p, 'objectId', true, 120);
    const property = (optStr(p, 'property', 20) ?? 'position') as AnimTrack['property'];
    const frame = num(p, 'frame', true, 0, 2000);
    deleteKeyframeAt(t.doc, objectId, property, Math.round(frame));
    if (t.mode === 'live' && t.session) t.session.markDirty('animation');
    else {
      touchDoc(t.doc);
      await this.persist(t, 'animation');
    }
    return { mode: t.mode, deleted: { objectId, property, frame: Math.round(frame) } };
  }

  // ===================================================================
  // methods: scene.* (AI understanding + full scene control)
  // ===================================================================

  private async m_scene_analyze(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const analysis = analyzeScene(t.doc);
    return {
      mode: t.mode,
      projectId: t.doc.id,
      summary: analysis.summary,
      groups: analysis.groups,
      paintable: t.doc.objects.filter((o) => o.type !== 'light').length,
    };
  }

  private async m_scene_autopaint(p: Params, ctx: AgentContext): Promise<unknown> {
    void ctx;
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const groupIds = Array.isArray(p.groupIds)
      ? (p.groupIds as unknown[]).filter((g): g is string => typeof g === 'string').slice(0, 50)
      : undefined;
    const plan = planPaint(t.doc, groupIds);
    if (!plan.length) {
      return { mode: t.mode, projectId: t.doc.id, applied: 0, groups: 0, note: 'No paintable parts with a recognized role.' };
    }
    if (t.mode === 'live' && t.session) {
      const applied = t.session.applyPaint(plan.map((item) => ({
        objectId: item.objectId,
        materialName: item.materialName,
        patch: item.patch,
      })));
      return {
        mode: t.mode,
        projectId: t.doc.id,
        applied: applied.length,
        groups: new Set(plan.map((i) => i.groupLabel)).size,
        plan: plan.map((i) => ({ objectId: i.objectId, objectName: i.objectName, role: i.role, color: i.patch.baseColor })),
      };
    }
    const byKey = new Map<string, MaterialData>();
    for (const item of plan) {
      const key = JSON.stringify(item.patch);
      let mat = byKey.get(key);
      if (!mat) {
        mat = defaultMaterial(item.materialName.slice(0, 60));
        Object.assign(mat, item.patch, { updatedAt: nowIso() });
        t.doc.materials.push(mat);
        byKey.set(key, mat);
      }
      const o = t.doc.objects.find((x) => x.id === item.objectId);
      if (o) {
        o.materialId = mat.id;
        o.version++;
      }
    }
    touchDoc(t.doc);
    await this.persist(t, 'material');
    return {
      mode: t.mode,
      projectId: t.doc.id,
      applied: plan.length,
      groups: new Set(plan.map((i) => i.groupLabel)).size,
      plan: plan.map((i) => ({ objectId: i.objectId, objectName: i.objectName, role: i.role, color: i.patch.baseColor })),
    };
  }

  private async m_scene_autotexture(p: Params, ctx: AgentContext): Promise<unknown> {
    const projectId = optStr(p, 'projectId', 120) || undefined;
    const t = await this.resolve(projectId);
    const groupIds = Array.isArray(p.groupIds)
      ? (p.groupIds as unknown[]).filter((g): g is string => typeof g === 'string').slice(0, 50)
      : undefined;
    const size = p.size === undefined ? 512 : num(p, 'size', true, 64, 1024);
    const maxTextures = p.maxTextures === undefined ? 4 : num(p, 'maxTextures', true, 1, 8);
    // Paint first so every role owns a material, then texture each role once.
    const paint = (await this.m_scene_autopaint({ projectId: t.doc.id, ...(groupIds ? { groupIds } : {}) }, ctx)) as {
      plan: { objectId: string; role: string }[];
    };
    const plan = planPaint(t.doc, groupIds);
    const seen = new Map<string, { materialId: string; prompt: string; role: string }>();
    const matOf = new Map<string, string>();
    if (t.mode === 'live') {
      for (const item of plan) {
        const o = t.doc.objects.find((x) => x.id === item.objectId);
        if (o?.materialId) matOf.set(item.objectId, o.materialId);
      }
    } else {
      const fresh = await localDb.getProject(t.doc.id);
      for (const item of plan) {
        const o = fresh?.objects.find((x) => x.id === item.objectId);
        if (o?.materialId) matOf.set(item.objectId, o.materialId);
      }
    }
    for (const item of plan) {
      if (!item.texturePrompt || seen.has(item.role)) continue;
      const materialId = matOf.get(item.objectId);
      if (!materialId) continue;
      seen.set(item.role, { materialId, prompt: item.texturePrompt, role: item.role });
      if (seen.size >= maxTextures) break;
    }
    const results: { role: string; materialId: string; provider: string; seed: number }[] = [];
    for (const entry of seen.values()) {
      const out = (await this.call('texture.generate', {
        projectId: t.doc.id,
        prompt: entry.prompt,
        materialId: entry.materialId,
        size,
        seamless: true,
      }, ctx)) as { provider: string; seed: number };
      results.push({ role: entry.role, materialId: entry.materialId, provider: out.provider, seed: out.seed });
    }
    return {
      mode: t.mode,
      projectId: t.doc.id,
      painted: (paint.plan ?? []).length,
      textured: results,
      note: results.length ? undefined : 'No roles with texture prompts (colors were still applied).',
    };
  }

  private async m_scene_tidy(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const spacing = p.spacing === undefined ? 3.5 : num(p, 'spacing', true, 1, 50);
    const plan = planTidy(t.doc, spacing);
    if (t.mode === 'live' && t.session) {
      t.session.checkpoint('Tidy scene');
      for (const item of plan.items) {
        t.session.setTransform(item.objectId, { x: item.x, z: item.z });
      }
    } else {
      for (const item of plan.items) {
        const o = t.doc.objects.find((x) => x.id === item.objectId);
        if (!o) continue;
        o.position = { ...o.position, x: item.x, z: item.z };
        o.version++;
      }
      touchDoc(t.doc);
      await this.persist(t, 'edit');
    }
    return { mode: t.mode, projectId: t.doc.id, arranged: plan.items.length, cols: plan.cols, spacing: plan.spacing };
  }

  // ===================================================================
  // methods: history / save / ai
  // ===================================================================

  private async m_history_undo(): Promise<unknown> {
    const live = this.liveSession();
    if (!live) throw new AgentError('NO_SESSION', 'Undo needs an open editor.');
    live.undo();
    return { ok: true };
  }

  private async m_history_redo(): Promise<unknown> {
    const live = this.liveSession();
    if (!live) throw new AgentError('NO_SESSION', 'Redo needs an open editor.');
    live.redo();
    return { ok: true };
  }

  private async m_save_now(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    if (t.mode === 'live' && t.session) await t.session.forceSave();
    else await localDb.saveProject(t.doc);
    return { mode: t.mode, saved: t.doc.id, version: t.doc.version };
  }

  private async m_ai_ask(p: Params): Promise<unknown> {
    const question = str(p, 'question', true, 4000);
    const id = optStr(p, 'projectId', 120) || undefined;
    const t = await this.resolve(id);
    const chat = getChatProvider();
    const context = toAiContext(t.doc).slice(0, 6000);
    try {
      const answer = await chat.chat([
        {
          role: 'system',
          content: `You are the Web 3D Studio assistant. Answer briefly about the user's 3D project below. When suggesting edits, name exact Agent API methods (object.add, object.update, material.update, ...).\n\n${context}`,
        },
        { role: 'user', content: question },
      ]);
      return { mode: t.mode, projectId: t.doc.id, answer };
    } catch (e) {
      // Cloud AI unreachable → still answer factual scene questions offline.
      const local = answerLocally(t.doc, question);
      if (local) return { mode: t.mode, projectId: t.doc.id, answer: local, offline: true };
      throw new AgentError('PROVIDER', (e as Error).message || 'Assistant unreachable.');
    }
  }

  // ===================================================================
  // methods: generate.*
  // ===================================================================

  private async m_image_generate(p: Params): Promise<unknown> {
    const prompt = str(p, 'prompt', true, 2000);
    const width = p.width === undefined ? 512 : num(p, 'width', true, 64, 2048);
    const height = p.height === undefined ? 512 : num(p, 'height', true, 64, 2048);
    const { result, fallback } = await generateImageSmart(prompt, {
      width, height,
      seed: p.seed === undefined ? undefined : num(p, 'seed', true, 0, 999999999),
      strict: bool(p, 'strict'),
    });
    return {
      dataUrl: await blobToDataUrl(result.blob),
      mime: result.mime,
      width: result.width,
      height: result.height,
      seed: result.seed,
      provider: result.provider,
      fallback,
    };
  }

  private async m_texture_generate(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const prompt = str(p, 'prompt', true, 1000);
    const seamless = p.seamless === undefined ? true : bool(p, 'seamless');
    const size = p.size === undefined ? 512 : num(p, 'size', true, 64, 2048);
    const materialId = optStr(p, 'materialId', 120);
    const { result, fallback } = await generateImageSmart(texturePrompt(prompt, seamless), {
      width: size, height: size, strict: bool(p, 'strict'),
    });
    const file = new File([result.blob], `${prompt.slice(0, 40) || 'texture'}.png`, { type: result.mime });
    if (t.mode === 'live' && t.session) {
      let matId = materialId;
      if (matId) findMaterial(t.doc, matId);
      else {
        const mat = t.session.addMaterial();
        t.session.updateMaterial(mat.id, { name: `${prompt.slice(0, 32) || 'AI texture'}` });
        matId = mat.id;
      }
      await t.session.uploadTexture(matId as string, file);
      return {
        mode: t.mode, materialId: matId, seed: result.seed,
        provider: result.provider, fallback,
        thumb: t.doc.materials.find((m) => m.id === matId)?.mapAssetId
          ? (t.doc.assets.find((a) => a.id === t.doc.materials.find((m) => m.id === matId)?.mapAssetId)?.thumb ?? null)
          : null,
      };
    }
    let matId = materialId;
    if (matId) findMaterial(t.doc, matId);
    else {
      const mat = defaultMaterial(`${prompt.slice(0, 32) || 'AI texture'}`);
      t.doc.materials.push(mat);
      matId = mat.id;
    }
    const assetId = uid();
    await localDb.saveBlob(assetId, result.blob);
    t.doc.assets.push({
      id: assetId, name: file.name, kind: 'texture', mime: result.mime,
      size: result.blob.size, storagePath: null, local: true, thumb: null, createdAt: nowIso(),
    });
    const mat = findMaterial(t.doc, matId as string);
    mat.mapAssetId = assetId;
    mat.updatedAt = nowIso();
    touchDoc(t.doc);
    await this.persist(t, 'material');
    return { mode: t.mode, materialId: matId, seed: result.seed, provider: result.provider, fallback };
  }

  private async m_model_generate(p: Params): Promise<unknown> {
    const t = await this.resolve(optStr(p, 'projectId', 120) || undefined);
    const prompt = str(p, 'prompt', true, 1000);
    const name = optStr(p, 'name', 80) ?? prompt.slice(0, 40) ?? 'AI model';
    const quality = (optStr(p, 'quality', 20) ?? 'balanced') as 'fast' | 'balanced' | 'high';
    if (!['fast', 'balanced', 'high'].includes(quality)) throw new AgentError('VALIDATION', 'quality must be fast, balanced or high.');
    const model = optStr(p, 'model', 20) as 'sf3d' | 'triposr' | undefined;
    if (model !== undefined && model !== 'sf3d' && model !== 'triposr') {
      throw new AgentError('VALIDATION', 'model must be "sf3d" (best) or "triposr" (fast).');
    }
    const outcome = await generateMeshSmart(prompt, { quality, strict: bool(p, 'strict'), model });
    if (outcome.kind === 'glb') {
      if (t.mode === 'live' && t.session) {
        const obj = await t.session.importGlbBytes(name, outcome.result.glb.slice(0), `${name}.glb`);
        if (!obj) throw new AgentError('PROVIDER', 'The generated file was not a valid 3D model.');
        return {
          mode: t.mode, object: obj, provider: outcome.result.provider,
          previewDataUrl: outcome.result.previewDataUrl ?? null, fallback: outcome.fallback,
        };
      }
      const assetId = uid();
      await localDb.saveBlob(assetId, new Blob([outcome.result.glb], { type: 'model/gltf-binary' }));
      t.doc.assets.push({
        id: assetId, name: `${name}.glb`, kind: 'model', mime: 'model/gltf-binary',
        size: outcome.result.glb.byteLength, storagePath: null, local: true, thumb: null, createdAt: nowIso(),
      });
      const obj = headlessAdd(t.doc, 'imported', name);
      obj.assetId = assetId;
      await this.persist(t, 'add');
      return { mode: t.mode, object: obj, provider: outcome.result.provider, fallback: outcome.fallback };
    }
    // Offline primitive plan → build via object ops (live or headless).
    const objectIds: string[] = [];
    if (t.mode === 'live' && t.session) {
      for (const part of outcome.parts) {
        const created = await this.call('object.add', {
          kind: part.kind,
          name: part.name,
          position: { x: part.position[0], y: part.position[1], z: part.position[2] },
          ...(part.scale ? { scale: { x: part.scale[0], y: part.scale[1], z: part.scale[2] } } : {}),
          ...(part.color ? { color: part.color } : {}),
        }, { actor: 'agent:procedural', transport: 'page', token: null }) as { object: SceneObjectData };
        objectIds.push(created.object.id);
      }
    } else {
      for (const part of outcome.parts) {
        const obj = headlessAdd(t.doc, part.kind, part.name);
        obj.position = { x: part.position[0], y: part.position[1], z: part.position[2] };
        if (part.scale) obj.scale = { x: part.scale[0], y: part.scale[1], z: part.scale[2] };
        if (part.color) this.applyColorHeadless(t.doc, obj, part.color);
        objectIds.push(obj.id);
      }
      await this.persist(t, 'add');
    }
    return {
      mode: t.mode, procedural: true, template: outcome.template,
      objectIds, provider: 'procedural-mesh', fallback: outcome.fallback,
    };
  }
}

// ---------- registry ----------

export type AgentMethod =
  | 'agent.ping' | 'agent.capabilities' | 'agent.activity'
  | 'project.list' | 'project.get' | 'project.create' | 'project.update' | 'project.delete'
  | 'project.context' | 'project.scene'
  | 'object.list' | 'object.add' | 'object.update' | 'object.delete' | 'object.duplicate'
  | 'material.list' | 'material.add' | 'material.update'
  | 'asset.list' | 'asset.import'
  | 'clip.list' | 'clip.add' | 'keyframe.add' | 'keyframe.delete'
  | 'scene.analyze' | 'scene.autopaint' | 'scene.autotexture' | 'scene.tidy'
  | 'history.undo' | 'history.redo' | 'save.now'
  | 'ai.ask' | 'image.generate' | 'texture.generate' | 'model.generate';

const METHOD_SCOPES: Record<AgentMethod, AgentScope | 'none'> = {
  'agent.ping': 'none',
  'agent.capabilities': 'none',
  'agent.activity': 'read',
  'project.list': 'read',
  'project.get': 'read',
  'project.create': 'write',
  'project.update': 'write',
  'project.delete': 'write',
  'project.context': 'read',
  'project.scene': 'read',
  'object.list': 'read',
  'object.add': 'write',
  'object.update': 'write',
  'object.delete': 'write',
  'object.duplicate': 'write',
  'material.list': 'read',
  'material.add': 'write',
  'material.update': 'write',
  'asset.list': 'read',
  'asset.import': 'write',
  'clip.list': 'read',
  'clip.add': 'write',
  'keyframe.add': 'write',
  'keyframe.delete': 'write',
  'scene.analyze': 'read',
  'scene.autopaint': 'write',
  'scene.autotexture': 'generate',
  'scene.tidy': 'write',
  'history.undo': 'write',
  'history.redo': 'write',
  'save.now': 'write',
  'ai.ask': 'generate',
  'image.generate': 'generate',
  'texture.generate': 'generate',
  'model.generate': 'generate',
};

const METHOD_DOCS: Record<AgentMethod, string> = {
  'agent.ping': 'Health check. No auth.',
  'agent.capabilities': 'List methods, providers and open project. No auth.',
  'agent.activity': 'Recent agent calls (audit log). Params: {limit?}.',
  'project.list': 'List projects on this device.',
  'project.get': 'Full project document. Params: {id}.',
  'project.create': 'Create a project. Params: {name, mode?}.',
  'project.update': 'Rename a project. Params: {id, name}.',
  'project.delete': 'Delete a closed project + its local blobs. Params: {id}.',
  'project.context': 'AI_PROJECT_CONTEXT.md summary. Params: {projectId?}.',
  'project.scene': 'project.json + scene.json graph. Params: {projectId?}.',
  'object.list': 'List scene objects. Params: {projectId?}.',
  'object.add': 'Add primitive/group/light. Params: {projectId?, kind, name?, position?, rotationDeg?, scale?, color?, lightKind?}.',
  'object.update': 'Patch object. Params: {projectId?, id, name?, position?, rotationDeg?, scale?, visible?, locked?, materialId?, parentId?, color?, light?}.',
  'object.delete': 'Delete object (+children). Params: {projectId?, id}.',
  'object.duplicate': 'Duplicate object. Params: {projectId?, id}.',
  'material.list': 'List materials. Params: {projectId?}.',
  'material.add': 'Add material. Params: {projectId?, name?, baseColor?, metalness?, roughness?, ...}.',
  'material.update': 'Patch material. Params: {projectId?, id, ...fields}.',
  'asset.list': 'List asset metadata. Params: {projectId?}.',
  'asset.import': 'Import GLB from base64. Params: {projectId?, name, dataBase64}.',
  'clip.list': 'List animation clips. Params: {projectId?}.',
  'clip.add': 'Add + activate a clip. Params: {projectId?, name?}.',
  'keyframe.add': 'Add keyframe. Params: {projectId?, objectId, property?, frame?, value?, clipId?}.',
  'keyframe.delete': 'Delete keyframe. Params: {projectId?, objectId, property?, frame}.',
  'scene.analyze': 'Identify models by group (chair, car…) + part roles. Params: {projectId?}.',
  'scene.autopaint': 'Apply coherent colors per part role. Params: {projectId?, groupIds?}.',
  'scene.autotexture': 'Auto-paint + AI texture per role (slow). Params: {projectId?, groupIds?, size?, maxTextures?}.',
  'scene.tidy': 'Arrange top-level models in a grid. Params: {projectId?, spacing?}.',
  'history.undo': 'Undo (open editor only).',
  'history.redo': 'Redo (open editor only).',
  'save.now': 'Save now (local + cloud when signed in). Params: {projectId?}.',
  'ai.ask': 'Ask the assistant about the project. Params: {projectId?, question}. Factual scene questions fall back to an offline answer (offline:true) when the cloud AI is unreachable.',
  'image.generate': 'Text → image data URL (free Flux by default). Params: {prompt, width?, height?, seed?, strict?}.',
  'texture.generate': 'Text → texture applied to a material. Params: {projectId?, prompt, materialId?, size?, seamless?, strict?}.',
  'model.generate': 'Text → GLB imported into the scene (free Stable Fast 3D by default, TripoSR fallback). Params: {projectId?, prompt, name?, quality?, model?, strict?}.',
};
