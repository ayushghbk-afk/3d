// Shared AI + Agent API types. No runtime imports — safe to load anywhere.

export type AgentScope = 'read' | 'write' | 'generate';

export interface AgentTokenMeta {
  id: string;
  label: string;
  /** sha256 hex of the secret (the secret itself is shown once, at creation). */
  secretHash: string;
  scopes: AgentScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  calls: number;
}

export interface AgentActivityEntry {
  at: string;
  actor: string; // token label or transport id
  method: string;
  projectId: string | null;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ImageGenOptions {
  width?: number;
  height?: number;
  seed?: number;
  model?: string;
  signal?: AbortSignal;
  /** Extra prompt suffix is applied by the caller; kept here for logging. */
  style?: string;
}

export interface ImageGenResult {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  seed: number;
  provider: string;
  prompt: string;
  /**
   * Model the provider actually asked for — the free Pollinations tier swaps
   * unsupported names (flux → sana), so this is what really produced the image.
   */
  model?: string;
  /** Which access path served the request. */
  tier?: 'keyed' | 'anonymous';
  /** Set when the preferred path (e.g. a configured key) failed and the free
   * tier served the request instead — the image is fine, the setup is not. */
  warning?: string;
}

export interface MeshGenOptions {
  /** Marching-cubes / quality hint understood by the provider. */
  quality?: 'fast' | 'balanced' | 'high';
  signal?: AbortSignal;
  onProgress?: (stage: string, fraction: number) => void;
}

export interface MeshGenResult {
  glb: ArrayBuffer;
  provider: string;
  prompt: string;
  /** Preview image used for image-to-3D (data URL), when applicable. */
  previewDataUrl?: string | null;
}

export type AgentTransport = 'page' | 'postmessage' | 'channel' | 'relay';

/** Narrow structural host so the agent works with a live EditorSession or headless. */
export interface AgentSessionLike {
  doc: import('../state/models.js').ProjectDoc;
  addPrimitive(kind: import('../state/models.js').PrimitiveType): import('../state/models.js').SceneObjectData;
  addGroup(): import('../state/models.js').SceneObjectData;
  addLight(kind?: import('../state/models.js').LightKind): import('../state/models.js').SceneObjectData;
  deleteObject(id?: string): void;
  duplicateObject(id?: string): void;
  renameObject(id: string, name: string): void;
  setParent(childId: string, parentId: string | null): void;
  toggleVisible(id: string): void;
  toggleLock(id: string): void;
  setTransform(
    id: string,
    pos?: Partial<import('../state/models.js').SceneObjectData['position']>,
    rotDeg?: { x?: number; y?: number; z?: number },
    scl?: Partial<import('../state/models.js').SceneObjectData['scale']>,
  ): void;
  updateLight(id: string, patch: Partial<import('../state/models.js').LightData>): void;
  addMaterial(name?: string): import('../state/models.js').MaterialData;
  updateMaterial(id: string, patch: Partial<import('../state/models.js').MaterialData>): void;
  assignMaterial(objectId: string, materialId: string | null): void;
  importGlbBytes(name: string, buf: ArrayBuffer, filename?: string): Promise<import('../state/models.js').SceneObjectData | null>;
  uploadTexture(materialId: string, file: File): Promise<void>;
  undo(): void;
  redo(): void;
  forceSave(): Promise<void>;
  markDirty(kind: string): void;
  checkpoint(label: string): void;
  applyPaint(
    items: { objectId: string; materialName: string; patch: Partial<import('../state/models.js').MaterialData> }[],
  ): { objectId: string; materialId: string }[];
  getCamera(): import('../state/models.js').CameraState;
  setCamera(patch: Partial<import('../state/models.js').CameraState>, persist?: boolean): void;
  orbitCamera(azimuthDeg: number, polarDeg: number, distance?: number): void;
  focus(id: string | null): void;
  play(): void;
  pause(): void;
  stop(): void;
  setFrame(n: number): void;
  getPlayback(): { playing: boolean; frame: number; length: number; fps: number };
  addScript(patch?: Partial<import('../state/models.js').SceneScript>): import('../state/models.js').SceneScript;
  updateScript(id: string, patch: Partial<Pick<import('../state/models.js').SceneScript, 'name' | 'code' | 'enabled' | 'trigger'>>): import('../state/models.js').SceneScript;
  deleteScript(id: string): void;
  runScript(id: string): Promise<{ ok: boolean; scriptId: string; logs: string[]; error?: string; ms: number }>;
  runAdhoc(code: string): Promise<{ ok: boolean; scriptId: string; logs: string[]; error?: string; ms: number }>;
  generateTexture(prompt: string, opts?: { materialId?: string; objectId?: string; size?: number; seamless?: boolean }): Promise<{ materialId: string; provider: string; seed: number }>;
  canGenerate: boolean;
}
