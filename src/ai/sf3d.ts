// FREE 3D generator (best quality): Stable Fast 3D (Stability AI) on the
// public Hugging Face Space — no signup, no key. Game-ready meshes with UVs,
// PBR-ish textures and illumination disentanglement.
//
// Unlike TripoSR this demo is a multi-step flow sharing server-side State, so
// we drive it like its own UI does (one session hash for the whole chain):
//   1. background check  → "Run" (already transparent) or "Remove Background"
//   2. "Remove Background" (server rembg) — only when step 1 asks for it
//   3. "Run" → GLB download
import type { ImageGenResult, MeshGenOptions, MeshGenResult } from './types.js';
import { ProviderError, blobToDataUrl, type ImageProvider, type MeshProvider } from './providers.js';
import {
  GradioSpaceClient, makeFileData, newSessionHash, scanOutputsForFile, type GradioConfig,
} from './gradio.js';

export const DEFAULT_SF3D_SPACE = 'https://stabilityai-stable-fast-3d.hf.space';
const TEXTURE_SIZE: Record<NonNullable<MeshGenOptions['quality']>, number> = {
  fast: 512,
  balanced: 1024,
  high: 2048,
};
const FOREGROUND_RATIO = 0.85;

export interface Sf3dDeps {
  requiresFn: number;
  runFn: number;
}

/** Locate the background-check dep and the run dep (pure, unit-tested). */
export function findSf3dDeps(config: GradioConfig): Sf3dDeps {
  const byId = new Map<number, string>();
  for (const c of config.components ?? []) byId.set(c.id, String(c.type).toLowerCase());
  const typeOf = (id: number): string => byId.get(id) ?? '';
  const isModelOutput = (id: number): boolean => typeOf(id).includes('model3d');
  let requiresFn = -1;
  let runFn = -1;
  for (const d of config.dependencies ?? []) {
    const ins = d.inputs ?? [];
    const outs = d.outputs ?? [];
    if (!ins.length) continue;
    // Background check: (image, foreground-ratio) → …, states, …
    if (
      requiresFn === -1 &&
      typeOf(ins[0]).includes('image') &&
      outs.some((o) => typeOf(o) === 'state')
    ) {
      requiresFn = d.id;
      continue;
    }
    // Run: (button, image, bg-state, ratio, remesh, verts, texture) → …, 3D, …
    if (
      runFn === -1 &&
      typeOf(ins[0]).includes('button') &&
      ins.length >= 5 &&
      outs.some(isModelOutput)
    ) {
      runFn = d.id;
    }
  }
  if (requiresFn === -1 || runFn === -1) {
    throw new ProviderError('sf3d', 'The SF3D Space changed its UI — could not find the Generate flow. Try another model instead.');
  }
  return { requiresFn, runFn };
}

/** Read the run-button state from step-1 outputs (raw or gr.update dict). */
export function parseRunButtonValue(output: unknown): 'Run' | 'Remove Background' {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | null => {
    if (typeof node === 'string') {
      return node === 'Run' || node === 'Remove Background' ? node : null;
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.value === 'string' && (rec.value === 'Run' || rec.value === 'Remove Background')) {
      return rec.value;
    }
    for (const v of Object.values(rec)) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  };
  // Unparseable → run background removal (safe + idempotent) rather than
  // crashing the chain on a UI serialization change.
  return walk(output) === 'Run' ? 'Run' : 'Remove Background';
}

export interface Sf3dOptions {
  spaceUrl?: string;
  hfToken?: string;
  imageProvider: ImageProvider;
}

export class Sf3dMeshProvider implements MeshProvider {
  id = 'sf3d';
  label = 'Stable Fast 3D (Hugging Face Space)';
  free = true;
  private client: GradioSpaceClient;
  private images: ImageProvider;

  constructor(opts: Sf3dOptions) {
    this.client = new GradioSpaceClient(opts.spaceUrl || DEFAULT_SF3D_SPACE, opts.hfToken || '', 'sf3d');
    this.images = opts.imageProvider;
  }

  async textTo3D(prompt: string, opts: MeshGenOptions = {}): Promise<MeshGenResult> {
    const clean = prompt.trim().slice(0, 500);
    if (!clean) throw new Error('Describe the model first.');
    opts.onProgress?.('generating reference image', 0.05);
    const photoPrompt = `${clean}, single centered object, studio product photo, plain light background, no text, no watermark`;
    let ref: ImageGenResult;
    try {
      ref = await this.images.generateImage(photoPrompt, {
        width: 512,
        height: 512,
        signal: opts.signal,
        style: 'sf3d-reference',
      });
    } catch (e) {
      throw new ProviderError('sf3d', `Reference image failed: ${(e as Error).message}`, true);
    }
    const result = await this.imageTo3D(ref.blob, {
      ...opts,
      onProgress: (stage, frac) => opts.onProgress?.(stage, 0.12 + frac * 0.88),
    });
    result.prompt = clean;
    try {
      result.previewDataUrl = await blobToDataUrl(ref.blob);
    } catch {
      result.previewDataUrl = null;
    }
    return result;
  }

  async imageTo3D(image: Blob, opts: MeshGenOptions = {}): Promise<MeshGenResult> {
    const textureSize = TEXTURE_SIZE[opts.quality ?? 'balanced'] ?? 1024;
    const progress = opts.onProgress ?? ((): void => undefined);
    const { signal } = opts;

    progress('waking the free 3D service', 0.02);
    const config = await this.client.fetchConfig(signal, progress);
    const { requiresFn, runFn } = findSf3dDeps(config);

    progress('uploading image', 0.1);
    const serverPath = await this.client.uploadImage(image, signal);
    const fileData = makeFileData(serverPath, 'input.png', image.size, image.type || 'image/png');
    const session = newSessionHash(); // shared: server State persists across steps

    // Step 1: background check.
    const checkOutputs = await this.client.callFn(requiresFn, [fileData, FOREGROUND_RATIO], session, {
      signal,
      onProgress: (stage, frac) => progress(stage === 'reconstructing 3D' ? 'checking background' : stage, 0.12 + frac * 0.15),
    });
    const runState = parseRunButtonValue(checkOutputs[0]);

    // Step 2 (sometimes): server-side background removal → sets the states.
    if (runState === 'Remove Background') {
      progress('removing background', 0.3);
      await this.client.callFn(runFn, ['Remove Background', fileData, null, FOREGROUND_RATIO, 'None', -1, textureSize], session, {
        signal,
        onProgress: (stage, frac) => progress(stage === 'reconstructing 3D' ? 'removing background' : stage, 0.3 + frac * 0.2),
      });
    }

    // Step 3: generate.
    const outputs = await this.client.callFn(runFn, ['Run', fileData, null, FOREGROUND_RATIO, 'None', -1, textureSize], session, {
      signal,
      onProgress: (stage, frac) => progress(stage, 0.5 + frac * 0.4),
    });
    const glbFile = scanOutputsForFile(outputs, '.glb');
    if (!glbFile) {
      throw new ProviderError('sf3d', 'The 3D Space finished without a model file.', true);
    }
    progress('downloading model', 0.92);
    const glb = await this.client.downloadGlb(glbFile, signal);
    progress('done', 1);
    return { glb, provider: this.id, prompt: '', previewDataUrl: null };
  }

  async test(): Promise<string> {
    const started = Date.now();
    const config = await this.client.fetchConfig(undefined, () => undefined);
    const deps = findSf3dDeps(config);
    return `SF3D Space reachable in ${Date.now() - started}ms (flow #${deps.requiresFn} → #${deps.runFn} found, free tier OK).`;
  }
}
