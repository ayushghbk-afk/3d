// AI provider + Agent API settings. Stored on-device in IndexedDB (`settings`
// store) so custom endpoints and keys never leave the user's browser except to
// call the endpoint itself. Env vars (VITE_AI_*) provide deploy-time defaults.
import { localDb } from '../lib/indexeddb.js';
import { Store } from '../state/store.js';
import { uid, nowIso } from '../lib/utils.js';
import type { AgentActivityEntry, AgentScope, AgentTokenMeta } from './types.js';

export interface CustomEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiSettings {
  version: 1;
  /** Free default: Pollinations text (OpenAI-compatible, no key). */
  assistantProvider: 'pollinations' | 'custom';
  assistantCustom: CustomEndpoint;
  /** Free default: Pollinations Flux image endpoint (no key). */
  imageProvider: 'pollinations' | 'custom';
  imageCustom: CustomEndpoint;
  /** Free default: Stable Fast 3D via Hugging Face Space (no key). */
  meshProvider: 'sf3d' | 'triposr' | 'custom';
  /** Override for the SF3D Space (e.g. your own GPU Space). */
  sf3dSpaceUrl: string;
  meshCustom: CustomEndpoint & { spaceUrl: string };
  /** Optional: Hugging Face token shortens TripoSR queue waits. Free at hf.co. */
  hfToken: string;
  /** Optional: Pollinations key (free at enter.pollinations.ai/keys) — uses the
   * current gen.pollinations.ai API for Ask with higher reliability/limits. */
  pollinationsKey: string;
  agent: {
    enabled: boolean;
    tokens: AgentTokenMeta[];
    /** postMessage origins allowed to call without same-origin (one per line). */
    allowedOrigins: string[];
    /** Local relay server URL, e.g. http://127.0.0.1:8787 (empty = relay off). */
    relayUrl: string;
    relayToken: string;
    /** Max agent calls per token per rolling minute. */
    rateLimitPerMin: number;
  };
  activity: AgentActivityEntry[];
}

const STORE_KEY = 'ai.settings.v1';
const MAX_ACTIVITY = 120;

function env(name: string): string {
  try {
    return ((import.meta as unknown as { env?: Record<string, string> }).env?.[name] ?? '').trim();
  } catch {
    return '';
  }
}

export function defaultSettings(): AiSettings {
  return {
    version: 1,
    assistantProvider: 'pollinations',
    assistantCustom: {
      baseUrl: env('VITE_AI_ASSISTANT_URL') || 'https://api.openai.com/v1',
      apiKey: env('VITE_AI_ASSISTANT_KEY'),
      model: env('VITE_AI_ASSISTANT_MODEL') || 'gpt-4o-mini',
    },
    imageProvider: 'pollinations',
    imageCustom: {
      baseUrl: env('VITE_AI_IMAGE_URL') || 'https://api.openai.com/v1',
      apiKey: env('VITE_AI_IMAGE_KEY'),
      model: env('VITE_AI_IMAGE_MODEL') || 'dall-e-3',
    },
    meshProvider: 'sf3d',
    sf3dSpaceUrl: env('VITE_AI_SF3D_SPACE') || 'https://stabilityai-stable-fast-3d.hf.space',
    meshCustom: {
      baseUrl: env('VITE_AI_3D_URL'),
      apiKey: env('VITE_AI_3D_KEY'),
      model: env('VITE_AI_3D_MODEL') || 'text-to-3d',
      spaceUrl: env('VITE_AI_TRIPOSR_SPACE') || 'https://stabilityai-triposr.hf.space',
    },
    hfToken: env('VITE_HF_TOKEN'),
    pollinationsKey: env('VITE_POLLINATIONS_KEY'),
    agent: {
      enabled: false,
      tokens: [],
      allowedOrigins: [],
      relayUrl: env('VITE_AGENT_RELAY_URL'),
      relayToken: '',
      rateLimitPerMin: 120,
    },
    activity: [],
  };
}

