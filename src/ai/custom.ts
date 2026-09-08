// User-configured (custom API) providers. All three follow the OpenAI wire
// format so they work with OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM,
// OpenRouter, Together, and any compatible gateway:
//
// - Chat:   POST {baseUrl}/chat/completions   {model, messages, ...}
// - Images: POST {baseUrl}/images/generations {model, prompt, size, n:1,
//           response_format:"b64_json"} (falls back to URL responses)
// - 3D:     POST {baseUrl} (full URL incl. path) with {prompt, image_base64?}
//           expecting one of: {glb_base64|glb_url|model_url|url}, raw GLB bytes,
//           or {data:[{b64_json|url}]}.
import type {
  AgentMessage, ChatOptions, ImageGenOptions, ImageGenResult, MeshGenOptions, MeshGenResult,
} from './types.js';
import { ProviderError, blobToArrayBuffer, fetchWithTimeout, randomSeed, type ChatProvider, type ImageProvider, type MeshProvider } from './providers.js';
import type { CustomEndpoint } from './settings.js';

function base(ep: CustomEndpoint): string {
  const b = ep.baseUrl.trim().replace(/\/+$/, '');
  if (!b) throw new ProviderError('custom', 'Custom API base URL is empty — open ✨ AI → Settings to configure it.');
  if (!/^https?:\/\//i.test(b)) throw new ProviderError('custom', 'Custom API base URL must start with http(s)://');
  return b;
}

function authHeaders(ep: CustomEndpoint): Record<string, string> {
  return ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {};
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `HTTP ${res.status}`;
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message;
    if (msg) return `HTTP ${res.status}: ${String(msg).slice(0, 220)}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}: ${text.slice(0, 220)}`;
}

export class CustomChatProvider implements ChatProvider {
  id = 'custom-chat';
  label = 'Custom chat API';
  free = false;
  constructor(private ep: CustomEndpoint) {}

  async chat(messages: AgentMessage[], opts: ChatOptions = {}): Promise<string> {
    const url = `${base(this.ep)}/chat/completions`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        signal: opts.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(this.ep) },
        body: JSON.stringify({
          model: opts.model || this.ep.model || 'default',
          messages: messages.slice(-20),
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.maxTokens ?? 800,
        }),
      },
      120000,
    );
    if (!res.ok) throw new ProviderError('custom-chat', await readError(res), res.status === 429 || res.status >= 500);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = (json.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new ProviderError('custom-chat', 'Custom chat API returned an empty reply.');
    return text;
  }

  async test(): Promise<string> {
    const started = Date.now();
    const out = await this.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 16 });
    return `Custom chat OK in ${Date.now() - started}ms (said: ${out.slice(0, 40)}).`;
  }
}

export class CustomImageProvider implements ImageProvider {
  id = 'custom-image';
  label = 'Custom image API';
  free = false;
  constructor(private ep: CustomEndpoint) {}

  async generateImage(prompt: string, opts: ImageGenOptions = {}): Promise<ImageGenResult> {
    const clean = prompt.trim().slice(0, 2000);
    if (!clean) throw new Error('Describe the image first.');
    const width = opts.width ?? 512;
    const height = opts.height ?? 512;
    const res = await fetchWithTimeout(
      `${base(this.ep)}/images/generations`,
      {
        method: 'POST',
        signal: opts.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(this.ep) },
        body: JSON.stringify({
          model: opts.model || this.ep.model || 'default',
          prompt: clean,
          size: `${width}x${height}`,
          n: 1,
          response_format: 'b64_json',
        }),
      },
      180000,
    );
    if (!res.ok) throw new ProviderError('custom-image', await readError(res), res.status === 429 || res.status >= 500);
    const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const item = json.data?.[0];
    if (!item) throw new ProviderError('custom-image', 'Custom image API returned no images.');
    let blob: Blob;
    if (item.b64_json) {
      const bin = atob(item.b64_json);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' });
    } else if (item.url) {
      const dl = await fetchWithTimeout(item.url, { signal: opts.signal }, 120000);
      if (!dl.ok) throw new ProviderError('custom-image', `Could not download result: HTTP ${dl.status}`);
      blob = await dl.blob();
    } else {
      throw new ProviderError('custom-image', 'Custom image API returned an item without b64_json or url.');
    }
    return { blob, mime: blob.type || 'image/png', width, height, seed: opts.seed ?? randomSeed(), provider: this.id, prompt: clean };
  }

  async test(): Promise<string> {
    const started = Date.now();
    // Cheap check: most gateways expose /models.
    const res = await fetchWithTimeout(
      `${base(this.ep)}/models`,
      { headers: { Accept: 'application/json', ...authHeaders(this.ep) } },
      30000,
    );
    if (!res.ok) throw new ProviderError('custom-image', await readError(res));
    return `Custom image API reachable in ${Date.now() - started}ms (/models OK).`;
  }
}

