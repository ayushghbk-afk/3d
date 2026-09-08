// FREE default providers (no signup, no API key):
// - Textures/images: Pollinations Flux endpoint (URL-based, CORS-enabled).
// - Assistant chat: Pollinations OpenAI-compatible text endpoint.
// Anonymous image tier is throttled (~1 request / 15s); chat models vary —
// both stay optional and every call has an offline/custom fallback.
import type { AgentMessage, ChatOptions, ImageGenOptions, ImageGenResult } from './types.js';
import { fetchWithTimeout, randomSeed, type ChatProvider, type ImageProvider } from './providers.js';

export const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai';
export const POLLINATIONS_TEXT_BASE = 'https://text.pollinations.ai';
/** Current unified API (v0.3+): OpenAI-compatible chat + keyed GET endpoints. */
export const POLLINATIONS_GEN_BASE = 'https://gen.pollinations.ai';
export const POLLINATIONS_FREE_IMAGE_MODEL = 'flux';
export const POLLINATIONS_FREE_CHAT_MODEL = 'openai';

export interface PollinationsImageParams {
  width: number;
  height: number;
  model: string;
  seed: number;
  nologo: boolean;
  referrer: string;
  /** Optional user key (?key=) — raises anonymous limits where honored. */
  key?: string;
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
  if (params.key) q.set('key', params.key);
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
  private apiKey?: string;

  constructor(apiKey?: string) {
    if (apiKey?.trim()) this.apiKey = apiKey.trim();
  }

  async generateImage(prompt: string, opts: ImageGenOptions = {}): Promise<ImageGenResult> {
    const clean = prompt.trim().slice(0, 2000);
    if (!clean) throw new Error('Describe the image first.');
    const width = clampInt(opts.width ?? 512, 64, 2048);
    const height = clampInt(opts.height ?? 512, 64, 2048);
    const seed = opts.seed ?? randomSeed();
    const model = (opts.model || POLLINATIONS_FREE_IMAGE_MODEL).trim() || POLLINATIONS_FREE_IMAGE_MODEL;
    const referrer = typeof location !== 'undefined' ? location.host : 'web-3d-studio';
    const url = buildPollinationsImageUrl(clean, { width, height, model, seed, referrer, key: this.apiKey });
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

/** Flatten a conversation for the plain-text GET endpoints (cap ±4k chars). */
export function flattenMessages(messages: AgentMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'}: ${m.content}`)
    .join('\n')
    .slice(-4000);
}

/**
 * Actionable error when every chat endpoint failed. Distinguishes offline
 * browsers, exhausted anonymous access (HTTP 402 → key required) and generic
 * network blocks so the user knows exactly what to try next.
 */
export function unreachableChatError(failures: string[]): Error {
  const nav = globalThis.navigator as { onLine?: boolean } | undefined;
  if (nav && nav.onLine === false) {
    return new Error(
      'You appear to be offline — reconnect and try Ask again. Factual scene questions (counts, lists) are answered offline in the meantime.',
    );
  }
  if (failures.some((f) => f.startsWith('gen.pollinations.ai (key)') && f.includes('402'))) {
    return new Error(
      'Your Pollinations key is out of budget (HTTP 402). Check usage/balance at enter.pollinations.ai and top up or wait for the reset — then retry Ask.',
    );
  }
  if (failures.some((f) => f.includes('402'))) {
    return new Error(
      'Pollinations ended anonymous access for Ask (HTTP 402 — the free tier now needs a key). ' +
        'Fix in ~1 min: get a free key at enter.pollinations.ai/keys, paste it in ✨ AI → Setup → Pollinations key, Save, then ask again. ' +
        'Factual scene questions (counts, lists, summaries) still get offline answers.',
    );
  }
  return new Error(
    `Couldn't reach the free Pollinations assistant (${failures.join(' · ') || 'network error'}). ` +
      'Usual causes: an ad-blocker, VPN or firewall blocking pollinations.ai, ISP/DNS trouble, or the free tier being down. ' +
      'Fixes: allow pollinations.ai in your blocker, retry in a bit, or add a free key in ✨ AI → Setup (Pollinations key) to use the current API. ' +
      'Factual scene questions still get offline answers.',
  );
}

/**
 * Free chat with a 4-step chain:
 * 1. current gen.pollinations.ai API with the user's key (when configured),
 * 2. legacy anonymous OpenAI-compatible POST,
 * 3. legacy anonymous GET (flattened conversation),
 * 4. current API anonymous GET (different host — can work when legacy is
 *    blocked on the user's network).
 * Throws an actionable error naming every failed step when all are down.
 */
export class PollinationsChatProvider implements ChatProvider {
  id = 'pollinations-chat';
  label = 'Pollinations text (free, no key)';
  free = true;
  private model = POLLINATIONS_FREE_CHAT_MODEL;
  private apiKey?: string;

  constructor(model?: string, apiKey?: string) {
    if (model?.trim()) this.model = model.trim();
    if (apiKey?.trim()) this.apiKey = apiKey.trim();
  }

  async chat(messages: AgentMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = (opts.model || this.model).trim() || POLLINATIONS_FREE_CHAT_MODEL;
    const failures: string[] = [];
    const attempt = async (label: string, run: () => Promise<string>): Promise<string | null> => {
      try {
        const text = (await run()).trim();
        if (text) return text;
        failures.push(`${label}: empty reply`);
      } catch (e) {
        failures.push(`${label}: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
      }
      return null;
    };

    if (this.apiKey) {
      const keyed = await attempt('gen.pollinations.ai (key)', () =>
        this.postJson(
          `${POLLINATIONS_GEN_BASE}/v1/chat/completions`,
          { Authorization: `Bearer ${this.apiKey as string}` },
          model,
          messages,
          opts,
          90000,
        ),
      );
      if (keyed) return keyed;
    }
    const posted = await attempt('text.pollinations.ai (anonymous)', () =>
      this.postJson(`${POLLINATIONS_TEXT_BASE}/openai`, {}, model, messages, opts, 60000),
    );
    if (posted) return posted;

    const flat = flattenMessages(messages);
    const legacyGet = await attempt('text.pollinations.ai GET (anonymous)', async () => {
      const url = `${POLLINATIONS_TEXT_BASE}/${encodeURIComponent(flat)}?model=${encodeURIComponent(model)}&private=true`;
      const res = await fetchWithTimeout(url, { signal: opts.signal, headers: { Accept: 'text/plain' } }, 60000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text()).trim();
    });
    if (legacyGet) return legacyGet;

    const genGet = await attempt('gen.pollinations.ai GET (anonymous)', async () => {
      const url = `${POLLINATIONS_GEN_BASE}/text/${encodeURIComponent(flat)}?model=${encodeURIComponent(model)}`;
      const res = await fetchWithTimeout(url, { signal: opts.signal, headers: { Accept: 'text/plain' } }, 45000);
      if (res.status === 401) throw new Error('needs an API key (free at enter.pollinations.ai/keys)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text()).trim();
    });
    if (genGet) return genGet;

    throw unreachableChatError(failures);
  }

  private async postJson(
    url: string,
    extraHeaders: Record<string, string>,
    model: string,
    messages: AgentMessage[],
    opts: ChatOptions,
    timeoutMs: number,
  ): Promise<string> {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        signal: opts.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })).slice(-20),
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.maxTokens ?? 800,
          private: true,
        }),
      },
      timeoutMs,
    );
    if (res.status === 401) throw new Error('API key rejected (401) — check the key in ✨ AI → Setup.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; delta?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.delta?.content ?? '';
    if (!text.trim()) throw new Error('empty reply');
    return text.trim();
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
