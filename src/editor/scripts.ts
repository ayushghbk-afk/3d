// Scene scripts: user-authored (and AI-authored) JavaScript that drives meshes,
// keyframes, the camera, materials and AI generation. Code is compiled with
// `new Function` under `"use strict"` and a sealed `scene` API — never given
// `window` / `document` / `fetch`. Imported GitHub scripts stay disabled.
import { generateImageSmart, generateMeshSmart } from '../ai/factory.js';
import { texturePrompt } from '../ai/pollinations.js';
import { localDb } from '../lib/indexeddb.js';
import { nowIso, uid } from '../lib/utils.js';
import {
  defaultCamera, defaultLight, defaultMaterial, defaultObject,
  type CameraState, type LightKind, type MaterialData, type ObjectType,
  type PrimitiveType, type ProjectDoc, type SceneObjectData, type SceneScript,
  type ScriptTrigger,
} from '../state/models.js';
import { activeClip, deleteKeyframeAt, setKeyframe, trackValueOf } from './animation.js';

export const SCRIPT_MAX_CODE = 80_000;
export const SCRIPT_MAX_COUNT = 24;
export const SCRIPT_MAX_LOG = 80;

const PRIMITIVES: PrimitiveType[] = ['cube', 'sphere', 'cylinder', 'cone', 'plane', 'torus'];
const LIGHT_KINDS: LightKind[] = ['point', 'directional', 'spot', 'ambient', 'hemisphere'];

export interface ScriptLog {
  at: number;
  scriptId: string;
  level: 'log' | 'error';
  message: string;
}

export interface ScriptRunResult {
  ok: boolean;
  scriptId: string;
  logs: string[];
  error?: string;
  ms: number;
}

export interface ScriptHost {
  doc: ProjectDoc;
  mode: 'live' | 'headless';
  canGenerate: boolean;
  selectedId(): string | null;
  select(id: string | null): void;
  addObject(type: ObjectType, name: string): SceneObjectData;
  addLight(kind?: LightKind): SceneObjectData;
  deleteObject(id: string): void;
  duplicateObject(id: string): SceneObjectData | null;
  renameObject(id: string, name: string): void;
  setParent(childId: string, parentId: string | null): void;
  setVisible(id: string, visible: boolean): void;
  setTransform(
    id: string,
    pos?: Partial<SceneObjectData['position']>,
    rotDeg?: { x?: number; y?: number; z?: number },
    scl?: Partial<SceneObjectData['scale']>,
  ): void;
  updateLight(id: string, patch: Partial<import('../state/models.js').LightData> | Record<string, unknown>): void;
  addMaterial(name?: string): MaterialData;
  updateMaterial(id: string, patch: Partial<MaterialData>): void;
  assignMaterial(objectId: string, materialId: string | null): void;
  getCamera(): CameraState;
  setCamera(patch: Partial<CameraState>, persist: boolean): void;
  orbitCamera(azimuthDeg: number, polarDeg: number, distance?: number): void;
  focus(id: string | null): void;
  play(): void;
  pause(): void;
  stop(): void;
  setFrame(n: number): void;
  getPlayback(): { playing: boolean; frame: number; length: number; fps: number };
  addKeyframe(objectId: string, property: 'position' | 'rotation' | 'scale', frame: number, value: [number, number, number]): void;
  deleteKeyframe(objectId: string, property: 'position' | 'rotation' | 'scale', frame: number): void;
  generateTexture(prompt: string, opts: { materialId?: string; objectId?: string; size?: number; seamless?: boolean }): Promise<{ materialId: string; provider: string; seed: number }>;
  generateModel(prompt: string, opts: { name?: string; quality?: 'fast' | 'balanced' | 'high' }): Promise<{ objectId?: string; objectIds?: string[]; provider: string }>;
  persist(kind: string): void;
}

const FORBIDDEN = /\b(window|document|globalThis|self|top|parent|frames|opener|eval|Function|importScripts|XMLHttpRequest|WebSocket|SharedWorker|Worker|fetch|indexedDB|localStorage|sessionStorage|cookie|process|require|module|exports|Deno|Bun|navigator|location|history|chrome|webkitStorageInfo)\b/;

