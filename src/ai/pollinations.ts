// FREE default providers (no signup, no API key):
// - Textures/images: Pollinations' legacy image host (URL-based, CORS-enabled).
// - Assistant chat: Pollinations OpenAI-compatible text endpoint.
// Anonymous image tier is throttled (~1 request / 15s); chat models vary —
// both stay optional and every call has an offline/custom fallback.
//
// Upstream reality check (probed live on 2026-09-12, do not "fix" by faith):
// - `GET https://image.pollinations.ai/models` (anonymous free tier) returns
//   `["sana"]`. Asking that host for `model=flux` still returns a JPEG, but the
//   response's own `requestParameters.model` says `sana` — the host silently
//   substitutes its default. So "free tier = FLUX" is no longer true; we ask for
//   flux, detect what is actually served, and report that instead of lying.
// - Real FLUX (black-forest-labs/flux.1-schnell alias, flux.2-pro/flex) lives on
//   the keyed unified API `https://gen.pollinations.ai/image/{prompt}`, which
//   answers 401 without a key (Pollen credits, $1 ≈ 1 Pollen). If the user has
//   pasted a key we route images there and FLUX really is used.
// - `enhance`, `nologo` and `negative_prompt` were removed upstream on
//   2026-06-10 ("they weren't doing anything anyway"). They are still *accepted*
//   and ignored. `nologo` is kept for self-hosted mirrors; `enhance` is not sent.
import type { AgentMessage, ChatOptions, ImageGenOptions, ImageGenResult } from './types.js';
import { fetchWithTimeout, hostOf, randomSeed, type ChatProvider, type ImageProvider } from './providers.js';

export const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai';
export const POLLINATIONS_TEXT_BASE = 'https://text.pollinations.ai';
/** Current unified API (v0.3+): OpenAI-compatible chat + keyed GET endpoints. */
export const POLLINATIONS_GEN_BASE = 'https://gen.pollinations.ai';
export const POLLINATIONS_FREE_IMAGE_MODEL = 'flux';
export const POLLINATIONS_FREE_CHAT_MODEL = 'openai';
/** Where the free tier publishes the models it actually serves. */
export const POLLINATIONS_IMAGE_MODELS_URL = `${POLLINATIONS_IMAGE_BASE}/models`;
/** Aliases that all mean "some FLUX variant" and may be rewritten by the host. */
export const FLUX_MODEL_ALIASES: readonly string[] = [
  'flux',
  'flux-schnell',
  'flux-dev',
  'turbo',
  'black-forest-labs/flux.1-schnell',
  'black-forest-labs/flux.1-dev',
  'black-forest-labs/flux.2-pro',
  'black-forest-labs/flux.2-flex',
];

export interface PollinationsImageParams {
  width: number;
  height: number;
  model: string;
  seed: number;
  /** Accepted but ignored by pollinations.ai since 2026-06-10; keep for mirrors. */
  nologo: boolean;
  /** Identifies the app on the anonymous tier (no key needed). */
  referrer: string;
  /** Optional user key (?key=) — raises anonymous limits where honored. */
  key?: string;
}

/** Shared query string for both image endpoints. */
function imageQuery(params: Partial<PollinationsImageParams>): URLSearchParams {
  const width = clampInt(params.width ?? 512, 64, 2048);
  const height = clampInt(params.height ?? 512, 64, 2048);
  const seed = params.seed ?? randomSeed();
  const model = (params.model || POLLINATIONS_FREE_IMAGE_MODEL).trim() || POLLINATIONS_FREE_IMAGE_MODEL;
  const q = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    seed: String(seed),
    // Legacy no-op on pollinations.ai since 2026-06-10; still honored by
    // self-hosted mirrors, and harmless here. `enhance` is deliberately absent.
    nologo: params.nologo === false ? 'false' : 'true',
  });
  if (params.referrer) q.set('referrer', params.referrer);
  if (params.key) q.set('key', params.key);
  return q;
}

/** Pure URL builder (unit-tested) for the free image endpoint. */
export function buildPollinationsImageUrl(
  prompt: string,
  params: Partial<PollinationsImageParams> = {},
  base: string = POLLINATIONS_IMAGE_BASE,
): string {
  const q = imageQuery(params);
  return `${base.replace(/\/+$/, '')}/prompt/${encodeURIComponent(prompt.slice(0, 2000))}?${q.toString()}`;
}

/**
 * Keyed unified API (`/image/{prompt}`) — the only path that still reaches the
 * real FLUX weights. The key travels in an `Authorization` header (see
 * `PollinationsImageProvider`), never in the URL, so it cannot leak into
 * browser history, service-worker logs or a shared image URL.
 */
