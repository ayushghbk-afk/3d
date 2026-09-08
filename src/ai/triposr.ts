// FREE 3D generator: TripoSR (Stability AI × Tripo AI, MIT-licensed) running on
// the public Hugging Face Space — no signup, no API key. Pipeline:
//
//   text prompt ──► free image model ──► TripoSR image-to-3D ──► GLB ──► scene
//
// We speak the Gradio queue protocol directly (config → upload → queue/join →
// SSE → file download) so it works from a static page with zero dependencies.
// The Space sleeps when idle: the first call of the day can take 1–3 minutes
// while it wakes; progress callbacks report every stage honestly.
import type { ImageGenResult, MeshGenOptions, MeshGenResult } from './types.js';
import {
  ProviderError, blobToDataUrl, fetchWithTimeout, readSseStream, type ImageProvider, type MeshProvider,
} from './providers.js';

export const DEFAULT_TRIPOSR_SPACE = 'https://stabilityai-triposr.hf.space';
const MC_RESOLUTION: Record<NonNullable<MeshGenOptions['quality']>, number> = {
  fast: 128,
  balanced: 192,
  high: 256,
};

// ---------- pure config parsing (unit-tested) ----------

interface GradioConfig {
  components?: { id: number; type: string; props?: Record<string, unknown> }[];
  dependencies?: { id: number; inputs?: number[]; outputs?: number[] }[];
}

/** File payload shaped exactly like Gradio's own client sends it. */
export interface SpaceFileData {
  path: string;
  url: string;
  orig_name: string;
  size: number;
  mime_type: string;
  meta: { _type: 'gradio.FileData' };
}

export function makeFileData(serverPath: string, name: string, size: number, mime: string): SpaceFileData {
  const clean = serverPath.startsWith('/') ? serverPath : `/${serverPath}`;
  return {
    path: serverPath,
    url: `/gradio_api/file=${clean}`,
    orig_name: name,
    size,
    mime_type: mime,
    meta: { _type: 'gradio.FileData' },
  };
}

/** `/gradio_api/upload` returns `[paths]` (older) or `{files:[...]}` (newer). */
export function parseUploadPaths(json: unknown): string[] {
  if (Array.isArray(json)) return json.filter((p): p is string => typeof p === 'string');
  const files = (json as { files?: unknown } | null)?.files;
  if (Array.isArray(files)) {
    return files
      .map((f) => (typeof f === 'string' ? f : (f as { path?: unknown } | null)?.path))
      .filter((p): p is string => typeof p === 'string');
  }
  return [];
}

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
  // Prefer a dep with an image input AND a model3d output.
  for (const d of deps) {
    const ins = d.inputs ?? [];
    const outs = d.outputs ?? [];
    if (ins.some(isImageInput) && outs.some(isModelOutput)) return d.id;
  }
  // Fallback: any dep producing a model3d output.
  for (const d of deps) {
    if ((d.outputs ?? []).some(isModelOutput)) return d.id;
  }
  throw new ProviderError('triposr', 'The 3D Space changed its UI — could not find the Generate action. Try a custom 3D API instead.');
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
    throw new ProviderError('triposr', 'The 3D Space changed its inputs (no image slot found). Try a custom 3D API instead.');
  }
  return args;
}

interface GradioFileData {
  path?: string;
  url?: string;
  orig_name?: string;
  size?: number;
  mime_type?: string;
}

