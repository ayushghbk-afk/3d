import { uid, nowIso } from '../lib/utils.js';

export type ProjectMode = 'solo' | 'team';
export type TeamRole = 'owner' | 'admin' | 'editor' | 'animator' | 'viewer' | 'commenter';
export type PrimitiveType = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'torus';
/** Built-in starting points offered on the dashboard's New Project screen. */
export type StarterTemplate =
  | 'blank' | 'product' | 'lowpoly' | 'game' | 'character'
  | 'room' | 'solar' | 'animation' | 'logo';
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
  // --- material editor (PBR extension) ---
  normalMapAssetId: string | null;
  normalScale: number;
  aoMapAssetId: string | null;
  aoIntensity: number;
  transmission: number; // 0..1 glass / refraction
  ior: number; // index of refraction
  thickness: number; // transmission volume thickness
  clearcoat: number;
  clearcoatRoughness: number;
  updatedAt: string;
}

/** Material factory presets (Plastic, Metal, Glass, Wood, Stone, Fabric, Neon…). */
export type MaterialPresetId =
  | 'plastic' | 'metal' | 'glass' | 'wood' | 'stone' | 'fabric'
  | 'neon' | 'matte' | 'gold' | 'chrome' | 'rubber' | 'emerald';

export interface LightData {
  kind: LightKind;
  color: string;
  intensity: number;
  distance: number; // point/spot range (0 = infinite)
  angle: number; // spot cone (radians)
  penumbra: number; // spot softness 0..1
  castShadow: boolean;
}

/** Simple physics body used by Play Mode. */
export interface ObjectPhysics {
  enabled: boolean;
  /** Static bodies never move (floor, walls). */
  dynamic: boolean;
  mass: number;
  restitution: number;
  /** Sphere, box or plane collider. Radius/extents derive from the bounds. */
  shape: 'box' | 'sphere' | 'plane';
  /** Trigger volumes fire `onEnter` scripts instead of colliding. */
  trigger: boolean;
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
  /** Transform origin offset, in the object's own local space (pivot editing). */
  pivot?: Vec3;
  /** Column-major 4x4 baked into the geometry by Apply Transforms. */
  baked?: number[] | null;
  /** Collections this object belongs to (scene organisation). */
  collectionIds?: string[];
  /** Play Mode body. */
  physics?: ObjectPhysics | null;
  /** Primitive rebuild params */
  primitive?: { kind: PrimitiveType; params: Record<string, number> };
  /** Light params (type === 'light') */
  light?: LightData | null;
  /** Imported mesh asset reference */
  assetId?: string | null;
  updatedAt: string;
  version: number;
}

export type KeyInterp = 'linear' | 'step' | 'ease' | 'easeIn' | 'easeOut';

export interface Keyframe {
  frame: number;
  value: [number, number, number];
  interp: KeyInterp;
}

/** Editor panel layout (saved per device so the editor reopens as you left it). */
export interface LayoutState {
  railW: number;
  leftW: number;
  rightW: number;
  timelineH: number;
  showRail: boolean;
  showOutliner: boolean;
  showInspector: boolean;
  showTimeline: boolean;
  mobileSheet: 'none' | 'add' | 'outliner' | 'inspector' | 'assets' | 'animation';
}

export interface CameraBookmark {
  id: string;
  name: string;
  camera: CameraState;
}

export interface FogSettings {
  enabled: boolean;
  color: string;
  near: number;
  far: number;
}

export interface PostFxSettings {
  enabled: boolean;
  bloom: number; // 0..2 strength
  vignette: number; // 0..1
  grain: number; // 0..1
  dof: number; // 0..1 (cheap blur approximation of depth of field)
}

export interface EnvironmentSettings {
  preset: EnvironmentPreset;
  intensity: number;
  rotation: number; // radians
  background: boolean; // show the environment as the scene backdrop
}

/** Procedurally generated (no downloads, no HDRI files) studio environments. */
export type EnvironmentPreset =
  | 'room' | 'studio' | 'sunset' | 'night' | 'overcast' | 'cyberpunk' | 'forest' | 'void';