export function buildPollinationsGenImageUrl(
  prompt: string,
  params: Partial<PollinationsImageParams> = {},
  base: string = POLLINATIONS_GEN_BASE,
): string {
  const q = imageQuery({ ...params, key: undefined, referrer: undefined });
  return `${base.replace(/\/+$/, '')}/image/${encodeURIComponent(prompt.slice(0, 2000))}?${q.toString()}`;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** Accepts `["sana", …]` or the catalog shape `[{name, id, aliases}, …]`. */
export function parsePollinationsModelList(raw: unknown): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: unknown[] }).data as unknown[])
      : [];
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  };
  for (const item of arr.slice(0, 64)) {
    if (typeof item === 'string') {
      push(item);
      continue;
    }
    const o = item as { name?: string; id?: string; aliases?: unknown };
    push(o?.name);
    push(o?.id);
    if (Array.isArray(o?.aliases)) for (const a of o.aliases as unknown[]) push(a);
  }
  return out;
}

/**
 * What model should we actually name in the URL?
 * Unknown / empty list → trust the caller. Listed → use it verbatim, or the
 * closest alias the host serves, otherwise the host's own default (the first
 * entry) — which is exactly what the anonymous host would silently use anyway,
 * only now the name we display matches the pixels we get back.
 */
export function negotiatePollinationsImageModel(requested: string, available: string[]): string {
  const want = (requested || POLLINATIONS_FREE_IMAGE_MODEL).trim() || POLLINATIONS_FREE_IMAGE_MODEL;
  if (!available.length) return want;
  if (available.includes(want)) return want;
  const tail = want.includes('/') ? want.slice(want.indexOf('/') + 1) : want;
  const byTail = available.find((m) => m === tail || m.endsWith(`/${tail}`) || m.includes(want));
  if (byTail) return byTail;
  if (FLUX_MODEL_ALIASES.includes(want)) {
    const anyFlux = available.find((m) => FLUX_MODEL_ALIASES.includes(m) || /flux/i.test(m));
    if (anyFlux) return anyFlux;
  }
  return available[0];
}

let modelsCache: { at: number; list: string[] } | null = null;
let modelsInflight: Promise<string[]> | null = null;

/** Cached read of the free tier's live model list; resolves [] when offline. */
export async function fetchPollinationsFreeImageModels(ttlMs = 300000): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < ttlMs) return modelsCache.list;
  if (!modelsInflight) {
    modelsInflight = (async (): Promise<string[]> => {
      let list: string[] = [];
      try {
        const res = await fetchWithTimeout(POLLINATIONS_IMAGE_MODELS_URL, { headers: { Accept: 'application/json' } }, 10000);
        if (res.ok) list = parsePollinationsModelList(await res.json());
      } catch {
        list = [];
      }
      modelsCache = { at: Date.now(), list };
      return list;
    })().finally(() => {
      modelsInflight = null;
    });
  }
  return modelsInflight;
}

/** Test-only: forget the cached model list. */
export function resetPollinationsModelCache(): void {
  modelsCache = null;
  modelsInflight = null;
}


/** Turns a plain idea ("rusty metal") into a texture-friendly prompt. */
export function texturePrompt(prompt: string, seamless: boolean): string {
  const base = prompt.trim().slice(0, 500) || 'abstract surface';
  const suffix = seamless
    ? ', seamless tileable texture, flat front view, no perspective, no objects, no background, uniform lighting, high detail'
    : ', game texture, flat front view, uniform lighting, high detail, no watermark';
  return `${base}${suffix}`;
}

async function downloadImage(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<Blob> {
  const res = await fetchWithTimeout(url, { signal, headers: { Accept: 'image/*', ...(headers ?? {}) } }, timeoutMs);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(pollinationsImageError(res.status, hostOf(url), text));
  }
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') && blob.size < 1024) {
    throw new Error('Pollinations did not return an image (rate limit? try again in ~15s).');
  }
  return blob;
}

/**
 * Actionable image-tier errors. `body` is the truncated response text: the
 * legacy host echoes the request it really ran (`requestParameters`), which is
 * often the only way to learn it swapped your model or clamped your size.
 */
