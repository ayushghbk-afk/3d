// Agent transports for a static page (no server required):
// 1. window.Web3DStudio.agent — direct JS calls (console, extensions, userscripts).
// 2. window.postMessage — iframes / embedded agents ({type:'web3d-agent-request'}).
// 3. BroadcastChannel 'web3dstudio-agent-v1' — other tabs / extension pages.
// 4. Local relay server — real HTTP for external processes (see relay.ts and
//    server/agent-relay.mjs).
import { Store } from '../state/store.js';
import { aiSettings } from './settings.js';
import { AgentAPI, AgentError } from './agent-api.js';
import type { AgentTransport } from './types.js';

export const AGENT_CHANNEL = 'web3dstudio-agent-v1';
export const AGENT_POSTMESSAGE_TYPE = 'web3d-agent-request';
export const AGENT_POSTMESSAGE_RESPONSE = 'web3d-agent-response';

export interface BridgeStatus {
  page: boolean;
  postmessage: boolean;
  channel: boolean;
  relay: boolean;
  relayUrl: string | null;
}

export const bridgeStatus = new Store<BridgeStatus>({
  page: false,
  postmessage: false,
  channel: false,
  relay: false,
  relayUrl: null,
});

interface WireRequest {
  type?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  token?: string;
}

function bearerOf(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return null;
  return token.startsWith('Bearer ') ? token.slice(7) : token;
}

function isOriginAllowed(origin: string): boolean {
  if (origin === window.location.origin) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return aiSettings.get().agent.allowedOrigins.includes(origin);
}

export function installWindowBridge(api: AgentAPI): void {
  const w = window as unknown as Record<string, unknown>;
  const agent = {
    version: '1.0.0',
    methods: api.methods(),
    /** agent.call('object.list', {projectId}, 'w3d_token...') */
    call: (method: string, params?: Record<string, unknown>, token?: string) =>
      api.authorizedCall(method, params ?? {}, 'page', token ?? null),
    capabilities: () => api.authorizedCall('agent.capabilities', {}, 'page', null),
  };
  w.Web3DStudio = { ...(w.Web3DStudio as object | undefined), agent };
  // Legacy alias kept stable for scripts written against early docs.
  w.__WEB3D_AGENT__ = agent;
  bridgeStatus.set({ ...bridgeStatus.get(), page: true });
}

export function installPostMessageBridge(api: AgentAPI): () => void {
  const handler = (event: MessageEvent): void => {
    const data = event.data as WireRequest | null;
    if (!data || typeof data !== 'object' || data.type !== AGENT_POSTMESSAGE_TYPE) return;
    if (!isOriginAllowed(event.origin)) return;
    const { id = null, method = '', params = {}, token = null } = data;
    const source = event.source as Window | null;
    const respond = (ok: boolean, payload: unknown): void => {
      const msg = {
        type: AGENT_POSTMESSAGE_RESPONSE,
        id,
        ok,
        ...(ok ? { result: payload } : { error: payload }),
      };
      if (source && 'postMessage' in source) {
        try {
          (source as Window).postMessage(msg, event.origin);
        } catch {
          /* recipient gone */
        }
      }
    };
    if (typeof method !== 'string' || !method) {
      respond(false, { code: 'VALIDATION', message: 'Missing method.' });
      return;
    }
    void api
      .authorizedCall(method, (params ?? {}) as Record<string, unknown>, 'postmessage', bearerOf(token))
      .then(
        (result) => respond(true, result),
        (e) => respond(false, { code: e instanceof AgentError ? e.code : 'INTERNAL', message: (e as Error).message }),
      );
  };
  window.addEventListener('message', handler);
  bridgeStatus.set({ ...bridgeStatus.get(), postmessage: true });
  return () => {
    window.removeEventListener('message', handler);
    bridgeStatus.set({ ...bridgeStatus.get(), postmessage: false });
  };
}

export function installChannelBridge(api: AgentAPI): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(AGENT_CHANNEL);
  channel.onmessage = (event: MessageEvent): void => {
    const data = event.data as WireRequest | null;
    if (!data || typeof data !== 'object' || data.type !== AGENT_POSTMESSAGE_TYPE) return;
    const { id = null, method = '', params = {}, token = null } = data;
    if (typeof method !== 'string' || !method) {
      channel.postMessage({ type: AGENT_POSTMESSAGE_RESPONSE, id, ok: false, error: { code: 'VALIDATION', message: 'Missing method.' } });
      return;
    }
    void api
      .authorizedCall(method, (params ?? {}) as Record<string, unknown>, 'channel', bearerOf(token))
      .then(
        (result) => channel.postMessage({ type: AGENT_POSTMESSAGE_RESPONSE, id, ok: true, result }),
        (e) =>
          channel.postMessage({
            type: AGENT_POSTMESSAGE_RESPONSE,
            id,
            ok: false,
            error: { code: e instanceof AgentError ? e.code : 'INTERNAL', message: (e as Error).message },
          }),
      );
  };
  bridgeStatus.set({ ...bridgeStatus.get(), channel: true });
  return () => {
    channel.close();
    bridgeStatus.set({ ...bridgeStatus.get(), channel: false });
  };
}

/** Copy-paste client snippets shown in the UI (token injected by the caller). */
export function snippetJs(token: string): string {
  return [
    `// Run in DevTools, an extension, or any script on this page:`,
    `const agent = window.Web3DStudio.agent;`,
    `const projects = await agent.call('project.list', {}, '${token}');`,
    `console.log(projects);`,
    ``,
    `// Add a red cube to the open project:`,
    `await agent.call('object.add', { kind: 'cube', name: 'Agent Cube', color: '#ff4444' }, '${token}');`,
  ].join('\n');
}

export function snippetPostMessage(token: string, origin: string): string {
  return [
    `// From an iframe / popup / embedded agent:`,
    `const target = window.opener ?? window.parent;`,
    `const id = crypto.randomUUID();`,
    `window.addEventListener('message', (e) => {`,
    `  if (e.data?.type === '${AGENT_POSTMESSAGE_RESPONSE}' && e.data.id === id) console.log(e.data);`,
    `});`,
    `target.postMessage({ type: '${AGENT_POSTMESSAGE_TYPE}', id,`,
    `  method: 'project.list', params: {}, token: '${token}' }, '${origin}');`,
  ].join('\n');
}

export function snippetChannel(token: string): string {
  return [
    `// From another tab or an extension page (same browser):`,
    `const ch = new BroadcastChannel('${AGENT_CHANNEL}');`,
    `const id = crypto.randomUUID();`,
    `ch.onmessage = (e) => { if (e.data?.id === id) console.log(e.data); };`,
    `ch.postMessage({ type: '${AGENT_POSTMESSAGE_TYPE}', id,`,
    `  method: 'project.context', params: {}, token: '${token}' });`,
  ].join('\n');
}

export function snippetCurlRelay(relayUrl: string, relayToken: string): string {
  const base = (relayUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  return [
    `# With the relay running (npm run agent-relay) and connected in ✨ AI → Agent API:`,
    `curl -s ${base}/v1/call \\`,
    `  -H 'Authorization: Bearer ${relayToken || 'RELAY_TOKEN'}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"method":"project.list","params":{}}'`,
  ].join('\n');
}

export type { AgentTransport };
