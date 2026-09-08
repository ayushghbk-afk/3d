import { uid, nowIso } from '../lib/utils.js';

export type ProjectMode = 'solo' | 'team';
export type TeamRole = 'owner' | 'admin' | 'editor' | 'animator' | 'viewer';
export type PrimitiveType = 'cube' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'torus';
export type ObjectType = PrimitiveType | 'group' | 'imported' | 'light';
export type ShadingMode = 'solid' | 'material' | 'wireframe';
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type CameraType = 'perspective' | 'orthographic';
export type SelectionMode = 'object' | 'vertex' | 'edge' | 'face';

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
  updatedAt: string;
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
  createdAt: string;
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
  activeClipId: string | null;
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
    updatedAt: nowIso(),
  };
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
    assetId: null,
    updatedAt: nowIso(),
    version: 1,
  };
}

export function defaultClip(name = 'Clip 1'): AnimClip {
  return { id: uid(), name, fps: 30, length: 90, tracks: [] };
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
    activeClipId: clip.id,
    updatedAt: nowIso(),
    version: 1,
    cloudVersion: 0,
  };
}