export function assertSafeScript(code: string): void {
  if (typeof code !== 'string') throw new Error('Script code must be a string.');
  if (code.length > SCRIPT_MAX_CODE) throw new Error(`Script exceeds ${SCRIPT_MAX_CODE} characters.`);
  if (/\\u00|\\x[0-9a-fA-F]{2}/.test(code)) {
    throw new Error('Script may not use hex/unicode escapes (sandbox).');
  }
  if (/\bimport\s*\(|^\s*import\b|^\s*export\b/m.test(code)) {
    throw new Error('Script may not use import/export.');
  }
  const hit = code.match(FORBIDDEN);
  if (hit) throw new Error(`Script may not use "${hit[1]}" (restricted sandbox).`);
}

const AsyncFunction = Object.getPrototypeOf(async function noop() { /* mark */ }).constructor as FunctionConstructor;

type Compiled = (scene: unknown, math: unknown, dt: number, time: number, frame: number) => unknown;

export function compileScript(code: string): Compiled {
  assertSafeScript(code);
  const ctor = /\bawait\b/.test(code) ? AsyncFunction : Function;
  return ctor('scene', 'Math', 'dt', 'time', 'frame', `"use strict";\n${code}\n`) as Compiled;
}

const SAFE_MATH: Record<string, unknown> = {
  PI: Math.PI,
  E: Math.E,
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  hypot: Math.hypot,
  log: Math.log,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  random: Math.random,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  deg: (rad: number) => (rad * 180) / Math.PI,
  rad: (deg: number) => (deg * Math.PI) / 180,
};
Object.setPrototypeOf(SAFE_MATH, null);
Object.freeze(SAFE_MATH);

function seal<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(t, p) {
      if (p === 'constructor' || p === 'prototype' || p === '__proto__') return undefined;
      if (typeof p === 'symbol') return undefined;
      const v = Reflect.get(t, p, t);
      if (typeof v === 'function') {
        return (...args: unknown[]) => v.apply(t, args);
      }
      if (v && typeof v === 'object') return seal(v as object);
      return v;
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  }) as T;
}

export interface ObjectSnap {
  id: string;
  name: string;
  type: ObjectType;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  materialId: string | null;
}

function snap(o: SceneObjectData): ObjectSnap {
  const d = 180 / Math.PI;
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    position: { ...o.position },
    rotation: { ...o.rotation },
    rotationDeg: { x: o.rotation.x * d, y: o.rotation.y * d, z: o.rotation.z * d },
    scale: { ...o.scale },
    visible: o.visible,
    locked: o.locked,
    parentId: o.parentId,
    materialId: o.materialId,
  };
}

function findObject(doc: ProjectDoc, idOrName: string): SceneObjectData {
  const o = doc.objects.find((x) => x.id === idOrName) ?? doc.objects.find((x) => x.name === idOrName);
  if (!o) throw new Error(`Object "${idOrName}" not found.`);
  return o;
}

function findMaterial(doc: ProjectDoc, idOrName: string): MaterialData {
  const m = doc.materials.find((x) => x.id === idOrName) ?? doc.materials.find((x) => x.name === idOrName);
  if (!m) throw new Error(`Material "${idOrName}" not found.`);
  return m;
}

function asVec(v: unknown, label: string): { x?: number; y?: number; z?: number } {
  if (v === undefined || v === null) return {};
  if (Array.isArray(v)) {
    if (v.length > 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`${label} must be {x,y,z} or [x,y,z] numbers.`);
    }
    return { x: v[0], y: v[1], z: v[2] };
  }
  if (typeof v !== 'object') throw new Error(`${label} must be {x,y,z} or [x,y,z].`);
  const o = v as Record<string, unknown>;
  const out: { x?: number; y?: number; z?: number } = {};
  for (const k of ['x', 'y', 'z'] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) throw new Error(`${label}.${k} must be a number.`);
      out[k] = o[k] as number;
    }
  }
  return out;
}

function asTriple(v: unknown, label: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`${label} must be [x, y, z] numbers.`);
  }
  return v as [number, number, number];
}

function hexColor(v: unknown): string {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error('color must be a hex string like "#ff8800".');
  return v;
}

class SceneApi {
  constructor(
    private host: ScriptHost,
    private logs: string[],
    private allowHeavy: boolean,
  ) {}

  list(): ObjectSnap[] {
    return this.host.doc.objects.map(snap);
  }
  get(idOrName: string): ObjectSnap | null {
    try {
      return snap(findObject(this.host.doc, String(idOrName)));
    } catch {
      return null;
    }
  }
  selected(): ObjectSnap | null {
    const id = this.host.selectedId();
    const o = id ? this.host.doc.objects.find((x) => x.id === id) : null;
    return o ? snap(o) : null;
  }
  select(idOrName: string | null): void {
    if (idOrName === null || idOrName === undefined || idOrName === '') {
      this.host.select(null);
      return;
    }
    this.host.select(findObject(this.host.doc, String(idOrName)).id);
  }