export interface Collection {
  id: string;
  name: string;
  color: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  actor: string;
  kind: 'add' | 'delete' | 'rename' | 'transform' | 'material' | 'animation' | 'camera' | 'save' | 'join' | 'style' | 'system';
  message: string;
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
  environment?: EnvironmentSettings | null;
  fog?: FogSettings | null;
  postfx?: PostFxSettings | null;
  /** Grid + angle + surface snapping for the transform gizmo. */
  snap?: SnapSettings | null;
  /** Play Mode: which object the camera follows (`null` = free fly camera). */
  playCameraId?: string | null;
  gravity?: number;
}

export interface SnapSettings {
  enabled: boolean;
  /** Translation grid size in world units. */
  grid: number;
  /** Rotation increment in degrees. */
  angle: number;
  /** Scale increment. */
  scale: number;
  /** Drop dragged objects onto the surface under the cursor. */
  toObjects: boolean;
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
  // --- organisation / presentation / history ---
  collections: Collection[];
  cameraBookmarks: CameraBookmark[];
  /** Activity feed (most recent first, capped). */
  activity: ActivityEntry[];
  /** Saved editor panel layout. */
  uiLayout: LayoutState | null;
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
    normalMapAssetId: null,
    normalScale: 1,
    aoMapAssetId: null,
    aoIntensity: 1,
    transmission: 0,
    ior: 1.5,
    thickness: 0.5,
    clearcoat: 0,
    clearcoatRoughness: 0.1,
    updatedAt: nowIso(),
  };
}

/** Material presets used by the material editor, asset browser and AI styling. */
export function materialPreset(id: MaterialPresetId, patch: Partial<MaterialData> = {}): Partial<MaterialData> {
  const presets: Record<MaterialPresetId, Partial<MaterialData>> = {
    plastic: { baseColor: '#e2e8f0', metalness: 0, roughness: 0.35, clearcoat: 0.4, clearcoatRoughness: 0.2, transmission: 0 },
    metal: { baseColor: '#b8c0cc', metalness: 1, roughness: 0.28, clearcoat: 0, transmission: 0 },
    glass: { baseColor: '#dff1ff', metalness: 0, roughness: 0.04, opacity: 0.9, transparent: true, transmission: 0.95, ior: 1.5, thickness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03 },
    wood: { baseColor: '#a9713f', metalness: 0, roughness: 0.62, clearcoat: 0.25, clearcoatRoughness: 0.4, transmission: 0 },
    stone: { baseColor: '#8d8f93', metalness: 0, roughness: 0.92, clearcoat: 0, transmission: 0 },
    fabric: { baseColor: '#6d7a99', metalness: 0, roughness: 0.95, clearcoat: 0, transmission: 0, side: 'double' },
    neon: { baseColor: '#ffffff', metalness: 0, roughness: 0.4, emissive: '#39d0ff', emissiveIntensity: 2.2, transmission: 0 },
    matte: { baseColor: '#cfd6e4', metalness: 0, roughness: 0.9, clearcoat: 0, transmission: 0 },
    gold: { baseColor: '#ffcf5c', metalness: 1, roughness: 0.18, clearcoat: 0.2, transmission: 0 },
    chrome: { baseColor: '#f2f5f9', metalness: 1, roughness: 0.03, clearcoat: 0, transmission: 0 },
    rubber: { baseColor: '#26282e', metalness: 0, roughness: 0.85, clearcoat: 0, transmission: 0 },
    emerald: { baseColor: '#0f8f5f', metalness: 0.1, roughness: 0.12, transmission: 0.35, ior: 1.7, thickness: 1.2, clearcoat: 1 },
  } as Record<MaterialPresetId, Partial<MaterialData>>;
  return { ...(presets[id] ?? {}), ...patch };
}

export const MATERIAL_PRESET_IDS: MaterialPresetId[] = [
  'plastic', 'metal', 'glass', 'wood', 'stone', 'fabric', 'neon', 'matte', 'gold', 'chrome', 'rubber', 'emerald',
];

