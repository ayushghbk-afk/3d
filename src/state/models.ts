import { uid, nowIso } from '../lib/utils.js';

export type ProjectMode = 'solo' | 'team';
export type TeamRole = 'owner' | 'admin' | 'editor' | 'animator' | 'viewer';
export type PrimitiveType = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'torus';
export type StarterTemplate = 'blank' | 'product' | 'lowpoly';
export type ObjectType = PrimitiveType | 'group' | 'imported' | 'light';
export type ShadingMode = 'solid' | 'material' | 'wireframe';
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type CameraType = 'perspective' | 'orthographic';
export type SelectionMode = 'object' | 'vertex' | 'edge' | 'face';
export type LightKind = 'point' | 'directional' | 'spot' | 'ambient' | 'hemisphere';
/** When a project script runs. `frame` = every viewport tick (keep it cheap). */
export type ScriptTrigger = 'manual' | 'open' | 'play' | 'frame';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export interface MaterialData {
  id: string;
  name: string;
  baseColor: string; // hex
  metalness: number;
  roughness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
  side: 'front' | 'double';
  flatShading: boolean;
  mapAssetId: string | null; // base-color texture asset
  updatedAt: string;
}

export interface LightData {
  kind: LightKind;
  color: string;
  intensity: number;
  distance: number; // point/spot range (0 = infinite)
  angle: number; // spot cone (radians)
  penumbra: number; // spot softness 0..1
  castShadow: boolean;
}

export interface SceneObjectData {
  id: string;
  name: string;
  type: ObjectType;
  position: Vec3;
  rotation: Vec3; // radians
  scale: Vec3;
  visible: boolean;
  locked: boolean;
  parentId: string | null;
  materialId: string | null;
  /** Primitive rebuild params */
  primitive?: { kind: PrimitiveType; params: Record<string, number> };
  /** Light params (type === 'light') */
  light?: LightData | null;
  /** Imported mesh asset reference */
  assetId?: string | null;
  updatedAt: string;
  version: number;
}

export interface Keyframe {
  frame: number;
  value: [number, number, number];
  interp: 'linear' | 'step';
}

export interface AnimTrack {
  id: string;
  objectId: string;
  property: 'position' | 'rotation' | 'scale';
  keyframes: Keyframe[];
}

export interface AnimClip {
  id: string;
  name: string;
  fps: number;
  length: number; // frames
  tracks: AnimTrack[];
}

export interface AssetMeta {
  id: string;
  name: string;
  kind: 'model' | 'texture' | 'other';
  mime: string;
  size: number;
  storagePath: string | null; // supabase storage path
  local: boolean; // blob available in indexeddb
  thumb: string | null; // small dataURL preview (textures)
  createdAt: string;
}

export interface CameraState {
  type: CameraType;
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface SceneScript {
  id: string;
  name: string;
  /** Restricted JavaScript. Receives `scene`, `Math`, `dt`, `time`, `frame`. */
  code: string;
  enabled: boolean;
  trigger: ScriptTrigger;
  updatedAt: string;
}

export interface ProjectSettings {
  envIntensity: number; // 0..2 environment lighting strength
  shadows: boolean; // global shadow maps toggle
  /** Last script/API camera pose (viewport still lets the user orbit). */
  camera?: CameraState | null;
}

export interface ProjectDoc {
  id: string;
  name: string;
  mode: ProjectMode;
  ownerId: string;
  thumbnail: string | null; // dataURL (small)
  objects: SceneObjectData[];
  materials: MaterialData[];
  clips: AnimClip[];
  assets: AssetMeta[];
  scripts: SceneScript[];
  activeClipId: string | null;
  settings: ProjectSettings;
  updatedAt: string;
  version: number;
  /** cloud revision for conflict checks */
  cloudVersion: number;
}

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  editingObjectId: string | null;
  editingObjectName: string | null;
  onlineAt: string;
}

export function defaultMaterial(name = 'Material'): MaterialData {
  return {
    id: uid(),
    name,
    baseColor: '#8b9bb4',
    metalness: 0.1,
    roughness: 0.7,
    emissive: '#000000',
    emissiveIntensity: 0,
    opacity: 1,
    transparent: false,
    side: 'front',
    flatShading: false,
    mapAssetId: null,
    updatedAt: nowIso(),
  };
}

export function defaultLight(kind: LightKind = 'point'): LightData {
  const base = { color: '#ffffff', distance: 20, angle: 0.6, penumbra: 0.4, castShadow: false };
  switch (kind) {
    case 'point':
      return { kind, intensity: 10, ...base };
    case 'spot':
      return { kind, intensity: 30, ...base };
    case 'directional':
      return { kind, intensity: 1.5, ...base };
    case 'ambient':
      return { kind, intensity: 0.6, ...base };
    case 'hemisphere':
      return { kind, intensity: 0.6, ...base };
  }
}