export function pollinationsImageError(status: number, host: string, body = ''): string {
  const detail = body.trim() ? ` — ${body.trim().slice(0, 180)}` : '';
  if (status === 401 || status === 403) {
    return (
      `${host} needs an API key for that request (HTTP ${status}). The free image tier stays keyless on ` +
      'image.pollinations.ai; keys for the full model list (real FLUX, GPT-Image…) are free at ' +
      'enter.pollinations.ai/keys → ✨ AI → Setup → Pollinations key.'
    );
  }
  if (status === 402) {
    return `${host} asked for payment (HTTP 402) — the Pollinations key in ✨ AI → Setup is out of Pollen credits. Top up at enter.pollinations.ai, or remove the key to fall back to the free tier.`;
  }
  if (status === 429) {
    return `${host} throttled the free tier (HTTP 429): anonymous access is ≈1 image / 15s. Wait a few seconds and retry, or add a free key for the higher limits.`;
  }
  if (status >= 500) {
    return (
      `${host} could not render that image (HTTP ${status})${detail}. The free tier answers 5xx when a ` +
      'prompt or size is unsupported — retry once, try a smaller square size, or change the model in ✨ AI → Setup.'
    );
  }
  return `${host} returned HTTP ${status}${detail}.`;
}

export class PollinationsImageProvider implements ImageProvider {
  id = 'pollinations';
  label = 'Pollinations image tier (free, no key)';
  free = true;
  private apiKey?: string;

  constructor(apiKey?: string) {
    if (apiKey?.trim()) this.apiKey = apiKey.trim();
  }

  /**
   * Free path: legacy anonymous host, named model chosen from its live list so
   * the reported model matches the pixels (it silently substitutes otherwise).
   * Keyed path: unified API first (real FLUX), anonymous free tier on failure.
   */
  async generateImage(prompt: string, opts: ImageGenOptions = {}): Promise<ImageGenResult> {
    const clean = prompt.trim().slice(0, 2000);
    if (!clean) throw new Error('Describe the image first.');
    const width = clampInt(opts.width ?? 512, 64, 2048);
    const height = clampInt(opts.height ?? 512, 64, 2048);
    const seed = opts.seed ?? randomSeed();
    const requested = (opts.model || POLLINATIONS_FREE_IMAGE_MODEL).trim() || POLLINATIONS_FREE_IMAGE_MODEL;
    const referrer = typeof location !== 'undefined' ? location.host : 'web-3d-studio';

    let keyError = '';
    if (this.apiKey) {
      try {
        const url = buildPollinationsGenImageUrl(clean, { width, height, model: requested, seed });
        const blob = await downloadImage(url, 120000, opts.signal, { Authorization: `Bearer ${this.apiKey as string}` });
        return {
          blob,
          mime: blob.type || 'image/jpeg',
          width,
          height,
          seed,
          provider: this.id,
          prompt: clean,
          model: requested,
          tier: 'keyed',
        };
      } catch (e) {
        const err = e as Error;
        if (opts.signal?.aborted || err?.name === 'AbortError') throw err;
        keyError = err?.message ?? String(err);
      }
    }

    const explicit = Boolean((opts.model ?? '').trim());
    const models = explicit ? [] : await fetchPollinationsFreeImageModels();
    const model = explicit ? requested : negotiatePollinationsImageModel(requested, models);
    const url = buildPollinationsImageUrl(clean, { width, height, model, seed, referrer });
    try {
      const blob = await downloadImage(url, 120000, opts.signal);
      return {
        blob,
        mime: blob.type || 'image/jpeg',
        width,
        height,
        seed,
        provider: this.id,
        prompt: clean,
        model,
        tier: 'anonymous',
        warning: keyError || undefined,
      };
    } catch (e) {
      const err = e as Error;
      if (opts.signal?.aborted || err?.name === 'AbortError') throw err;
      throw new Error(keyError ? `${keyError} (free tier fallback also failed: ${err.message})` : err.message);
    }
  }

  async test(): Promise<string> {
    const started = Date.now();
    const referrer = typeof location !== 'undefined' ? location.host : 'web-3d-studio';
    const url = buildPollinationsImageUrl('test swatch, flat color', { width: 64, height: 64, referrer });
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'image/*', Range: 'bytes=0-0' } }, 45000);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(pollinationsImageError(res.status, hostOf(url), text));
    }
    const model = negotiatePollinationsImageModel(POLLINATIONS_FREE_IMAGE_MODEL, await fetchPollinationsFreeImageModels());
    const fluxish = /flux/i.test(model);
    return (
      `Pollinations reachable in ${Date.now() - started}ms (free image tier OK, model: ${model}).` +
      (fluxish || this.apiKey
        ? ''
        : ' The anonymous tier no longer serves FLUX — add a free key in ✨ AI → Setup for black-forest-labs models.')
    );
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
