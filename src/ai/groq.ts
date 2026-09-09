// Default Ask assistant: Groq Llama via a public Cloudflare Worker proxy
// (https://groq-proxy.mr-hackerdon808.workers.dev/). The worker holds Groq
// keys server-side; the browser sends OpenAI-style chat completions, no key.
import type { AgentMessage, ChatOptions } from './types.js';
import { ProviderError, fetchWithTimeout, type ChatProvider } from './providers.js';

export const GROQ_PROXY_URL = 'https://groq-proxy.mr-hackerdon808.workers.dev';
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/** Paths the proxy may accept. GET is health-only; AI is POST. */
export function groqChatUrls(base: string): string[] {
  const b = (base || GROQ_PROXY_URL).trim().replace(/\/+$/, '');
  return [
    `${b}/`,
    `${b}/openai/v1/chat/completions`,
    `${b}/v1/chat/completions`,
    `${b}/chat/completions`,
  ];
}

/** Pull assistant text out of Groq / OpenAI / loose proxy JSON. */
export function parseGroqReply(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  // Worker health payload — not a model reply.
  if (o.service === 'groq-proxy' && o.ok === true) return null;
  const choices = o.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const c = choices[0] as Record<string, unknown>;
    const msg = c.message;
    if (msg && typeof msg === 'object') {
      const content = (msg as { content?: unknown }).content;
      const text = flattenContent(content);
      if (text) return text;
    }
    if (typeof c.text === 'string' && c.text.trim()) return c.text.trim();
  }
  for (const key of ['response', 'output', 'text', 'content', 'answer']) {
    const text = flattenContent(o[key]);
    if (text) return text;
  }
  if (typeof o.message === 'string' && o.message.trim() && o.message !== 'Worker is online. Use POST for AI requests.') {
    return o.message.trim();
  }
  return null;
}

function flattenContent(content: unknown): string | null {
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
    return text.trim() || null;
  }
  return null;
}

function readError(status: number, text: string): string {
  if (!text) return `HTTP ${status}`;
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message;
    if (msg) return `HTTP ${status}: ${String(msg).slice(0, 220)}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}: ${text.slice(0, 220)}`;
}

export class GroqProxyChatProvider implements ChatProvider {
  id = 'groq-proxy';
  label = 'Groq Llama (proxy)';
  free = true;
  private base: string;
  private model: string;
  private apiKey?: string;

  constructor(opts: { baseUrl?: string; model?: string; apiKey?: string } = {}) {
    this.base = (opts.baseUrl || GROQ_PROXY_URL).trim().replace(/\/+$/, '') || GROQ_PROXY_URL;
    this.model = (opts.model || GROQ_DEFAULT_MODEL).trim() || GROQ_DEFAULT_MODEL;
    if (opts.apiKey?.trim()) this.apiKey = opts.apiKey.trim();
  }

  async chat(messages: AgentMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = (opts.model || this.model).trim() || GROQ_DEFAULT_MODEL;
    const payload = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })).slice(-20),
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 800,
      stream: false,
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const failures: string[] = [];
    for (const url of groqChatUrls(this.base)) {
      try {
        const res = await fetchWithTimeout(
          url,
          { method: 'POST', signal: opts.signal, headers, body: JSON.stringify(payload) },
          90000,
        );
        const raw = await res.text();
        if (!res.ok) {
          failures.push(`${new URL(url).pathname || '/'}: ${readError(res.status, raw)}`);
          continue;
        }
        let json: unknown = raw;
        try { json = JSON.parse(raw) as unknown; } catch { /* plain text */ }
        if (typeof json === 'string') {
          const text = json.trim();
          if (text && !text.includes('Worker is online')) return text;
          failures.push(`${new URL(url).pathname || '/'}: empty/health reply`);
          continue;
        }
        const text = parseGroqReply(json);
        if (text) return text;
        failures.push(`${new URL(url).pathname || '/'}: empty reply`);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        failures.push(`${url}: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
      }
    }
    throw new ProviderError(
      'groq-proxy',
      `Couldn't reach the Groq assistant (${failures.join(' · ') || 'network error'}). ` +
        'The proxy may be down or blocking this origin. Open ✨ AI → Setup to retry, switch to Pollinations, or point Ask at your own endpoint. ' +
        'Factual scene questions still get offline answers.',
      true,
    );
  }

  async test(): Promise<string> {
    const started = Date.now();
    const out = await this.chat([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 16, temperature: 0 });
    return `Groq proxy OK in ${Date.now() - started}ms (said: ${out.slice(0, 40)}).`;
  }
}
