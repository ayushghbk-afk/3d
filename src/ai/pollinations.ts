// FREE default providers (no signup, no API key):
// - Textures/images: Pollinations Flux endpoint (URL-based, CORS-enabled).
// - Assistant chat: Pollinations OpenAI-compatible text endpoint.
// Anonymous image tier is throttled (~1 request / 15s); chat models vary —
// both stay optional and every call has an offline/custom fallback.
import type { AgentMessage, ChatOptions, ImageGenOptions, ImageGenResult } from './types.js';
import { fetchWithTimeout, randomSeed, type ChatProvider, type ImageProvider } from './providers.js';

export const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai';
export const POLLINATIONS_TEXT_BASE = 'https://text.pollinations.ai';
export const POLLINATIONS_FREE_IMAGE_MODEL = 'flux';
export const POLLINATIONS_FREE_CHAT_MODEL = 'openai';

export interface PollinationsImageParams {
  width: number;
  height: number;
  model: string;
  seed: number;
  nologo: boolean;
  referrer: string;
}

/** Pure URL builder (unit-tested) for the free image endpoint. */
export function buildPollinationsImageUrl(
  prompt: string,
  params: Partial<PollinationsImageParams> = {},
  base: string = POLLINATIONS_IMAGE_BASE,
): string {
  const width = clampInt(params.width ?? 512, 64, 2048);
  const height = clampInt(params.height ?? 512, 64, 2048);
  const seed = params.seed ?? randomSeed();
  const model = (params.model || POLLINATIONS_FREE_IMAGE_MODEL).trim() || POLLINATIONS_FREE_IMAGE_MODEL;
  const q = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    seed: String(seed),
    nologo: params.nologo === false ? 'false' : 'true',
  });
  if (params.referrer) q.set('referrer', params.referrer);
  return `${base.replace(/\/+$/, '')}/prompt/${encodeURIComponent(prompt.slice(0, 2000))}?${q.toString()}`;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** Turns a plain idea ("rusty metal") into a texture-friendly prompt. */
export function texturePrompt(prompt: string, seamless: boolean): string {
  const base = prompt.trim().slice(0, 500) || 'abstract surface';
  const suffix = seamless
    ? ', seamless tileable texture, flat front view, no perspective, no objects, no background, uniform lighting, high detail'
    : ', game texture, flat front view, uniform lighting, high detail, no watermark';
  return `${base}${suffix}`;
}

async function downloadImage(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Blob> {
  const res = await fetchWithTimeout(url, { signal, headers: { Accept: 'image/*' } }, timeoutMs);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Pollinations returned HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') && blob.size < 1024) {
    throw new Error('Pollinations did not return an image (rate limit? try again in ~15s).');
  }
  return blob;
}

export class PollinationsImageProvider implements ImageProvider {
  id = 'pollinations';
  label = 'Pollinations Flux (free, no key)';
  free = true;

  async generateImage(prompt: string, opts: ImageGenOptions = {}): Promise<ImageGenResult> {
    const clean = prompt.trim().slice(0, 2000);
    if (!clean) throw new Error('Describe the image first.');
    const width = clampInt(opts.width ?? 512, 64, 2048);
    const height = clampInt(opts.height ?? 512, 64, 2048);
    const seed = opts.seed ?? randomSeed();
    const model = (opts.model || POLLINATIONS_FREE_IMAGE_MODEL).trim() || POLLINATIONS_FREE_IMAGE_MODEL;
    const referrer = typeof location !== 'undefined' ? location.host : 'web-3d-studio';
    const url = buildPollinationsImageUrl(clean, { width, height, model, seed, referrer });
    const blob = await downloadImage(url, 120000, opts.signal);
    return { blob, mime: blob.type || 'image/jpeg', width, height, seed, provider: this.id, prompt: clean };
  }

  async test(): Promise<string> {
    const started = Date.now();
    const url = buildPollinationsImageUrl('test swatch, flat color', { width: 64, height: 64 });
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'image/*', Range: 'bytes=0-0' } }, 45000);
    if (!res.ok) throw new Error(`HTTP ${res.status} — the free tier may be throttled, try again shortly.`);
    return `Pollinations reachable in ${Date.now() - started}ms (free image tier OK).`;
  }
}

/** Free chat via the OpenAI-compatible text endpoint, with legacy GET fallback. */
export class PollinationsChatProvider implements ChatProvider {
  id = 'pollinations-chat';
  label = 'Pollinations text (free, no key)';
  free = true;
  private model = POLLINATIONS_FREE_CHAT_MODEL;

  constructor(model?: string) {
    if (model?.trim()) this.model = model.trim();
  }

  async chat(messages: AgentMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = (opts.model || this.model).trim() || POLLINATIONS_FREE_CHAT_MODEL;
    const body = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })).slice(-20),
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 800,
      private: true,
    };
    // Primary: OpenAI-compatible POST.
    try {
      const res = await fetchWithTimeout(
        `${POLLINATIONS_TEXT_BASE}/openai`,
        {
          method: 'POST',
          signal: opts.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        },
        90000,
      );
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string }; delta?: { content?: string } }[];
        };
        const text = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.delta?.content ?? '';
        if (text.trim()) return text.trim();
      }
    } catch {
      /* fall through to legacy GET */
    }
    // Fallback: legacy GET endpoint with the conversation flattened.
    const flat = messages
      .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'}: ${m.content}`)
      .join('\n')
      .slice(-4000);
    const url = `${POLLINATIONS_TEXT_BASE}/${encodeURIComponent(flat)}?model=${encodeURIComponent(model)}&private=true`;
    const res = await fetchWithTimeout(url, { signal: opts.signal, headers: { Accept: 'text/plain' } }, 90000);
    if (!res.ok) throw new Error(`Pollinations text returned HTTP ${res.status}.`);
    const text = (await res.text()).trim();
    if (!text) throw new Error('Empty response from the free chat model.');
    return text;
  }

  async test(): Promise<string> {
    const started = Date.now();
    const out = await this.chat(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      { maxTokens: 16, temperature: 0 },
    );
    return `Pollinations text reachable in ${Date.now() - started}ms (said: ${out.slice(0, 40)}).`;
  }
}