/** Merge stored JSON over defaults; never throws on corrupt input. */
export function normalizeSettings(raw: unknown): AiSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const s = raw as Partial<AiSettings>;
  const custom = (v: unknown, fallback: CustomEndpoint): CustomEndpoint => ({
    baseUrl: typeof (v as CustomEndpoint)?.baseUrl === 'string' ? (v as CustomEndpoint).baseUrl.trim() : fallback.baseUrl,
    apiKey: typeof (v as CustomEndpoint)?.apiKey === 'string' ? (v as CustomEndpoint).apiKey.trim() : fallback.apiKey,
    model: typeof (v as CustomEndpoint)?.model === 'string' ? (v as CustomEndpoint).model.trim() : fallback.model,
  });
  const meshCustom = custom(s.meshCustom, d.meshCustom) as AiSettings['meshCustom'];
  meshCustom.spaceUrl =
    typeof s.meshCustom?.spaceUrl === 'string' && s.meshCustom.spaceUrl.trim()
      ? s.meshCustom.spaceUrl.trim().replace(/\/+$/, '')
      : d.meshCustom.spaceUrl;
  const tokens = Array.isArray(s.agent?.tokens)
    ? (s.agent?.tokens as AgentTokenMeta[]).filter(
        (t) => t && typeof t.id === 'string' && typeof t.secretHash === 'string',
      )
    : [];
  return {
    version: 1,
    assistantProvider: s.assistantProvider === 'custom' ? 'custom' : 'pollinations',
    assistantCustom: custom(s.assistantCustom, d.assistantCustom),
    imageProvider: s.imageProvider === 'custom' ? 'custom' : 'pollinations',
    imageCustom: custom(s.imageCustom, d.imageCustom),
    meshProvider: s.meshProvider === 'custom' ? 'custom' : s.meshProvider === 'triposr' ? 'triposr' : 'sf3d',
    sf3dSpaceUrl:
      typeof s.sf3dSpaceUrl === 'string' && s.sf3dSpaceUrl.trim()
        ? s.sf3dSpaceUrl.trim().replace(/\/+$/, '')
        : d.sf3dSpaceUrl,
    meshCustom,
    hfToken: typeof s.hfToken === 'string' ? s.hfToken.trim() : '',
    pollinationsKey: typeof s.pollinationsKey === 'string' ? s.pollinationsKey.trim() : '',
    agent: {
      enabled: s.agent?.enabled === true,
      tokens,
      allowedOrigins: Array.isArray(s.agent?.allowedOrigins)
        ? (s.agent?.allowedOrigins as string[]).filter((o) => typeof o === 'string' && o.startsWith('http')).slice(0, 20)
        : [],
      relayUrl: typeof s.agent?.relayUrl === 'string' ? s.agent.relayUrl.trim().replace(/\/+$/, '') : '',
      relayToken: typeof s.agent?.relayToken === 'string' ? s.agent.relayToken : '',
      rateLimitPerMin: Math.max(1, Math.min(600, Number(s.agent?.rateLimitPerMin) || d.agent.rateLimitPerMin)),
    },
    activity: Array.isArray(s.activity) ? (s.activity as AgentActivityEntry[]).slice(-MAX_ACTIVITY) : [],
  };
}

export const aiSettings = new Store<AiSettings>(defaultSettings());
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadAiSettings(): Promise<AiSettings> {
  if (loaded) return aiSettings.get();
  loaded = true;
  try {
    const raw = await localDb.getSetting(STORE_KEY);
    aiSettings.set(normalizeSettings(raw ? (JSON.parse(raw) as unknown) : null));
  } catch {
    aiSettings.set(defaultSettings());
  }
  return aiSettings.get();
}

export function updateAiSettings(fn: (s: AiSettings) => AiSettings): AiSettings {
  const next = normalizeSettings(fn(aiSettings.get()));
  aiSettings.set(next);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void localDb.setSetting(STORE_KEY, JSON.stringify(next)).catch(() => undefined);
  }, 350);
  return next;
}

export async function flushAiSettings(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await localDb.setSetting(STORE_KEY, JSON.stringify(aiSettings.get()));
  } catch {
    /* local-first: a failed persist must not break the session */
  }
}

export function logActivity(entry: Omit<AgentActivityEntry, 'at'>): void {
  updateAiSettings((s) => ({
    ...s,
    activity: [...s.activity, { ...entry, at: nowIso() }].slice(-MAX_ACTIVITY),
  }));
}

// ---------- tokens ----------

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export async function hashSecret(secret: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`web3d-agent:${secret}`));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through to non-crypto hash */
  }
  return fnv1a(`web3d-agent:${secret}`);
}

function randomSecret(bytes = 24): string {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    c.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  while (out.length < bytes * 2) out += Math.floor(Math.random() * 0xffffffff).toString(16);
  return out.slice(0, bytes * 2);
}

export async function createAgentToken(
  label: string,
  scopes: AgentScope[],
  expiresInDays: number | null,
): Promise<{ meta: AgentTokenMeta; secret: string }> {
  const secret = randomSecret();
  const meta: AgentTokenMeta = {
    id: uid(),
    label: label.trim().slice(0, 60) || 'Agent',
    secretHash: await hashSecret(secret),
    scopes: scopes.length ? [...new Set(scopes)] : ['read'],
    createdAt: nowIso(),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null,
    lastUsedAt: null,
    calls: 0,
  };
  updateAiSettings((s) => ({ ...s, agent: { ...s.agent, tokens: [...s.agent.tokens, meta] } }));
  await flushAiSettings();
  return { meta, secret: `w3d_${meta.id.slice(0, 8)}_${secret}` };
}

export async function verifyAgentToken(secret: string): Promise<AgentTokenMeta | null> {
  if (!secret || typeof secret !== 'string') return null;
  // Accept both the full `w3d_<id>_<secret>` form and a bare secret.
  const bare = secret.startsWith('w3d_') ? secret.split('_').slice(2).join('_') : secret;
  if (!bare) return null;
  const hash = await hashSecret(bare);
  const tokens = aiSettings.get().agent.tokens;
  const meta = tokens.find((t) => t.secretHash === hash) ?? null;
  if (!meta) return null;
  if (meta.expiresAt && new Date(meta.expiresAt).getTime() < Date.now()) return null;
  updateAiSettings((s) => ({
    ...s,
    agent: {
      ...s.agent,
      tokens: s.agent.tokens.map((t) =>
        t.id === meta.id ? { ...t, lastUsedAt: nowIso(), calls: t.calls + 1 } : t,
      ),
    },
  }));
  return { ...meta };
}

export function revokeAgentToken(id: string): void {
  updateAiSettings((s) => ({ ...s, agent: { ...s.agent, tokens: s.agent.tokens.filter((t) => t.id !== id) } }));
}
