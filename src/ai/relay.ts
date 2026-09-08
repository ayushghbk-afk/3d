// Browser side of the optional local relay server (server/agent-relay.mjs).
// The relay gives external processes a real HTTP API; this client long-polls
// it for queued agent calls, executes them locally, and posts results back.
// Nothing leaves the machine unless the user exposes the relay themselves.
import { Store } from '../state/store.js';
import { aiSettings } from './settings.js';
import { AgentAPI, AgentError } from './agent-api.js';
import { bridgeStatus } from './bridge.js';

export interface RelayStatus {
  running: boolean;
  connected: boolean;
  lastSeen: string | null;
  pending: number;
  error: string | null;
}

export const relayStatus = new Store<RelayStatus>({
  running: false,
  connected: false,
  lastSeen: null,
  pending: 0,
  error: null,
});

interface QueuedCall {
  callId: string;
  method: string;
  params: Record<string, unknown>;
}

function relayBase(): string {
  const url = aiSettings.get().agent.relayUrl.trim().replace(/\/+$/, '');
  if (!url) throw new Error('Relay URL is empty — set it in ✨ AI → Agent API.');
  if (!/^https?:\/\//i.test(url)) throw new Error('Relay URL must start with http(s)://');
  return url;
}

function relayToken(): string {
  const t = aiSettings.get().agent.relayToken;
  if (!t) throw new Error('Relay token is empty — paste the token printed by `npm run agent-relay`.');
  return t;
}

export async function checkRelayHealth(): Promise<{ ok: boolean; pendingCalls: number; version: string }> {
  const res = await fetch(`${relayBase()}/v1/health`, {
    headers: { Authorization: `Bearer ${relayToken()}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) throw new Error('Relay rejected the token (401) — check the token in ✨ AI → Agent API.');
  if (!res.ok) throw new Error(`Relay health check failed: HTTP ${res.status}.`);
  return (await res.json()) as { ok: boolean; pendingCalls: number; version: string };
}

export class RelayClient {
  private api: AgentAPI;
  private stopFlag = false;
  private running = false;
  private clientId = `browser-${Math.random().toString(36).slice(2, 10)}`;

  constructor(api: AgentAPI) {
    this.api = api;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!aiSettings.get().agent.enabled) {
      throw new Error('Enable the Agent API first (✨ AI → Agent API).');
    }
    // Validate config + connectivity before flipping state.
    const health = await checkRelayHealth();
    this.running = true;
    this.stopFlag = false;
    relayStatus.set({ running: true, connected: true, lastSeen: new Date().toISOString(), pending: health.pendingCalls ?? 0, error: null });
    bridgeStatus.set({ ...bridgeStatus.get(), relay: true, relayUrl: relayBase() });
    void this.loop();
  }

  stop(): void {
    this.stopFlag = true;
    this.running = false;
    relayStatus.set({ ...relayStatus.get(), running: false, connected: false, pending: 0 });
    bridgeStatus.set({ ...bridgeStatus.get(), relay: false });
  }

  private setError(msg: string): void {
    relayStatus.set({ ...relayStatus.get(), connected: false, error: msg });
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopFlag) {
      try {
        const calls = await this.poll();
        backoff = 1000;
        relayStatus.set({
          ...relayStatus.get(),
          connected: true,
          lastSeen: new Date().toISOString(),
          pending: calls.length,
          error: null,
        });
        for (const call of calls) {
          if (this.stopFlag) break;
          await this.execute(call);
        }
      } catch (e) {
        if (this.stopFlag) break;
        const msg = (e as Error).message || 'Relay error';
        // Long-poll timeouts are normal; only surface real failures.
        if (!/timeout|abort|network|fetch/i.test(msg)) this.setError(msg);
        else relayStatus.set({ ...relayStatus.get(), connected: true, lastSeen: new Date().toISOString(), error: null });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(15000, backoff * 1.5);
      }
    }
  }

  private async poll(): Promise<QueuedCall[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 35000); // server holds ≤30s
    try {
      const res = await fetch(`${relayBase()}/v1/queue?client=${encodeURIComponent(this.clientId)}`, {
        headers: { Authorization: `Bearer ${relayToken()}` },
        signal: ctrl.signal,
      });
      if (res.status === 401) throw new Error('Relay rejected the token (401).');
      if (!res.ok) throw new Error(`Relay queue failed: HTTP ${res.status}.`);
      const json = (await res.json()) as { calls?: QueuedCall[] };
      return Array.isArray(json.calls) ? json.calls : [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(call: QueuedCall): Promise<void> {
    let ok = true;
    let result: unknown = null;
    let error: { code: string; message: string } | null = null;
    try {
      // Relay calls arrive pre-authenticated by the relay token; run them as
      // the relay service actor with full scopes (still gated on agent.enabled).
      result = await this.api.call(call.method ?? '', (call.params ?? {}) as Record<string, unknown>, {
        actor: 'relay:service',
        transport: 'relay',
        token: null,
      });
    } catch (e) {
      ok = false;
      error = { code: e instanceof AgentError ? e.code : 'INTERNAL', message: (e as Error).message || 'Internal error' };
    }
    try {
      await fetch(`${relayBase()}/v1/result`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${relayToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: call.callId, ok, result, error }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      /* the relay will time out the caller; nothing else we can do */
    }
  }
}