  add(opts: Record<string, unknown> = {}): ObjectSnap {
    const kind = String(opts.kind ?? 'cube').toLowerCase();
    const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 80) : undefined;
    let obj: SceneObjectData;
    if (kind === 'group') obj = this.host.addObject('group', name ?? 'Group');
    else if (kind === 'light') {
      const lightKind = String(opts.lightKind ?? opts.light ?? 'point') as LightKind;
      if (!LIGHT_KINDS.includes(lightKind)) throw new Error(`lightKind must be one of ${LIGHT_KINDS.join(', ')}.`);
      obj = this.host.addLight(lightKind);
      if (name) this.host.renameObject(obj.id, name);
    } else if ((PRIMITIVES as string[]).includes(kind)) {
      obj = this.host.addObject(kind as PrimitiveType, name ?? kind.charAt(0).toUpperCase() + kind.slice(1));
    } else {
      throw new Error(`kind must be one of ${[...PRIMITIVES, 'group', 'light'].join(', ')}.`);
    }
    this.applyPatch(obj.id, opts);
    return snap(findObject(this.host.doc, obj.id));
  }

  update(idOrName: string, patch: Record<string, unknown> = {}): ObjectSnap {
    const o = findObject(this.host.doc, String(idOrName));
    this.applyPatch(o.id, patch);
    return snap(findObject(this.host.doc, o.id));
  }

  remove(idOrName: string): void {
    this.host.deleteObject(findObject(this.host.doc, String(idOrName)).id);
  }
  duplicate(idOrName: string): ObjectSnap {
    const copy = this.host.duplicateObject(findObject(this.host.doc, String(idOrName)).id);
    if (!copy) throw new Error('Duplicate failed.');
    return snap(copy);
  }

  move(idOrName: string, delta: unknown): ObjectSnap {
    const o = findObject(this.host.doc, String(idOrName));
    const d = asVec(delta, 'delta');
    this.host.setTransform(o.id, {
      x: o.position.x + (d.x ?? 0),
      y: o.position.y + (d.y ?? 0),
      z: o.position.z + (d.z ?? 0),
    });
    return snap(findObject(this.host.doc, o.id));
  }

  rotate(idOrName: string, deg: unknown): ObjectSnap {
    const o = findObject(this.host.doc, String(idOrName));
    const d = asVec(deg, 'rotationDeg');
    const toDeg = 180 / Math.PI;
    this.host.setTransform(o.id, undefined, {
      x: o.rotation.x * toDeg + (d.x ?? 0),
      y: o.rotation.y * toDeg + (d.y ?? 0),
      z: o.rotation.z * toDeg + (d.z ?? 0),
    });
    return snap(findObject(this.host.doc, o.id));
  }

  scale(idOrName: string, scl: unknown): ObjectSnap {
    const o = findObject(this.host.doc, String(idOrName));
    this.host.setTransform(o.id, undefined, undefined, asVec(scl, 'scale'));
    return snap(findObject(this.host.doc, o.id));
  }

  private applyPatch(id: string, patch: Record<string, unknown>): void {
    if (typeof patch.name === 'string' && patch.name.trim()) this.host.renameObject(id, patch.name.trim().slice(0, 80));
    const pos = patch.position !== undefined ? asVec(patch.position, 'position') : undefined;
    const rot = patch.rotationDeg !== undefined
      ? asVec(patch.rotationDeg, 'rotationDeg')
      : patch.rotation !== undefined
        ? (() => {
          const r = asVec(patch.rotation, 'rotation');
          const d = 180 / Math.PI;
          return { x: r.x !== undefined ? r.x * d : undefined, y: r.y !== undefined ? r.y * d : undefined, z: r.z !== undefined ? r.z * d : undefined };
        })()
        : undefined;
    const scl = patch.scale !== undefined ? asVec(patch.scale, 'scale') : undefined;
    if (pos || rot || scl) this.host.setTransform(id, pos, rot, scl);
    if (patch.visible === true || patch.visible === false) this.host.setVisible(id, patch.visible);
    if (patch.parentId !== undefined) {
      const parent = patch.parentId === null ? null : findObject(this.host.doc, String(patch.parentId)).id;
      this.host.setParent(id, parent);
    }
    if (patch.materialId !== undefined) {
      const mid = patch.materialId === null ? null : findMaterial(this.host.doc, String(patch.materialId)).id;
      this.host.assignMaterial(id, mid);
    }
    if (patch.color !== undefined) {
      const color = hexColor(patch.color);
      const mat = this.host.addMaterial(`${findObject(this.host.doc, id).name} color`);
      this.host.updateMaterial(mat.id, { baseColor: color, name: `${findObject(this.host.doc, id).name} color` });
      this.host.assignMaterial(id, mat.id);
    }
    if (patch.light && typeof patch.light === 'object') {
      this.host.updateLight(id, patch.light as Record<string, unknown>);
    }
  }

  get camera() {
    return {
      get: () => this.host.getCamera(),
      set: (patch: Partial<CameraState> = {}) => this.host.setCamera(patch, this.allowHeavy),
      lookAt: (x: number | { x?: number; y?: number; z?: number }, y?: number, z?: number) => {
        const t = typeof x === 'object' ? asVec(x, 'target') : { x, y, z };
        this.host.setCamera({ target: { x: t.x ?? 0, y: t.y ?? 0, z: t.z ?? 0 } }, this.allowHeavy);
      },
      orbit: (azimuthDeg: number, polarDeg: number, distance?: number) => {
        if (typeof azimuthDeg !== 'number' || typeof polarDeg !== 'number') throw new Error('camera.orbit(azimuthDeg, polarDeg, distance?)');
        this.host.orbitCamera(azimuthDeg, polarDeg, distance);
      },
      focus: (idOrName?: string | null) => {
        if (!idOrName) {
          this.host.focus(this.host.selectedId());
          return;
        }
        this.host.focus(findObject(this.host.doc, String(idOrName)).id);
      },
    };
  }

  get keys() {
    return {
      add: (idOrName: string, property: string, frame: number, value?: unknown) => {
        const o = findObject(this.host.doc, String(idOrName));
        const prop = (property || 'position') as 'position' | 'rotation' | 'scale';
        if (!['position', 'rotation', 'scale'].includes(prop)) throw new Error('property must be position, rotation or scale.');
        if (typeof frame !== 'number' || !Number.isFinite(frame)) throw new Error('frame must be a number.');
        const v = value === undefined ? trackValueOf(o, prop) : asTriple(value, 'value');
        this.host.addKeyframe(o.id, prop, Math.round(frame), v);
        return { objectId: o.id, property: prop, frame: Math.round(frame), value: v };
      },
      delete: (idOrName: string, property: string, frame: number) => {
        const o = findObject(this.host.doc, String(idOrName));
        const prop = (property || 'position') as 'position' | 'rotation' | 'scale';
        this.host.deleteKeyframe(o.id, prop, Math.round(frame));
      },
      list: (idOrName?: string) => {
        const clip = activeClip(this.host.doc);
        if (!clip) return [];
        const oid = idOrName ? findObject(this.host.doc, String(idOrName)).id : null;
        return clip.tracks
          .filter((t) => !oid || t.objectId === oid)
          .map((t) => ({ objectId: t.objectId, property: t.property, keyframes: t.keyframes.map((k) => ({ ...k, value: [...k.value] })) }));
      },
    };
  }

  get animation() {
    return {
      play: () => this.host.play(),
      pause: () => this.host.pause(),
      stop: () => this.host.stop(),
      frame: (n?: number) => {
        if (n === undefined) return this.host.getPlayback().frame;
        this.host.setFrame(n);
        return n;
      },
      get: () => this.host.getPlayback(),
    };
  }

  get materials() {
    return {
      list: () => this.host.doc.materials.map((m) => ({ ...m })),
      add: (opts: Record<string, unknown> = {}) => {
        const mat = this.host.addMaterial(typeof opts.name === 'string' ? opts.name : undefined);
        const patch: Partial<MaterialData> = {};
        if (opts.baseColor || opts.color) patch.baseColor = hexColor(opts.baseColor ?? opts.color);
        for (const k of ['metalness', 'roughness', 'emissiveIntensity', 'opacity'] as const) {
          if (typeof opts[k] === 'number') patch[k] = opts[k] as number;
        }
        if (opts.emissive) patch.emissive = hexColor(opts.emissive);
        if (Object.keys(patch).length) this.host.updateMaterial(mat.id, patch);
        return this.host.doc.materials.find((m) => m.id === mat.id);
      },
      update: (idOrName: string, patch: Partial<MaterialData> = {}) => {
        const mat = findMaterial(this.host.doc, String(idOrName));
        this.host.updateMaterial(mat.id, patch);
        return this.host.doc.materials.find((m) => m.id === mat.id);
      },
      assign: (objectIdOrName: string, materialIdOrName: string | null) => {
        const o = findObject(this.host.doc, String(objectIdOrName));
        const mid = materialIdOrName === null ? null : findMaterial(this.host.doc, String(materialIdOrName)).id;
        this.host.assignMaterial(o.id, mid);
      },
    };
  }

  get textures() {
    return {
      generate: async (prompt: string, opts: Record<string, unknown> = {}) => {
        this.guardHeavy('textures.generate');
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Describe the texture first.');
        const objectId = typeof opts.object === 'string' ? findObject(this.host.doc, opts.object).id
          : typeof opts.objectId === 'string' ? findObject(this.host.doc, opts.objectId).id
            : undefined;
        const materialId = typeof opts.materialId === 'string' ? findMaterial(this.host.doc, opts.materialId).id : undefined;
        return this.host.generateTexture(prompt.trim(), {
          materialId,
          objectId,
          size: typeof opts.size === 'number' ? opts.size : 512,
          seamless: opts.seamless !== false,
        });
      },
    };
  }

  get models() {
    return {
      generate: async (prompt: string, opts: Record<string, unknown> = {}) => {
        this.guardHeavy('models.generate');
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Describe the model first.');
        return this.host.generateModel(prompt.trim(), {
          name: typeof opts.name === 'string' ? opts.name : undefined,
          quality: opts.quality === 'fast' || opts.quality === 'high' ? opts.quality : 'balanced',
        });
      },
    };
  }

  play(): void { this.host.play(); }
  pause(): void { this.host.pause(); }
  log(...args: unknown[]): void {
    const msg = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    this.logs.push(msg.slice(0, 500));
  }
  async sleep(ms: number): Promise<void> {
    this.guardHeavy('sleep');
    const n = Math.max(0, Math.min(10_000, Number(ms) || 0));
    await new Promise((r) => setTimeout(r, n));
  }

  private guardHeavy(name: string): void {
    if (!this.allowHeavy) throw new Error(`${name} is not allowed in per-frame scripts — use trigger "manual", "open" or "play".`);
    if (!this.host.canGenerate && (name.startsWith('textures') || name.startsWith('models'))) {
      throw new Error(`${name} needs the generate scope (Agent API) or a user-run script.`);
    }
  }
}

