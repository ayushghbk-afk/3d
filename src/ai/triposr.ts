// FREE 3D generator (fast tier): TripoSR (Stability AI × Tripo AI,
// MIT-licensed) on the public Hugging Face Space — no signup, no key.
// Pipeline: text prompt → free image model → TripoSR image-to-3D → GLB.
import type { ImageGenResult, MeshGenOptions, MeshGenResult } from './types.js';
import { ProviderError, blobToDataUrl, type ImageProvider, type MeshProvider } from './providers.js';
import {
  GradioSpaceClient, makeFileData, newSessionHash,
  scanOutputsForFile, type GradioConfig, type SpaceFileData,
} from './gradio.js';

export const DEFAULT_TRIPOSR_SPACE = 'https://stabilityai-triposr.hf.space';
export { isGlb, makeFileData, parseUploadPaths } from './gradio.js';
const MC_RESOLUTION: Record<NonNullable<MeshGenOptions['quality']>, number> = {
  fast: 128,
  balanced: 192,
  high: 256,
};

/** Find the image→3D dependency: one image-ish input + a Model3D output. */
export function findGenerateFnIndex(config: GradioConfig): number {
  const byId = new Map<number, string>();
  for (const c of config.components ?? []) byId.set(c.id, String(c.type).toLowerCase());
  const isImageInput = (id: number): boolean => {
    const t = byId.get(id) ?? '';
    return t === 'image' || t === 'gr-image' || t.includes('image');
  };
  const isModelOutput = (id: number): boolean => {
    const t = byId.get(id) ?? '';
    return t === 'model3d' || t === 'model3D' || t.includes('model3d') || t.includes('model_3d');
  };
  const deps = config.dependencies ?? [];
  for (const d of deps) {
    const ins = d.inputs ?? [];
    const outs = d.outputs ?? [];
    if (ins.some(isImageInput) && outs.some(isModelOutput)) return d.id;
  }
  for (const d of deps) {
    if ((d.outputs ?? []).some(isModelOutput)) return d.id;
  }
  throw new ProviderError('triposr', 'The 3D Space changed its UI — could not find the Generate action. Try another model instead.');
}

/**
 * Build the queue/join `data` array from the Space's own config: the image
 * slot gets our file, quality-ish sliders get our resolution, everything else
 * gets its default. Survives UI drift and user-overridden Spaces.
 */
export function buildSpaceArgs(
  config: GradioConfig,
  fnIndex: number,
  file: SpaceFileData,
  mcResolution: number,
): unknown[] {
  const dep = (config.dependencies ?? []).find((d) => d.id === fnIndex);
  if (!dep) throw new ProviderError('triposr', 'The Generate action vanished from the 3D Space config — retry in a minute.');
  const byId = new Map<number, { type: string; props: Record<string, unknown> }>();
  for (const c of config.components ?? []) {
    byId.set(c.id, { type: String(c.type).toLowerCase(), props: (c.props ?? {}) as Record<string, unknown> });
  }
  let usedImage = false;
  const args = (dep.inputs ?? []).map((id) => {
    const comp = byId.get(id);
    const t = comp?.type ?? '';
    const props = comp?.props ?? {};
    if (t.includes('image') && !usedImage) {
      usedImage = true;
      return file;
    }
    if (t.includes('slider') || t.includes('number')) {
      const label = String(props.label ?? '').toLowerCase();
      if (label.includes('resolution') || label.includes('marching') || label.includes('mc_') || label.includes('quality') || !label) {
        return mcResolution;
      }
      return typeof props.value === 'number' ? props.value : 0;
    }
    if (t.includes('checkbox')) return props.value ?? false;
    if (t.includes('textbox') || t.includes('dropdown') || t.includes('radio')) return props.value ?? '';
    return props.value ?? null;
  });
  if (!usedImage) {
    throw new ProviderError('triposr', 'The 3D Space changed its inputs (no image slot found). Try another model instead.');
  }
  return args;
}

export interface TripoSROptions {
  spaceUrl?: string;
  hfToken?: string;
  imageProvider: ImageProvider;
}

export class TripoSRMeshProvider implements MeshProvider {
  id = 'triposr';
  label = 'TripoSR fast 3D (Hugging Face Space)';
  free = true;
  private client: GradioSpaceClient;
  private images: ImageProvider;
  private fnIndexCache: number | null = null;

  constructor(opts: TripoSROptions) {
    this.client = new GradioSpaceClient(opts.spaceUrl || DEFAULT_TRIPOSR_SPACE, opts.hfToken || '', 'triposr');
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
        style: 'triposr-reference',
      });
    } catch (e) {
      throw new ProviderError('triposr', `Reference image failed: ${(e as Error).message}`, true);
    }
    const result = await this.imageTo3D(ref.blob, {
      ...opts,
      onProgress: (stage, frac) => opts.onProgress?.(stage, 0.15 + frac * 0.85),
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
    const mcResolution = MC_RESOLUTION[opts.quality ?? 'balanced'] ?? 192;
    const progress = opts.onProgress ?? ((): void => undefined);
    const { signal } = opts;

    progress('waking the free 3D service', 0.02);
    const config = await this.client.fetchConfig(signal, progress);
    const fnIndex = this.discover(config);
    const serverPath = await this.client.uploadImage(image, signal);
    progress('uploading image', 0.12);
    const fileData = makeFileData(serverPath, 'input.png', image.size, image.type || 'image/png');
    const data = buildSpaceArgs(config, fnIndex, fileData, mcResolution);

    const outputs = await this.client.callFn(fnIndex, data, newSessionHash(), {
      signal,
      onProgress: (stage, frac) => progress(stage, 0.2 + frac * 0.6),
    });
    const glbFile = scanOutputsForFile(outputs, '.glb');
    if (!glbFile) throw new ProviderError('triposr', 'The 3D Space finished without a model file.', true);
    progress('downloading model', 0.9);
    const glb = await this.client.downloadGlb(glbFile, signal);
    progress('done', 1);
    return { glb, provider: this.id, prompt: '', previewDataUrl: null };
  }

  private discover(config: GradioConfig): number {
    try {
      const fn = findGenerateFnIndex(config);
      this.fnIndexCache = fn;
      return fn;
    } catch (e) {
      if (this.fnIndexCache !== null) return this.fnIndexCache;
      throw e;
    }
  }

  async test(): Promise<string> {
    const started = Date.now();
    const config = await this.client.fetchConfig(undefined, () => undefined);
    const fn = findGenerateFnIndex(config);
    return `TripoSR Space reachable in ${Date.now() - started}ms (generate action #${fn} found, free tier OK).`;
  }
}