export function defaultPhysics(): ObjectPhysics {
  return { enabled: false, dynamic: true, mass: 1, restitution: 0.25, shape: 'box', trigger: false };
}

export function defaultSnap(): SnapSettings {
  return { enabled: false, grid: 0.25, angle: 15, scale: 0.1, toObjects: false };
}

export function defaultEnvironment(): EnvironmentSettings {
  return { preset: 'room', intensity: 1, rotation: 0, background: false };
}

export function defaultFog(): FogSettings {
  return { enabled: false, color: '#11141b', near: 8, far: 60 };
}

export function defaultPostFx(): PostFxSettings {
  return { enabled: false, bloom: 0.45, vignette: 0.35, grain: 0.08, dof: 0 };
}

export function defaultLayout(): LayoutState {
  return {
    railW: 132, leftW: 230, rightW: 300, timelineH: 168,
    showRail: true, showOutliner: true, showInspector: true, showTimeline: true,
    mobileSheet: 'none',
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
    pivot: v3(),
    baked: null,
    collectionIds: [],
    physics: null,
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
    collections: [],
    cameraBookmarks: [],
    activity: [],
    uiLayout: null,
  };
}

function starterMaterial(name: string, patch: Partial<MaterialData>): MaterialData {
  return { ...defaultMaterial(name), ...patch, updatedAt: nowIso() };
}

function starterObject(
  kind: PrimitiveType | 'light' | 'group',
  name: string,
  opts: {
    materialId?: string | null;
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
    light?: Partial<LightData>;
    parentId?: string | null;
    pivot?: Vec3;
  } = {},
): SceneObjectData {
  const obj = defaultObject(kind, name);
  obj.materialId = opts.materialId ?? obj.materialId;
  obj.position = opts.position ?? obj.position;
  obj.rotation = opts.rotation ?? obj.rotation;
  obj.scale = opts.scale ?? obj.scale;
  obj.parentId = opts.parentId ?? null;
  if (opts.pivot) obj.pivot = opts.pivot;
  if (kind === 'light') obj.light = { ...defaultLight('point'), ...(opts.light ?? {}) };
  return obj;
}