export async function runScriptCode(
  code: string,
  host: ScriptHost,
  ctx: { scriptId?: string; dt?: number; time?: number; frame?: number; allowHeavy?: boolean } = {},
): Promise<ScriptRunResult> {
  const started = performance.now();
  const logs: string[] = [];
  const scriptId = ctx.scriptId ?? 'adhoc';
  try {
    const fn = compileScript(code);
    const api = seal(new SceneApi(host, logs, ctx.allowHeavy !== false));
    const out = fn(api, SAFE_MATH, ctx.dt ?? 0, ctx.time ?? 0, ctx.frame ?? 0);
    if (out && typeof (out as Promise<unknown>).then === 'function') await out;
    return { ok: true, scriptId, logs, ms: Math.round(performance.now() - started) };
  } catch (e) {
    const error = (e as Error).message || String(e);
    logs.push(`error: ${error}`);
    return { ok: false, scriptId, logs, error, ms: Math.round(performance.now() - started) };
  }
}

export class ScriptEngine {
  logs: ScriptLog[] = [];
  paused = false;
  time = 0;
  private compiled = new Map<string, Compiled>();
  private running = new Set<string>();
  private errors = new Map<string, number>();
  private wasPlaying = false;
  private onLog: ((line: ScriptLog) => void) | null = null;