function fileUrl(space: string, file: GradioFileData): string {
  const raw = file.url || file.path || '';
  if (!raw) throw new ProviderError('triposr', 'The 3D Space returned an empty file reference.');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${space}${raw}`;
  return `${space}/gradio_api/file=${raw}`;
}

function sessionHash(): string {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(36)).join('').replace(/[^a-z0-9]/g, 'x').slice(0, 12);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface TripoSROptions {
  spaceUrl?: string;
  hfToken?: string;
  imageProvider: ImageProvider;
}

export class TripoSRMeshProvider implements MeshProvider {
  id = 'triposr';
  label = 'TripoSR free 3D (Hugging Face Space)';
  free = true;
  private space: string;
  private hfToken: string;
  private images: ImageProvider;
  private fnIndexCache: number | null = null;

  constructor(opts: TripoSROptions) {
    this.space = (opts.spaceUrl || DEFAULT_TRIPOSR_SPACE).replace(/\/+$/, '');
    this.hfToken = (opts.hfToken || '').trim();
    this.images = opts.imageProvider;
  }

  private authHeaders(): Record<string, string> {
    return this.hfToken ? { Authorization: `Bearer ${this.hfToken}` } : {};
  }

  async textTo3D(prompt: string, opts: MeshGenOptions = {}): Promise<MeshGenResult> {
    const clean = prompt.trim().slice(0, 500);
    if (!clean) throw new Error('Describe the model first.');
    opts.onProgress?.('generating reference image', 0.05);
    // Single centered object on a plain background reconstructs best.
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
    const signal = opts.signal;

    // 1) Space config (with wake-up retries: a sleeping Space 503s).
    progress('waking the free 3D service', 0.02);
    let fnIndex = this.fnIndexCache;
    let config: GradioConfig | null = null;
    if (fnIndex === null) {
      config = await this.fetchConfigWithWakeup(signal, progress);
      fnIndex = findGenerateFnIndex(config);
      this.fnIndexCache = fnIndex;
    } else {
      // Cached action id, but still refresh the input layout (cheap, cached by CDN).
      try {
        const res = await fetchWithTimeout(`${this.space}/config.json`, { signal, headers: this.authHeaders() }, 30000);
        const text = await res.text();
        if (res.ok && text.trim().startsWith('{')) config = JSON.parse(text) as GradioConfig;
      } catch {
        /* fall through to rediscovery below */
      }
      if (!config) {
        config = await this.fetchConfigWithWakeup(signal, progress);
        fnIndex = findGenerateFnIndex(config);
        this.fnIndexCache = fnIndex;
      }
    }

    // 2) Upload the image.
    progress('uploading image', 0.12);
    const form = new FormData();
    form.append('files', image, 'input.png');
    const uploadRes = await fetchWithTimeout(
      `${this.space}/gradio_api/upload`,
      { method: 'POST', body: form, signal, headers: this.authHeaders() },
      120000,
    );
    if (!uploadRes.ok) {
      throw this.httpError('upload', uploadRes.status, await uploadRes.text().catch(() => ''));
    }
    const serverPath = parseUploadPaths(await uploadRes.json().catch(() => null))[0];
    if (!serverPath) throw new ProviderError('triposr', '3D upload returned no file path — the free Space may be updating. Retry in a minute.', true);

    // 3) Join the generation queue (with retries: the free queue fills up).
    const hash = sessionHash();
    const fileData = makeFileData(serverPath, 'input.png', image.size, image.type || 'image/png');
    const data = buildSpaceArgs(config, fnIndex, fileData, mcResolution);
    await this.joinWithRetry(fnIndex, data, hash, signal, progress);

    // 4) Stream progress until completion.
    let glbFile: GradioFileData | null = null;
    let queueEta = '';
    const streamRes = await fetchWithTimeout(
      `${this.space}/gradio_api/queue/data?session_hash=${hash}`,
      { signal, headers: { Accept: 'text/event-stream', ...this.authHeaders() } },
      600000,
    );
    if (!streamRes.ok || !streamRes.body) {
      throw new ProviderError('triposr', `Stream failed: HTTP ${streamRes.status}`, true);
    }
    await readSseStream(
      streamRes,
      (event, data) => {
        if (event === 'estimation' || event === 'status') {
          try {
            const j = JSON.parse(data) as { rank?: number; queue_size?: number; rank_eta?: number };
            if (typeof j.rank === 'number' && j.rank > 0) {
              queueEta = ` (place ${j.rank} in queue${j.rank_eta ? `, ~${Math.ceil(j.rank_eta)}s` : ''})`;
              progress(`waiting in queue${queueEta}`, 0.25);
            }
          } catch {
            /* non-JSON status */
          }
          return;
        }
        if (event === 'process_generating' || event === 'process_starts') {
          progress(`reconstructing 3D${queueEta}`, 0.55);
          return;
        }
        if (event === 'process_completed') {
          try {
            const j = JSON.parse(data) as { output?: { data?: unknown[]; error?: unknown }; success?: boolean };
            if (j.success === false) {
              const msg = typeof j.output?.error === 'string' && j.output.error
                ? j.output.error.slice(0, 200)
                : 'the Space rejected this image';
              throw new ProviderError('triposr', `The 3D Space failed to generate (${msg}). Try a clearer single-object image or retry.`, true);
            }
            const out = j.output?.data ?? [];
            // TripoSR outputs: [processed_image, obj_file, glb_file]
            for (const item of out) {
              const f = item as GradioFileData | null;
              if (f && typeof f === 'object' && (f.url || f.path)) {
                const name = `${f.orig_name ?? ''} ${f.path ?? ''} ${f.url ?? ''}`.toLowerCase();
                if (name.includes('.glb')) {
                  glbFile = f;
                  break;
                }
              }
            }
            if (!glbFile) {
              // Fallback: last file-like output.
              for (let i = out.length - 1; i >= 0; i--) {
                const f = out[i] as GradioFileData | null;
                if (f && typeof f === 'object' && (f.url || f.path)) {
                  glbFile = f;
                  break;
                }
              }
            }
          } catch {
            /* malformed completion */
          }
          return true; // stop streaming
        }
        if (event === 'error' || event === 'unexpected_error' || event === 'process_failed') {
          throw new ProviderError('triposr', `Generation failed on the free Space${queueEta}. Retry in a minute.`, true);
        }
        return;
      },
      signal,
    );
    if (!glbFile) throw new ProviderError('triposr', 'The 3D Space finished without a model file.', true);

    // 5) Download the GLB.
    progress('downloading model', 0.9);
    const file = fileUrl(this.space, glbFile);
    const dlRes = await fetchWithTimeout(file, { signal, headers: this.authHeaders() }, 300000);
    if (!dlRes.ok) throw new ProviderError('triposr', `Model download failed: HTTP ${dlRes.status}`, true);
    const glb = await dlRes.arrayBuffer();
    if (glb.byteLength < 1024) throw new ProviderError('triposr', 'Downloaded model file is too small to be valid.', true);
    if (!isGlb(glb)) throw new ProviderError('triposr', 'Downloaded file is not a GLB model.', false);
    progress('done', 1);
    return { glb, provider: this.id, prompt: '', previewDataUrl: null };
  }

  /** Join the queue, riding out 429/503 busy spells with backoff. */
  private async joinWithRetry(
    fnIndex: number,
    data: unknown[],
    hash: string,
    signal: AbortSignal | undefined,
    progress: (stage: string, frac: number) => void,
  ): Promise<void> {
    const attempts = 12;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      progress(i === 0 ? 'joining queue' : `queue busy, retrying (${i + 1}/${attempts})`, 0.2);
      const res = await fetchWithTimeout(
        `${this.space}/gradio_api/queue/join`,
        {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
          body: JSON.stringify({ data, fn_index: fnIndex, session_hash: hash }),
        },
        60000,
      );
      if (res.ok) return;
      if (res.status === 429 || res.status === 503) {
        await sleep(Math.min(15000, 2000 * (i + 1)), signal);
        continue;
      }
      this.fnIndexCache = null; // UI may have changed; rediscover next time.
      throw this.httpError('queue join', res.status, await res.text().catch(() => ''));
    }
    throw new ProviderError(
      'triposr',
      'The free 3D queue stayed full for 2 minutes. Retry shortly, add a free Hugging Face token in ✨ AI → Setup for priority, or switch to offline/custom 3D.',
      true,
    );
  }

  /** Stage-aware HTTP error with ZeroGPU/quota detection. */
  private httpError(stage: string, status: number, body: string): ProviderError {
    const clean = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const extra = clean ? ` — ${clean}` : '';
    let hint = 'Retry shortly.';
    if (/quota|zerogpu|zero-gpu|gpus? (busy|unavailable)|capacity/i.test(body)) {
      hint = 'The free GPU capacity is exhausted right now — retry in a few minutes, add a free Hugging Face token in ✨ AI → Setup for priority, or use offline/custom 3D.';
    } else if (status === 429 || status === 503) {
      hint = 'The free Space is overloaded — retry shortly or use offline/custom 3D in ✨ AI → Setup.';
    }
    return new ProviderError('triposr', `3D ${stage} failed (HTTP ${status})${extra} ${hint}`, status === 429 || status >= 500);
  }

  private async fetchConfigWithWakeup(
    signal: AbortSignal | undefined,
    progress: (stage: string, frac: number) => void,
  ): Promise<GradioConfig> {
    // A sleeping Space needs ~30–120s to boot; poll patiently.
    const attempts = 24;
    let lastError = '';
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const res = await fetchWithTimeout(
          `${this.space}/config.json`,
          { signal, headers: this.authHeaders() },
          30000,
        );
        const text = await res.text();
        if (res.ok && text.trim().startsWith('{')) {
          return JSON.parse(text) as GradioConfig;
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = (e as Error).message;
        if ((e as Error)?.name === 'AbortError') throw e;
      }
      if (i < 8 || i % 4 === 0) progress(`waking the free 3D service (attempt ${i + 1})`, 0.02 + (i / attempts) * 0.08);
      await sleep(i < 6 ? 5000 : 10000, signal);
    }
    throw new ProviderError('triposr', `The free 3D Space is not responding (${lastError}). It may be booting — retry in 2–3 minutes, or switch to offline/custom 3D in ✨ AI → Settings.`, true);
  }

  async test(): Promise<string> {
    const started = Date.now();
    const config = await this.fetchConfigWithWakeup(undefined, () => undefined);
    const fn = findGenerateFnIndex(config);
    return `TripoSR Space reachable in ${Date.now() - started}ms (generate action #${fn} found, free tier OK).`;
  }
}

/** GLB magic check: first 4 bytes are 'glTF'. Exported for tests. */
export function isGlb(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new Uint8Array(buf.slice(0, 4));
  return v[0] === 0x67 && v[1] === 0x6c && v[2] === 0x54 && v[3] === 0x46;
}
