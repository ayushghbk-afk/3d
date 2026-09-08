// Shared Gradio Space client (queue protocol): config → upload → queue/join →
// SSE → file download. Used by the free image-to-3D models (SF3D, TripoSR).
// One client per Space; session hashes are deliberately reusable so chained
// calls (background removal → generate) share server-side State.
import { ProviderError, fetchWithTimeout, readSseStream } from './providers.js';

export interface GradioConfig {
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

export interface GradioFileData {
  path?: string;
  url?: string;
  orig_name?: string;
  size?: number;
  mime_type?: string;
}

export function fileUrl(space: string, file: GradioFileData): string {
  const raw = file.url || file.path || '';
  if (!raw) throw new ProviderError('gradio', 'The 3D Space returned an empty file reference.');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${space}${raw}`;
  return `${space}/gradio_api/file=${raw}`;
}

/** Recursively scan queue outputs (incl. gr.update dicts) for a model file. */
export function scanOutputsForFile(outputs: unknown[], ext: string): GradioFileData | null {
  const files: GradioFileData[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.url === 'string' || typeof rec.path === 'string') {
      files.push(rec as unknown as GradioFileData);
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(outputs);
  const want = ext.toLowerCase();
  return (
    files.find((f) => `${f.orig_name ?? ''} ${f.path ?? ''} ${f.url ?? ''}`.toLowerCase().includes(want)) ??
    files[files.length - 1] ??
    null
  );
}

/** GLB magic check: first 4 bytes are 'glTF'. */
export function isGlb(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const v = new Uint8Array(buf.slice(0, 4));
  return v[0] === 0x67 && v[1] === 0x6c && v[2] === 0x54 && v[3] === 0x46;
}

export function newSessionHash(): string {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(36)).join('').replace(/[^a-z0-9]/g, 'x').slice(0, 12);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export interface GradioCallHooks {
  signal?: AbortSignal;
  /** Queue/progress narration; fraction is 0..1 within this call. */
  onProgress?: (stage: string, fraction: number) => void;
}

export class GradioSpaceClient {
  readonly space: string;
  private hfToken: string;
  /** Short provider tag used in error prefixes (e.g. 'sf3d'). */
  private tag: string;

  constructor(space: string, hfToken = '', tag = 'gradio') {
    this.space = space.replace(/\/+$/, '');
    this.hfToken = hfToken.trim();
    this.tag = tag;
  }

  private authHeaders(): Record<string, string> {
    return this.hfToken ? { Authorization: `Bearer ${this.hfToken}` } : {};
  }

  err(message: string, retryable = false): ProviderError {
    return new ProviderError(this.tag, message, retryable);
  }

  /** Stage-aware HTTP error with ZeroGPU/quota detection. */
  httpError(stage: string, status: number, body: string): ProviderError {
    const clean = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const extra = clean ? ` — ${clean}` : '';
    let hint = 'Retry shortly.';
    if (/quota|zerogpu|zero-gpu|gpus? (busy|unavailable)|capacity/i.test(body)) {
      hint = 'The free GPU capacity is exhausted right now — retry in a few minutes, add a free Hugging Face token in ✨ AI → Setup for priority, or use another free model.';
    } else if (status === 429 || status === 503) {
      hint = 'The free Space is overloaded — retry shortly or pick another model in ✨ AI → Setup.';
    }
    return new ProviderError(this.tag, `3D ${stage} failed (HTTP ${status})${extra} ${hint}`, status === 429 || status >= 500);
  }

  /** Config with wake-up retries: a sleeping Space 503s/404s for a while. */
  async fetchConfig(signal?: AbortSignal, progress?: (stage: string, frac: number) => void): Promise<GradioConfig> {
    const attempts = 24;
    let lastError = '';
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const res = await fetchWithTimeout(`${this.space}/config.json`, { signal, headers: this.authHeaders() }, 30000);
        const text = await res.text();
        if (res.ok && text.trim().startsWith('{')) {
          return JSON.parse(text) as GradioConfig;
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = (e as Error).message;
        if ((e as Error)?.name === 'AbortError') throw e;
      }
      if (i < 8 || i % 4 === 0) progress?.(`waking the free 3D service (attempt ${i + 1})`, 0.02 + (i / attempts) * 0.08);
      await sleep(i < 6 ? 5000 : 10000, signal);
    }
    throw this.err(`The free 3D Space is not responding (${lastError}). It may be booting — retry in 2–3 minutes, or switch models in ✨ AI → Setup.`, true);
  }

  async uploadImage(image: Blob, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('files', image, 'input.png');
    const res = await fetchWithTimeout(
      `${this.space}/gradio_api/upload`,
      { method: 'POST', body: form, signal, headers: this.authHeaders() },
      120000,
    );
    if (!res.ok) throw this.httpError('upload', res.status, await res.text().catch(() => ''));
    const path = parseUploadPaths(await res.json().catch(() => null))[0];
    if (!path) throw this.err('3D upload returned no file path — the free Space may be updating. Retry in a minute.', true);
    return path;
  }

  /**
   * Run one queue function and return its `output.data` array.
   * Reuse `sessionHash` across chained calls to share server-side State.
   */
  async callFn(fnIndex: number, data: unknown[], sessionHash: string, hooks: GradioCallHooks = {}): Promise<unknown[]> {
    const { signal } = hooks;
    const progress = hooks.onProgress ?? ((): void => undefined);
    await this.joinWithRetry(fnIndex, data, sessionHash, signal, progress);
    const streamRes = await fetchWithTimeout(
      `${this.space}/gradio_api/queue/data?session_hash=${sessionHash}`,
      { signal, headers: { Accept: 'text/event-stream', ...this.authHeaders() } },
      600000,
    );
    if (!streamRes.ok || !streamRes.body) {
      throw this.err(`3D stream failed (HTTP ${streamRes.status}).`, true);
    }
    let outputs: unknown[] | null = null;
    await readSseStream(
      streamRes,
      (event, eventData) => {
        if (event === 'estimation' || event === 'status') {
          try {
            const j = JSON.parse(eventData) as { rank?: number; rank_eta?: number };
            if (typeof j.rank === 'number' && j.rank > 0) {
              progress(`waiting in queue (place ${j.rank}${j.rank_eta ? `, ~${Math.ceil(j.rank_eta)}s` : ''})`, 0.3);
            }
          } catch {
            /* non-JSON status */
          }
          return;
        }
        if (event === 'process_generating' || event === 'process_starts') {
          progress('reconstructing 3D', 0.6);
          return;
        }
        if (event === 'process_completed') {
          let j: { output?: { data?: unknown[]; error?: unknown }; success?: boolean };
          try {
            j = JSON.parse(eventData) as { output?: { data?: unknown[]; error?: unknown }; success?: boolean };
          } catch {
            throw this.err('The 3D Space returned a garbled response — retry in a minute.', true);
          }
          if (j.success === false) {
            const msg = typeof j.output?.error === 'string' && j.output.error
              ? j.output.error.slice(0, 200)
              : 'the Space rejected this step';
            throw this.err(`The 3D Space failed (${msg}). Try a clearer single-object image or retry.`, true);
          }
          outputs = j.output?.data ?? [];
          return true; // stop streaming
        }
        if (event === 'error' || event === 'unexpected_error' || event === 'process_failed') {
          throw this.err('Generation failed on the free Space. Retry in a minute.', true);
        }
        return;
      },
      signal,
    );
    return outputs ?? [];
  }

  async downloadGlb(file: GradioFileData, signal?: AbortSignal): Promise<ArrayBuffer> {
    const url = fileUrl(this.space, file);
    const res = await fetchWithTimeout(url, { signal, headers: this.authHeaders() }, 300000);
    if (!res.ok) throw this.err(`Model download failed (HTTP ${res.status}).`, true);
    const glb = await res.arrayBuffer();
    if (glb.byteLength < 1024) throw this.err('Downloaded model file is too small to be valid.', true);
    if (!isGlb(glb)) throw this.err('Downloaded file is not a GLB model.', false);
    return glb;
  }

  /** Join the queue, riding out 429/503 busy spells with backoff. */
  private async joinWithRetry(
    fnIndex: number,
    data: unknown[],
    sessionHash: string,
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
          body: JSON.stringify({ data, fn_index: fnIndex, session_hash: sessionHash }),
        },
        60000,
      );
      if (res.ok) return;
      if (res.status === 429 || res.status === 503) {
        await sleep(Math.min(15000, 2000 * (i + 1)), signal);
        continue;
      }
      throw this.httpError('queue join', res.status, await res.text().catch(() => ''));
    }
    throw this.err('The free 3D queue stayed full for 2 minutes. Retry shortly, add a free Hugging Face token in ✨ AI → Setup for priority, or pick another model.', true);
  }
}