export function defaultObject(type: ObjectType, name: string): SceneObjectData {
  const prims: PrimitiveType[] = ['cube', 'sphere', 'cylinder', 'cone', 'plane', 'torus'];
  const isPrim = (prims as string[]).includes(type);
  return {
    id: uid(),
    name,
    type,
    position: v3(),
    rotation: v3(),
    scale: v3(1, 1, 1),
    visible: true,
    locked: false,
    parentId: null,
    materialId: null,
    primitive: isPrim ? { kind: type as PrimitiveType, params: {} } : undefined,
    light: type === 'light' ? defaultLight('point') : undefined,
    assetId: null,
    updatedAt: nowIso(),
    version: 1,
  };
}

export function defaultClip(name = 'Clip 1'): AnimClip {
  return { id: uid(), name, fps: 30, length: 90, tracks: [] };
}

export function defaultSettings(): ProjectSettings {
  return { envIntensity: 1, shadows: true, camera: null };
}

export function defaultCamera(): CameraState {
  return {
    type: 'perspective',
    position: v3(4, 3, 6),
    target: v3(),
    fov: 50,
  };
}

export const SCRIPT_STARTER = `// Restricted JS: scene, Math, dt, time, frame.
// Control any mesh, keyframes, camera, materials — and call AI generate.
const o = scene.selected() || scene.get('Cube');
if (!o) {
  scene.log('Select a mesh, or add one: scene.add({ kind: "cube", name: "Cube" })');
} else {
  scene.rotate(o.id, { y: 45 });
  scene.log('Rotated ' + o.name);
}
`;

export function defaultScript(name = 'Script'): SceneScript {
  return {
    id: uid(),
    name,
    code: SCRIPT_STARTER,
    enabled: false,
    trigger: 'manual',
    updatedAt: nowIso(),
  };
}

export function createProjectDoc(name: string, mode: ProjectMode, ownerId: string): ProjectDoc {
  const mat = defaultMaterial('Default');
  const clip = defaultClip('Idle');
  return {
    id: uid(),
    name,
    mode,
    ownerId,
    thumbnail: null,
    objects: [],
    materials: [mat],
    clips: [clip],
    assets: [],
    scripts: [],
    activeClipId: clip.id,
    settings: defaultSettings(),
    updatedAt: nowIso(),
    version: 1,
    cloudVersion: 0,
  };
}

function starterMaterial(name: string, patch: Partial<MaterialData>): MaterialData {
  return { ...defaultMaterial(name), ...patch, updatedAt: nowIso() };
}

function starterObject(
  kind: PrimitiveType | 'light',
  name: string,
  opts: {
    materialId?: string | null;
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    light?: Partial<LightData>;
  } = {},
): SceneObjectData {
  const obj = defaultObject(kind, name);
  obj.materialId = opts.materialId ?? obj.materialId;
  obj.position = opts.position ?? obj.position;
  obj.rotation = opts.rotation ?? obj.rotation;
  obj.scale = opts.scale ?? obj.scale;
  if (kind === 'light') obj.light = { ...defaultLight('point'), ...(opts.light ?? {}) };
  return obj;
}