  constructor(private host: ScriptHost) {}

  setOnLog(fn: ((line: ScriptLog) => void) | null): void {
    this.onLog = fn;
  }

  invalidate(id?: string): void {
    if (id) this.compiled.delete(id);
    else this.compiled.clear();
  }

  private pushLog(scriptId: string, level: 'log' | 'error', message: string): void {
    const line: ScriptLog = { at: Date.now(), scriptId, level, message: message.slice(0, 500) };
    this.logs.push(line);
    if (this.logs.length > SCRIPT_MAX_LOG) this.logs.splice(0, this.logs.length - SCRIPT_MAX_LOG);
    this.onLog?.(line);
  }

  async run(script: Pick<SceneScript, 'id' | 'name' | 'code'>, opts: { dt?: number; time?: number; frame?: number; allowHeavy?: boolean } = {}): Promise<ScriptRunResult> {
    const result = await runScriptCode(script.code, this.host, {
      scriptId: script.id,
      dt: opts.dt,
      time: opts.time ?? this.time,
      frame: opts.frame,
      allowHeavy: opts.allowHeavy,
    });
    for (const msg of result.logs) this.pushLog(script.id, result.ok ? 'log' : 'error', msg);
    if (!result.ok) this.pushLog(script.id, 'error', result.error ?? 'Script failed');
    return result;
  }

