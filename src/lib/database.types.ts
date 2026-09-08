// TypeScript types mirroring supabase/migrations/20260908000000_init.sql
// Keep in sync with the migration. UUIDs as strings, timestamps as ISO strings.

export type TeamRole = 'owner' | 'admin' | 'editor' | 'animator' | 'viewer';
export type ProjectMode = 'solo' | 'team';

export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  mode: ProjectMode;
  owner_id: string;
  thumbnail_url: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: TeamRole;
  created_at: string;
}

export interface Scene {
  id: string;
  project_id: string;
  name: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SceneObject {
  id: string;
  scene_id: string;
  project_id: string;
  name: string;
  object_type: string;
  parent_id: string | null;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  locked: boolean;
  material_id: string | null;
  geometry: Record<string, unknown> | null;
  asset_id: string | null;
  version: number;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  mime: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  folder_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Model3D {
  id: string;
  asset_id: string;
  project_id: string;
  format: string;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface Material {
  id: string;
  project_id: string;
  scene_id: string | null;
  name: string;
  base_color: string;
  metalness: number;
  roughness: number;
  emissive: string;
  emissive_intensity: number;
  opacity: number;
  transparent: boolean;
  side: string;
  flat_shading: boolean;
  map_asset_id: string | null;
  node_graph: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Texture {
  id: string;
  asset_id: string;
  project_id: string;
  slot: string;
  created_at: string;
}

export interface Animation {
  id: string;
  project_id: string;
  scene_id: string | null;
  name: string;
  fps: number;
  length_frames: number;
  created_at: string;
  updated_at: string;
}

export interface AnimationTrack {
  id: string;
  animation_id: string;
  object_id: string | null;
  property: string;
  created_at: string;
}

export interface Keyframe {
  id: string;
  track_id: string;
  frame: number;
  value: [number, number, number];
  interp: string;
  created_at: string;
}

export interface Folder {
  id: string;
  project_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

export interface ProjectVersion {
  id: string;
  project_id: string;
  version: number;
  label: string | null;
  snapshot: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export interface ProjectChange {
  id: string;
  project_id: string;
  user_id: string | null;
  kind: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile };
      projects: { Row: Project };
      project_members: { Row: ProjectMember };
      scenes: { Row: Scene };
      scene_objects: { Row: SceneObject };
      assets: { Row: Asset };
      models: { Row: Model3D };
      materials: { Row: Material };
      textures: { Row: Texture };
      animations: { Row: Animation };
      animation_tracks: { Row: AnimationTrack };
      keyframes: { Row: Keyframe };
      folders: { Row: Folder };
      project_versions: { Row: ProjectVersion };
      project_changes: { Row: ProjectChange };
    };
  };
}