export function applyStarterTemplate(doc: ProjectDoc, template: StarterTemplate): ProjectDoc {
  if (template === 'blank') return doc;

  const base = doc.materials[0];
  const floor = starterMaterial('Floor', { baseColor: '#18202f', roughness: 0.92, metalness: 0 });
  const accent = starterMaterial('Accent', { baseColor: '#7c99ff', roughness: 0.28, metalness: 0.18 });
  const glow = starterMaterial('Glow', { baseColor: '#f6f7fb', roughness: 0.18, emissive: '#8ab4ff', emissiveIntensity: 1.35, metalness: 0.02 });
  const warm = starterMaterial('Warm', { baseColor: '#f59e0b', roughness: 0.4, metalness: 0.08 });
  const leaf = starterMaterial('Leaf', { baseColor: '#34d399', roughness: 0.86, metalness: 0 });

  if (template === 'product') {
    Object.assign(base, { name: 'Shell', baseColor: '#e8eefc', roughness: 0.2, metalness: 0.08, updatedAt: nowIso() });
    doc.materials.push(floor, accent, glow);
    doc.objects = [
      starterObject('plane', 'Stage', {
        materialId: floor.id,
        position: v3(0, -0.8, 0),
        rotation: v3(-Math.PI / 2, 0, 0),
        scale: v3(7, 1, 7),
      }),
      starterObject('cylinder', 'Body', {
        materialId: base.id,
        scale: v3(1.05, 1.5, 1.05),
      }),
      starterObject('sphere', 'Cap', {
        materialId: accent.id,
        position: v3(0, 1.65, 0),
        scale: v3(0.72, 0.72, 0.72),
      }),
      starterObject('torus', 'Ring', {
        materialId: glow.id,
        position: v3(0, -0.05, 0),
        rotation: v3(Math.PI / 2, 0, 0),
        scale: v3(1.5, 1.5, 1.5),
      }),
      starterObject('cube', 'Button', {
        materialId: accent.id,
        position: v3(0, 0.15, 0.95),
        rotation: v3(0.1, 0.35, 0),
        scale: v3(0.32, 0.14, 0.18),
      }),
      starterObject('light', 'Key Light', {
        position: v3(3, 4, 2),
        light: { kind: 'directional', intensity: 1.8, castShadow: true },
      }),
      starterObject('light', 'Fill Light', {
        position: v3(-2.4, 1.8, 2.4),
        light: { kind: 'point', intensity: 14, distance: 18 },
      }),
    ];
  }

  if (template === 'lowpoly') {
    Object.assign(base, { name: 'Stone', baseColor: '#94a3b8', roughness: 0.88, metalness: 0, updatedAt: nowIso() });
    doc.materials.push(floor, warm, leaf, accent);
    doc.objects = [
      starterObject('plane', 'Ground', {
        materialId: floor.id,
        position: v3(0, -0.95, 0),
        rotation: v3(-Math.PI / 2, 0, 0),
        scale: v3(10, 1, 10),
      }),
      starterObject('cube', 'Cabin', {
        materialId: warm.id,
        position: v3(-1.35, -0.1, 0),
        scale: v3(1.2, 1.2, 1.2),
      }),
      starterObject('cone', 'Roof', {
        materialId: accent.id,
        position: v3(-1.35, 1.05, 0),
        scale: v3(1.08, 0.95, 1.08),
      }),
      starterObject('cylinder', 'Tree trunk', {
        materialId: warm.id,
        position: v3(1.4, -0.1, -0.4),
        scale: v3(0.28, 1, 0.28),
      }),
      starterObject('cone', 'Tree canopy', {
        materialId: leaf.id,
        position: v3(1.4, 1.12, -0.4),
        scale: v3(1.08, 1.5, 1.08),
      }),
      starterObject('sphere', 'Sun', {
        materialId: glow.id,
        position: v3(2.7, 2.5, -2.4),
        scale: v3(0.45, 0.45, 0.45),
      }),
      starterObject('light', 'Sun Light', {
        position: v3(2.8, 4.5, 1.8),
        light: { kind: 'directional', intensity: 1.55, castShadow: true },
      }),
      starterObject('light', 'Sky Light', {
        position: v3(0, 3, 0),
        light: { kind: 'hemisphere', intensity: 0.85 },
      }),
    ];
    if (!doc.materials.find((m) => m.id === glow.id)) doc.materials.push(glow);
  }

  doc.updatedAt = nowIso();
  return doc;
}

export function createStarterProjectDoc(name: string, mode: ProjectMode, ownerId: string, template: StarterTemplate = 'blank'): ProjectDoc {
  return applyStarterTemplate(createProjectDoc(name, mode, ownerId), template);
}

/** Fill defaults for docs written by older app versions (local + cloud). */
export function normalizeDoc(doc: ProjectDoc): ProjectDoc {
  if (!doc.settings) doc.settings = defaultSettings();
  if (doc.settings.envIntensity === undefined) doc.settings.envIntensity = 1;
  if (doc.settings.shadows === undefined) doc.settings.shadows = true;
  for (const m of doc.materials) {
    if (m.side === undefined) m.side = 'front';
    if (m.flatShading === undefined) m.flatShading = false;
    if (m.mapAssetId === undefined) m.mapAssetId = null;
    if (m.emissiveIntensity === undefined) m.emissiveIntensity = 0;
  }
  for (const o of doc.objects) {
    if (o.type === 'light' && !o.light) o.light = defaultLight('point');
  }
  for (const a of doc.assets) {
    if (a.thumb === undefined) a.thumb = null;
  }
  if (!Array.isArray(doc.scripts)) doc.scripts = [];
  const TRIGGERS: ScriptTrigger[] = ['manual', 'open', 'play', 'frame'];
  for (const s of doc.scripts) {
    if (!s.id) s.id = uid();
    if (typeof s.name !== 'string' || !s.name.trim()) s.name = 'Script';
    if (typeof s.code !== 'string') s.code = '';
    if (typeof s.enabled !== 'boolean') s.enabled = false;
    if (!TRIGGERS.includes(s.trigger)) s.trigger = 'manual';
    if (typeof s.updatedAt !== 'string') s.updatedAt = nowIso();
  }
  return doc;
}