export class CustomMeshProvider implements MeshProvider {
  id = 'custom-mesh';
  label = 'Custom 3D API';
  free = false;
  constructor(private ep: CustomEndpoint) {}

  async textTo3D(prompt: string, opts: MeshGenOptions = {}): Promise<MeshGenResult> {
    return this.call(prompt, null, opts);
  }

  async imageTo3D(image: Blob, opts: MeshGenOptions = {}): Promise<MeshGenResult> {
    const buf = await blobToArrayBuffer(image);
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return this.call('', btoa(bin), opts);
  }

  private async call(prompt: string, imageBase64: string | null, opts: MeshGenOptions): Promise<MeshGenResult> {
    const url = base(this.ep); // full URL including path, e.g. https://host/v1/mesh
    opts.onProgress?.('contacting custom 3D API', 0.1);
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        signal: opts.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, model/gltf-binary', ...authHeaders(this.ep) },
        body: JSON.stringify({
          model: this.ep.model || 'text-to-3d',
          prompt: prompt || undefined,
          image_base64: imageBase64 ?? undefined,
          format: 'glb',
        }),
      },
      600000,
    );
    if (!res.ok) throw new ProviderError('custom-mesh', await readError(res), res.status === 429 || res.status >= 500);
    const contentType = res.headers.get('content-type') ?? '';
    opts.onProgress?.('downloading model', 0.7);
    // Raw GLB bytes?
    if (contentType.includes('model/gltf') || contentType.includes('octet-stream')) {
      return { glb: await res.arrayBuffer(), provider: this.id, prompt };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const pick = (o: Record<string, unknown>): string | null => {
      for (const k of ['glb_base64', 'b64_json', 'glb_url', 'model_url', 'url', 'download_url']) {
        const v = o[k];
        if (typeof v === 'string' && v) return v;
      }
      const data = o.data as unknown;
      if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
        const inner = pick(data[0] as Record<string, unknown>);
        if (inner) return inner;
      }
      return null;
    };
    const found = pick(json);
    if (!found) throw new ProviderError('custom-mesh', 'Custom 3D API response had no glb_base64/glb_url field.');
    if (/^https?:\/\//i.test(found) || found.startsWith('data:')) {
      const dl = await fetchWithTimeout(found, { signal: opts.signal }, 300000);
      if (!dl.ok) throw new ProviderError('custom-mesh', `Could not download model: HTTP ${dl.status}`);
      return { glb: await dl.arrayBuffer(), provider: this.id, prompt };
    }
    const bin = atob(found);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { glb: bytes.buffer as ArrayBuffer, provider: this.id, prompt };
  }

  async test(): Promise<string> {
    const started = Date.now();
    // Non-destructive probe: most 3D APIs reject an empty prompt with 4xx,
    // which still proves the endpoint + auth path work.
    const res = await fetchWithTimeout(
      base(this.ep),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.ep) },
        body: JSON.stringify({ model: this.ep.model || 'text-to-3d', prompt: '', format: 'glb', dry_run: true }),
      },
      30000,
    );
    if (res.status === 401 || res.status === 403) throw new ProviderError('custom-mesh', 'Custom 3D API rejected the key (401/403).');
    return `Custom 3D endpoint answered HTTP ${res.status} in ${Date.now() - started}ms.`;
  }
}