  async runTrigger(trigger: ScriptTrigger): Promise<void> {
    for (const s of this.host.doc.scripts) {
      if (!s.enabled || s.trigger !== trigger) continue;
      const result = await this.run(s, { dt: 0, time: this.time, frame: this.host.getPlayback().frame, allowHeavy: trigger !== 'frame' });
      if (!result.ok) {
        s.enabled = false;
        this.host.persist('script');
      }
    }
  }

  tick(dt: number, playing: boolean, frame: number): void {
    this.time += dt;
    if (playing && !this.wasPlaying) void this.runTrigger('play');
    this.wasPlaying = playing;
    if (this.paused) return;
    for (const s of this.host.doc.scripts) {
      if (!s.enabled || s.trigger !== 'frame') continue;
      if (this.running.has(s.id)) continue;
      this.running.add(s.id);
      void this.run(s, { dt, time: this.time, frame, allowHeavy: false }).then((result) => {
        this.running.delete(s.id);
        if (!result.ok) {
          const n = (this.errors.get(s.id) ?? 0) + 1;
          this.errors.set(s.id, n);
          if (n >= 3) {
            s.enabled = false;
            this.host.persist('script');
            this.pushLog(s.id, 'error', `Disabled "${s.name}" after 3 errors.`);
          }
        } else {
          this.errors.set(s.id, 0);
        }
      });
    }
  }
}