const d2r = (deg: number): number => (deg * Math.PI) / 180;

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

  if (template === 'room') {
    const wallMat = starterMaterial('Wall', { baseColor: '#e8e3da', roughness: 0.95, metalness: 0, updatedAt: nowIso() });
    const woodMat = starterMaterial('Walnut', { ...materialPreset('wood', { baseColor: '#8b5e34' }), updatedAt: nowIso() });
    const rugMat = starterMaterial('Rug', { baseColor: '#4b5568', roughness: 0.98, metalness: 0, updatedAt: nowIso() });
    const fabricMat = starterMaterial('Cushion', { ...materialPreset('fabric', { baseColor: '#3f6f8f' }), updatedAt: nowIso() });
    doc.materials.push(wallMat, woodMat, rugMat, fabricMat);
    const room = starterObject('group', 'Room');
    doc.objects = [
      room,
      starterObject('plane', 'Floor', { materialId: woodMat.id, parentId: room.id, scale: v3(7, 1, 7) }),
      starterObject('plane', 'Ceiling', { materialId: wallMat.id, parentId: room.id, position: v3(0, 3, 0), rotation: v3(d2r(90), 0, 0), scale: v3(7, 1, 7) }),
      starterObject('plane', 'Wall back', { materialId: wallMat.id, parentId: room.id, position: v3(0, 1.5, -3.5), scale: v3(7, 3, 1) }),
      starterObject('plane', 'Wall left', { materialId: wallMat.id, parentId: room.id, position: v3(-3.5, 1.5, 0), rotation: v3(0, d2r(90), 0), scale: v3(7, 3, 1) }),
      starterObject('plane', 'Rug', { materialId: rugMat.id, parentId: room.id, position: v3(0, 0.02, 0.4), rotation: v3(d2r(-90), 0, 0), scale: v3(4, 2.6, 1) }),
      starterObject('cube', 'Sofa base', { materialId: fabricMat.id, parentId: room.id, position: v3(-1.6, 0.32, 1.2), scale: v3(2.2, 0.5, 0.9) }),
      starterObject('cube', 'Sofa back', { materialId: fabricMat.id, parentId: room.id, position: v3(-1.6, 0.62, 1.6), scale: v3(2.2, 0.6, 0.24) }),
      starterObject('cylinder', 'Table top', { materialId: woodMat.id, parentId: room.id, position: v3(0.9, 0.42, 0.4), scale: v3(0.7, 0.06, 0.7) }),
      starterObject('cylinder', 'Table leg', { materialId: woodMat.id, parentId: room.id, position: v3(0.9, 0.2, 0.4), scale: v3(0.09, 0.42, 0.09) }),
      starterObject('sphere', 'Lamp shade', { materialId: glow.id, parentId: room.id, position: v3(2.4, 1.55, -1.6), scale: v3(0.28, 0.28, 0.28) }),
      starterObject('cylinder', 'Lamp stand', { materialId: woodMat.id, parentId: room.id, position: v3(2.4, 0.75, -1.6), scale: v3(0.05, 1.5, 0.05) }),
      starterObject('light', 'Window light', { parentId: room.id, position: v3(2.5, 2.4, 1.8), light: { kind: 'directional', intensity: 1.6, castShadow: true } }),
      starterObject('light', 'Lamp light', { parentId: room.id, position: v3(2.4, 1.5, -1.6), light: { kind: 'point', intensity: 9, distance: 9 } }),
      starterObject('light', 'Ambient fill', { parentId: room.id, position: v3(0, 2.4, 0), light: { kind: 'hemisphere', intensity: 0.7 } }),
    ];
    doc.materials.push(glow);
    doc.settings.environment = { preset: 'studio', intensity: 1.05, rotation: 0, background: false };
    doc.settings.fog = { enabled: false, color: '#11141b', near: 8, far: 60 };
  }

  if (template === 'game') {
    const groundMat = starterMaterial('Terrain', { baseColor: '#3c7a4b', roughness: 0.95, metalness: 0, updatedAt: nowIso() });
    const rockMat = starterMaterial('Rock', { ...materialPreset('stone', { baseColor: '#7c8794' }), updatedAt: nowIso() });
    const coinMat = starterMaterial('Coin', { baseColor: '#ffd166', metalness: 0.9, roughness: 0.2, emissive: '#ff9f1c', emissiveIntensity: 0.6, updatedAt: nowIso() });
    doc.materials.push(groundMat, rockMat, coinMat, glow);
    const level = starterObject('group', 'Level');
    doc.objects = [
      level,
      starterObject('plane', 'Ground', { materialId: groundMat.id, parentId: level.id, rotation: v3(d2r(-90), 0, 0), scale: v3(24, 1, 24) }),
      starterObject('cube', 'Platform A', { materialId: rockMat.id, parentId: level.id, position: v3(-3, 0.5, -2), scale: v3(2.4, 0.5, 2.4) }),
      starterObject('cube', 'Platform B', { materialId: rockMat.id, parentId: level.id, position: v3(2.6, 1.1, -4.2), scale: v3(2.2, 0.5, 2.2) }),
      starterObject('cube', 'Ramp', { materialId: rockMat.id, parentId: level.id, position: v3(0, 0.45, -6.2), rotation: v3(0, 0, d2r(-24)), scale: v3(3, 0.4, 2.4) }),
      starterObject('cylinder', 'Pillar', { materialId: rockMat.id, parentId: level.id, position: v3(5.2, 1.4, 1.2), scale: v3(0.45, 2.8, 0.45) }),
      starterObject('cylinder', 'Pillar 2', { materialId: rockMat.id, parentId: level.id, position: v3(-5.4, 1.4, 2.6), scale: v3(0.45, 2.8, 0.45) }),
      starterObject('sphere', 'Coin 1', { materialId: coinMat.id, parentId: level.id, position: v3(-3, 1.4, -2), scale: v3(0.22, 0.22, 0.22) }),
      starterObject('sphere', 'Coin 2', { materialId: coinMat.id, parentId: level.id, position: v3(2.6, 2, -4.2), scale: v3(0.22, 0.22, 0.22) }),
      starterObject('cube', 'Spawn pad', { materialId: glow.id, parentId: level.id, position: v3(0, 0.03, 4.6), scale: v3(1.6, 0.06, 1.6) }),
      starterObject('light', 'Sun', { parentId: level.id, position: v3(6, 8, 4), light: { kind: 'directional', intensity: 1.9, castShadow: true } }),
      starterObject('light', 'Sky', { parentId: level.id, position: v3(0, 4, 0), light: { kind: 'hemisphere', intensity: 0.8 } }),
    ];
    // playable: ground and platforms are static bodies, coins are triggers
    for (const o of doc.objects) {
      if (o.type !== 'light' && o.name !== 'Level') o.physics = defaultPhysics();
    }
    for (const o of doc.objects) {
      if (o.name.startsWith('Coin')) {
        o.physics = { ...defaultPhysics(), enabled: true, dynamic: false, trigger: true, shape: 'sphere' };
      } else if (o.physics) {
        o.physics = { ...o.physics, enabled: true, dynamic: false, shape: o.name === 'Ground' ? 'plane' : 'box' };
      }
    }
    doc.settings.environment = { preset: 'studio', intensity: 1.1, rotation: 0, background: true };
    doc.settings.fog = { enabled: true, color: '#9fc7e8', near: 18, far: 70 };
    doc.settings.postfx = { enabled: true, bloom: 0.4, vignette: 0.3, grain: 0.05, dof: 0 };
  }

  if (template === 'character') {
    const skinMat = starterMaterial('Skin', { baseColor: '#e8b48c', roughness: 0.62, metalness: 0, updatedAt: nowIso() });
    const clothMat = starterMaterial('Cloth', { ...materialPreset('fabric', { baseColor: '#4f7ef7' }), updatedAt: nowIso() });
    const darkMat = starterMaterial('Boots', { baseColor: '#2b2f38', roughness: 0.7, metalness: 0.05, updatedAt: nowIso() });
    doc.materials.push(skinMat, clothMat, darkMat);
    const rig = starterObject('group', 'Character');
    doc.objects = [
      rig,
      starterObject('cylinder', 'Torso', { materialId: clothMat.id, parentId: rig.id, position: v3(0, 1.05, 0), scale: v3(0.52, 0.85, 0.34) }),
      starterObject('sphere', 'Head', { materialId: skinMat.id, parentId: rig.id, position: v3(0, 1.72, 0), scale: v3(0.36, 0.4, 0.34) }),
      starterObject('sphere', 'Eye L', { materialId: darkMat.id, parentId: rig.id, position: v3(-0.13, 1.76, 0.3), scale: v3(0.06, 0.06, 0.04) }),
      starterObject('sphere', 'Eye R', { materialId: darkMat.id, parentId: rig.id, position: v3(0.13, 1.76, 0.3), scale: v3(0.06, 0.06, 0.04) }),
      starterObject('cylinder', 'Arm L', { materialId: clothMat.id, parentId: rig.id, position: v3(-0.38, 1.12, 0), rotation: v3(0, 0, d2r(12)), scale: v3(0.12, 0.72, 0.12) }),
      starterObject('cylinder', 'Arm R', { materialId: clothMat.id, parentId: rig.id, position: v3(0.38, 1.12, 0), rotation: v3(0, 0, d2r(-12)), scale: v3(0.12, 0.72, 0.12) }),
      starterObject('sphere', 'Hand L', { materialId: skinMat.id, parentId: rig.id, position: v3(-0.45, 0.74, 0), scale: v3(0.12, 0.12, 0.12) }),
      starterObject('sphere', 'Hand R', { materialId: skinMat.id, parentId: rig.id, position: v3(0.45, 0.74, 0), scale: v3(0.12, 0.12, 0.12) }),
      starterObject('cylinder', 'Leg L', { materialId: clothMat.id, parentId: rig.id, position: v3(-0.16, 0.35, 0), scale: v3(0.15, 0.7, 0.15) }),
      starterObject('cylinder', 'Leg R', { materialId: clothMat.id, parentId: rig.id, position: v3(0.16, 0.35, 0), scale: v3(0.15, 0.7, 0.15) }),
      starterObject('cube', 'Boot L', { materialId: darkMat.id, parentId: rig.id, position: v3(-0.16, 0.06, 0.05), scale: v3(0.2, 0.12, 0.3) }),
      starterObject('cube', 'Boot R', { materialId: darkMat.id, parentId: rig.id, position: v3(0.16, 0.06, 0.05), scale: v3(0.2, 0.12, 0.3) }),
      starterObject('light', 'Key light', { position: v3(2.6, 3.4, 3), light: { kind: 'directional', intensity: 1.7, castShadow: true } }),
      starterObject('light', 'Rim light', { position: v3(-2.6, 2.4, -2.6), light: { kind: 'point', intensity: 12, distance: 16 } }),
    ];
    bodyParts: for (const o of doc.objects) {
      if (o.name === 'Character') continue bodyParts;
      o.physics = o.type === 'light' ? null : { ...defaultPhysics(), enabled: false, shape: 'box' };
    }
    doc.settings.environment = { preset: 'studio', intensity: 1, rotation: 0, background: false };
  }

  if (template === 'solar') {
    const sunMat = starterMaterial('Sun surface', { baseColor: '#fff3c4', emissive: '#ffb703', emissiveIntensity: 2.4, roughness: 0.5, metalness: 0, updatedAt: nowIso() });
    const planetMats = [
      starterMaterial('Mercury', { baseColor: '#9c8f84', roughness: 0.85, metalness: 0.1, updatedAt: nowIso() }),
      starterMaterial('Venus', { baseColor: '#e6b877', roughness: 0.7, metalness: 0.05, updatedAt: nowIso() }),
      starterMaterial('Earth', { baseColor: '#3f7fd6', roughness: 0.6, metalness: 0.05, updatedAt: nowIso() }),
      starterMaterial('Mars', { baseColor: '#c1553a', roughness: 0.9, metalness: 0.05, updatedAt: nowIso() }),
    ];
    const ringMat = starterMaterial('Orbit', { baseColor: '#5b6a99', roughness: 0.5, emissive: '#2b3a66', emissiveIntensity: 0.35, transparent: true, opacity: 0.5, updatedAt: nowIso() });
    doc.materials.push(sunMat, ringMat, ...planetMats);
    const system = starterObject('group', 'Solar System');
    const planets: { name: string; radius: number; size: number; mat: string }[] = [
      { name: 'Mercury', radius: 1.6, size: 0.14, mat: planetMats[0].id },
      { name: 'Venus', radius: 2.3, size: 0.2, mat: planetMats[1].id },
      { name: 'Earth', radius: 3.1, size: 0.22, mat: planetMats[2].id },
      { name: 'Mars', radius: 4, size: 0.17, mat: planetMats[3].id },
    ];
    doc.objects = [
      system,
      starterObject('sphere', 'Sun', { materialId: sunMat.id, parentId: system.id, scale: v3(0.62, 0.62, 0.62) }),
      starterObject('light', 'Sun light', { parentId: system.id, light: { kind: 'point', intensity: 26, distance: 0 } }),
    ];
    for (const p of planets) {
      doc.objects.push(starterObject('torus', `${p.name} orbit`, {
        materialId: ringMat.id, parentId: system.id, rotation: v3(d2r(90), 0, 0), scale: v3(p.radius, p.radius, 1),
      }));
      doc.objects.push(starterObject('sphere', p.name, {
        materialId: p.mat, parentId: system.id, position: v3(p.radius, 0, 0), scale: v3(p.size, p.size, p.size),
      }));
    }
    // Orbit animation: every planet sweeps a full circle over the clip.
    const clip = doc.clips[0];
    clip.name = 'Orbit';
    clip.length = 240;
    clip.fps = 30;
    const planetObjs = doc.objects.filter((o) => planets.some((p) => p.name === o.name));
    for (const o of planetObjs) {
      const r = planets.find((p) => p.name === o.name)?.radius ?? 2;
      const phase = planets.findIndex((p) => p.name === o.name) * 0.4;
      const keys: Keyframe[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = (i / 8) * Math.PI * 2 + phase;
        keys.push({ frame: Math.round((i / 8) * clip.length), value: [Math.cos(t) * r, 0, Math.sin(t) * r], interp: 'linear' });
      }
      clip.tracks.push({ id: uid(), objectId: o.id, property: 'position', keyframes: keys });
    }
    doc.settings.environment = { preset: 'void', intensity: 0.35, rotation: 0, background: true };
    doc.settings.postfx = { enabled: true, bloom: 0.7, vignette: 0.4, grain: 0.05, dof: 0 };
  }

  if (template === 'animation') {
    const stageMat = starterMaterial('Stage', { baseColor: '#1d2331', roughness: 0.9, metalness: 0.05, updatedAt: nowIso() });
    const ballMat = starterMaterial('Ball', { baseColor: '#ff6b6b', roughness: 0.25, metalness: 0.05, clearcoat: 0.6, updatedAt: nowIso() });
    doc.materials.push(stageMat, ballMat);
    doc.objects = [
      starterObject('plane', 'Floor', { materialId: stageMat.id, rotation: v3(d2r(-90), 0, 0), scale: v3(10, 1, 10) }),
      starterObject('sphere', 'Ball', { materialId: ballMat.id, position: v3(0, 0.4, 0), scale: v3(0.4, 0.4, 0.4) }),
      starterObject('cube', 'Marker', { materialId: glow.id, position: v3(1.6, 0.05, 0), scale: v3(1.2, 0.1, 1.2) }),
      starterObject('light', 'Key light', { position: v3(3, 5, 2.4), light: { kind: 'directional', intensity: 1.8, castShadow: true } }),
      starterObject('light', 'Fill', { position: v3(-2, 1.6, 2), light: { kind: 'point', intensity: 10, distance: 14 } }),
    ];
    const ball = doc.objects.find((o) => o.name === 'Ball');
    const clip = doc.clips[0];
    clip.name = 'Bounce';
    clip.length = 60;
    clip.fps = 30;
    if (ball) {
      // bounce (squash on impact) — a ready-made demo of the timeline
      const frames = [0, 10, 20, 30, 40, 50, 60];
      const heights = [0.4, 2.1, 0.4, 1.6, 0.4, 0.9, 0.4];
      const squash = [1, 1, 1.35, 1, 1.25, 1, 1];
      clip.tracks.push({
        id: uid(), objectId: ball.id, property: 'position',
        keyframes: frames.map((f, i) => ({ frame: f, value: [0, heights[i], 0] as [number, number, number], interp: i % 2 === 1 ? 'easeOut' : 'easeIn' })),
      });
      clip.tracks.push({
        id: uid(), objectId: ball.id, property: 'scale',
        keyframes: frames.map((f, i) => ({ frame: f, value: [squash[i], 2 - squash[i], squash[i]] as [number, number, number], interp: 'ease' })),
      });
    }
    doc.materials.push(glow);
    doc.settings.environment = { preset: 'studio', intensity: 1, rotation: 0, background: false };
  }

  if (template === 'logo') {
    const markMat = starterMaterial('Mark', { baseColor: '#5b8cff', metalness: 0.35, roughness: 0.2, clearcoat: 0.8, updatedAt: nowIso() });
    const accentMat = starterMaterial('Accent', { baseColor: '#ff7ad9', metalness: 0.2, roughness: 0.15, emissive: '#ff4fc3', emissiveIntensity: 0.55, updatedAt: nowIso() });
    const backMat = starterMaterial('Backdrop', { baseColor: '#0e1117', roughness: 0.95, metalness: 0, updatedAt: nowIso() });
    doc.materials.push(markMat, accentMat, backMat);
    const mark = starterObject('group', 'Logo');
    doc.objects = [
      mark,
      starterObject('plane', 'Backdrop', { materialId: backMat.id, parentId: mark.id, position: v3(0, 0, -0.6), scale: v3(8, 4.5, 1) }),
      starterObject('torus', 'Ring', { materialId: markMat.id, parentId: mark.id, position: v3(-0.55, 0, 0), scale: v3(0.9, 0.9, 1) }),
      starterObject('cube', 'Bar', { materialId: markMat.id, parentId: mark.id, position: v3(0.25, 0.35, 0), rotation: v3(0, 0, d2r(-18)), scale: v3(1.5, 0.28, 0.28) }),
      starterObject('cube', 'Bar 2', { materialId: accentMat.id, parentId: mark.id, position: v3(0.1, -0.35, 0), rotation: v3(0, 0, d2r(-18)), scale: v3(1.5, 0.28, 0.28) }),
      starterObject('sphere', 'Dot', { materialId: accentMat.id, parentId: mark.id, position: v3(1.15, 0, 0.1), scale: v3(0.22, 0.22, 0.22) }),
      starterObject('light', 'Rim', { position: v3(-2, 2, 3), light: { kind: 'directional', intensity: 1.5 } }),
      starterObject('light', 'Glow', { position: v3(2.4, -1.4, 2), light: { kind: 'point', intensity: 12, distance: 12 } }),
    ];
    doc.settings.environment = { preset: 'studio', intensity: 1.1, rotation: 0, background: true };
    doc.settings.postfx = { enabled: true, bloom: 0.55, vignette: 0.4, grain: 0.06, dof: 0 };
    doc.cameraBookmarks = [{ id: uid(), name: 'Front', camera: { type: 'perspective', position: v3(0, 0, 6.2), target: v3(0, 0, 0), fov: 40 } }];
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
  if (!Array.isArray(doc.collections)) doc.collections = [];
  if (!Array.isArray(doc.cameraBookmarks)) doc.cameraBookmarks = [];
  if (!Array.isArray(doc.activity)) doc.activity = [];
  if (doc.uiLayout === undefined) doc.uiLayout = null;
  for (const m of doc.materials) {
    if (m.side === undefined) m.side = 'front';
    if (m.flatShading === undefined) m.flatShading = false;
    if (m.mapAssetId === undefined) m.mapAssetId = null;
    if (m.emissiveIntensity === undefined) m.emissiveIntensity = 0;
    // material editor fields (PBR extension)
    if (m.normalMapAssetId === undefined) m.normalMapAssetId = null;
    if (typeof m.normalScale !== 'number') m.normalScale = 1;
    if (m.aoMapAssetId === undefined) m.aoMapAssetId = null;
    if (typeof m.aoIntensity !== 'number') m.aoIntensity = 1;
    if (typeof m.transmission !== 'number') m.transmission = 0;
    if (typeof m.ior !== 'number') m.ior = 1.5;
    if (typeof m.thickness !== 'number') m.thickness = 0.5;
    if (typeof m.clearcoat !== 'number') m.clearcoat = 0;
    if (typeof m.clearcoatRoughness !== 'number') m.clearcoatRoughness = 0.1;
  }
  for (const o of doc.objects) {
    if (o.type === 'light' && !o.light) o.light = defaultLight('point');
    if (!o.pivot) o.pivot = v3();
    if (o.baked === undefined) o.baked = null;
    if (!Array.isArray(o.collectionIds)) o.collectionIds = [];
    // drop links to collections that no longer exist
    if (o.collectionIds.length && doc.collections.length) {
      const alive = new Set(doc.collections.map((c) => c.id));
      o.collectionIds = o.collectionIds.filter((id) => alive.has(id));
    }
    if (o.physics === undefined) o.physics = null;
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