function uniqueName(doc: ProjectDoc, base: string): string {
  const names = new Set(doc.objects.map((o) => o.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function touch(doc: ProjectDoc): void {
  doc.version++;
  doc.updatedAt = nowIso();
}

/** Headless host so Agent API / tests can run scripts without a viewport. */
export function createHeadlessHost(
  doc: ProjectDoc,
  opts: { persist?: () => void | Promise<void>; canGenerate?: boolean } = {},
): ScriptHost {
  let selected: string | null = null;
  let playing = false;
  let frame = 0;
  const camera: CameraState = doc.settings.camera ? { ...doc.settings.camera, position: { ...doc.settings.camera.position }, target: { ...doc.settings.camera.target } } : defaultCamera();
  const persist = (): void => { void opts.persist?.(); };

  const addObject = (type: ObjectType, name: string): SceneObjectData => {
    const o = defaultObject(type, uniqueName(doc, name));
    if (type !== 'group' && type !== 'light' && type !== 'imported') o.materialId = doc.materials[0]?.id ?? null;
    doc.objects.push(o);
    touch(doc);
    persist();
    selected = o.id;
    return o;
  };

  const host: ScriptHost = {
    doc,
    mode: 'headless',
    canGenerate: opts.canGenerate !== false,
    selectedId: () => selected,
    select: (id) => { selected = id; },
    addObject,
    addLight: (kind = 'point') => {
      const o = addObject('light', kind.charAt(0).toUpperCase() + kind.slice(1));
      o.light = { ...defaultLight(kind), kind };
      return o;
    },
    deleteObject: (id) => {
      const ids = new Set([id, ...doc.objects.filter((o) => o.parentId === id).map((o) => o.id)]);
      doc.objects = doc.objects.filter((o) => !ids.has(o.id));
      if (selected && ids.has(selected)) selected = null;
      touch(doc);
      persist();
    },
    duplicateObject: (id) => {
      const src = doc.objects.find((o) => o.id === id);
      if (!src) return null;
      const copy = JSON.parse(JSON.stringify(src)) as SceneObjectData;
      copy.id = uid();
      copy.name = uniqueName(doc, `${src.name} copy`);
      copy.position = { ...src.position, x: src.position.x + 0.5 };
      copy.version = 1;
      doc.objects.push(copy);
      touch(doc);
      persist();
      return copy;
    },
    renameObject: (id, name) => {
      const o = doc.objects.find((x) => x.id === id);
      if (!o) return;
      o.name = name;
      o.version++;
      touch(doc);
      persist();
    },
    setParent: (childId, parentId) => {
      const o = doc.objects.find((x) => x.id === childId);
      if (!o || childId === parentId) return;
      if (parentId) findObject(doc, parentId);
      o.parentId = parentId;
      o.version++;
      touch(doc);
      persist();
    },
    setVisible: (id, visible) => {
      const o = doc.objects.find((x) => x.id === id);
      if (!o) return;
      o.visible = visible;
      o.version++;
      touch(doc);
      persist();
    },
    setTransform: (id, pos, rotDeg, scl) => {
      const o = doc.objects.find((x) => x.id === id);
      if (!o) return;
      if (pos) o.position = { ...o.position, ...pos };
      if (rotDeg) {
        const d = Math.PI / 180;
        o.rotation = {
          x: rotDeg.x !== undefined ? rotDeg.x * d : o.rotation.x,
          y: rotDeg.y !== undefined ? rotDeg.y * d : o.rotation.y,
          z: rotDeg.z !== undefined ? rotDeg.z * d : o.rotation.z,
        };
      }
      if (scl) o.scale = { ...o.scale, ...scl };
      o.version++;
      touch(doc);
      persist();
    },
    updateLight: (id, patch) => {
      const o = doc.objects.find((x) => x.id === id);
      if (!o || o.type !== 'light' || !o.light) return;
      Object.assign(o.light, patch);
      o.version++;
      touch(doc);
      persist();
    },
    addMaterial: (name) => {
      const m = defaultMaterial(name ?? `Material ${doc.materials.length + 1}`);
      doc.materials.push(m);
      touch(doc);
      persist();
      return m;
    },
    updateMaterial: (id, patch) => {
      const m = doc.materials.find((x) => x.id === id);
      if (!m) return;
      Object.assign(m, patch, { updatedAt: nowIso() });
      touch(doc);
      persist();
    },
    assignMaterial: (objectId, materialId) => {
      const o = doc.objects.find((x) => x.id === objectId);
      if (!o) return;
      if (materialId) findMaterial(doc, materialId);
      o.materialId = materialId;
      o.version++;
      touch(doc);
      persist();
    },
    getCamera: () => ({ ...camera, position: { ...camera.position }, target: { ...camera.target } }),
    setCamera: (patch, persistCam) => {
      if (patch.type) camera.type = patch.type;
      if (patch.position) camera.position = { ...camera.position, ...patch.position };
      if (patch.target) camera.target = { ...camera.target, ...patch.target };
      if (typeof patch.fov === 'number') camera.fov = Math.max(10, Math.min(120, patch.fov));
      if (persistCam) {
        doc.settings.camera = host.getCamera();
        touch(doc);
        persist();
      }
    },
    orbitCamera: (azimuthDeg, polarDeg, distance) => {
      const t = camera.target;
      const az = (azimuthDeg * Math.PI) / 180;
      const pol = (polarDeg * Math.PI) / 180;
      const dist = distance ?? Math.hypot(camera.position.x - t.x, camera.position.y - t.y, camera.position.z - t.z) ?? 8;
      camera.position = {
        x: t.x + dist * Math.sin(pol) * Math.sin(az),
        y: t.y + dist * Math.cos(pol),
        z: t.z + dist * Math.sin(pol) * Math.cos(az),
      };
    },
    focus: () => undefined,
    play: () => { playing = true; },
    pause: () => { playing = false; },
    stop: () => { playing = false; frame = 0; },
    setFrame: (n) => { frame = Math.max(0, Math.round(n)); },
    getPlayback: () => {
      const clip = activeClip(doc);
      return { playing, frame, length: clip?.length ?? 90, fps: clip?.fps ?? 30 };
    },
    addKeyframe: (objectId, property, fr, value) => {
      setKeyframe(doc, objectId, property, fr, value);
      touch(doc);
      persist();
    },
    deleteKeyframe: (objectId, property, fr) => {
      deleteKeyframeAt(doc, objectId, property, fr);
      touch(doc);
      persist();
    },
    generateTexture: async (prompt, texOpts) => {
      if (!host.canGenerate) throw new Error('Texture generation needs the generate scope.');
      const size = Math.max(64, Math.min(1024, texOpts.size ?? 512));
      const { result } = await generateImageSmart(texturePrompt(prompt, texOpts.seamless !== false), { width: size, height: size });
      let matId = texOpts.materialId;
      if (matId) findMaterial(doc, matId);
      else {
        const mat = defaultMaterial(prompt.slice(0, 32) || 'AI texture');
        doc.materials.push(mat);
        matId = mat.id;
      }
      const assetId = uid();
      await localDb.saveBlob(assetId, result.blob);
      doc.assets.push({
        id: assetId, name: `${prompt.slice(0, 40) || 'texture'}.png`, kind: 'texture', mime: result.mime,
        size: result.blob.size, storagePath: null, local: true, thumb: null, createdAt: nowIso(),
      });
      const mat = findMaterial(doc, matId);
      mat.mapAssetId = assetId;
      mat.updatedAt = nowIso();
      if (texOpts.objectId) {
        const o = findObject(doc, texOpts.objectId);
        o.materialId = matId;
        o.version++;
      }
      touch(doc);
      persist();
      return { materialId: matId, provider: result.provider, seed: result.seed };
    },
    generateModel: async (prompt, modelOpts) => {
      if (!host.canGenerate) throw new Error('Model generation needs the generate scope.');
      const outcome = await generateMeshSmart(prompt, { quality: modelOpts.quality ?? 'balanced' });
      if (outcome.kind === 'glb') {
        const assetId = uid();
        await localDb.saveBlob(assetId, new Blob([outcome.result.glb], { type: 'model/gltf-binary' }));
        doc.assets.push({
          id: assetId, name: `${modelOpts.name ?? prompt.slice(0, 40)}.glb`, kind: 'model', mime: 'model/gltf-binary',
          size: outcome.result.glb.byteLength, storagePath: null, local: true, thumb: null, createdAt: nowIso(),
        });
        const obj = addObject('imported', modelOpts.name ?? prompt.slice(0, 40) ?? 'AI model');
        obj.assetId = assetId;
        persist();
        return { objectId: obj.id, provider: outcome.result.provider };
      }
      const objectIds: string[] = [];
      for (const part of outcome.parts) {
        const obj = addObject(part.kind, part.name);
        obj.position = { x: part.position[0], y: part.position[1], z: part.position[2] };
        if (part.scale) obj.scale = { x: part.scale[0], y: part.scale[1], z: part.scale[2] };
        if (part.color) {
          const mat = defaultMaterial(`${part.name} color`);
          mat.baseColor = part.color;
          doc.materials.push(mat);
          obj.materialId = mat.id;
        }
        objectIds.push(obj.id);
      }
      persist();
      return { objectIds, provider: 'procedural-mesh' };
    },
    persist: () => persist(),
  };
  return host;
}

export const SCRIPT_EXAMPLES: { id: string; name: string; trigger: ScriptTrigger; code: string }[] = [
  {
    id: 'spin',
    name: 'Spin selected',
    trigger: 'frame',
    code: `const o = scene.selected();
if (!o) return;
scene.rotate(o.id, { y: 90 * dt });`,
  },
  {
    id: 'orbit',
    name: 'Orbit camera',
    trigger: 'frame',
    code: `scene.camera.orbit(time * 25, 35, 9);
scene.camera.lookAt(0, 0.5, 0);`,
  },
  {
    id: 'hop',
    name: 'Keyframe hop',
    trigger: 'manual',
    code: `const cube = scene.get('Hopper') || scene.add({ kind: 'cube', name: 'Hopper', color: '#5b8cff' });
scene.keys.add(cube.id, 'position', 0, [0, 0.5, 0]);
scene.keys.add(cube.id, 'position', 30, [0, 2.2, 0]);
scene.keys.add(cube.id, 'position', 60, [0, 0.5, 0]);
scene.animation.play();
scene.log('Hop animation keyed on ' + cube.name);`,
  },
  {
    id: 'scatter',
    name: 'Scatter cubes',
    trigger: 'manual',
    code: `for (let i = 0; i < 8; i++) {
  const x = (i % 4) * 1.4 - 2.1;
  const z = Math.floor(i / 4) * 1.4 - 0.7;
  scene.add({
    kind: 'cube',
    name: 'Block ' + (i + 1),
    position: { x: x, y: 0.5, z: z },
    color: i % 2 ? '#5b8cff' : '#4ade80',
  });
}
scene.camera.set({ position: { x: 6, y: 4, z: 8 }, target: { x: 0, y: 0.5, z: 0 } });
scene.log('Added 8 cubes');`,
  },
  {
    id: 'tex',
    name: 'AI texture selected',
    trigger: 'manual',
    code: `const o = scene.selected();
if (!o) { scene.log('Select a mesh first'); return; }
scene.log('Generating texture…');
const out = await scene.textures.generate('brushed gold metal, fine scratches', { object: o.id, size: 512, seamless: true });
scene.log('Applied ' + out.provider + ' texture to ' + o.name);`,
  },
  {
    id: 'model',
    name: 'AI add a model',
    trigger: 'manual',
    code: `scene.log('Generating a toy robot…');
const out = await scene.models.generate('a cute low-poly robot toy', { name: 'Robot', quality: 'fast' });
scene.log('Added model via ' + out.provider);
scene.camera.focus();`,
  },
];
