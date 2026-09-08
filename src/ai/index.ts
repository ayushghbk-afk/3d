// AI facade: single entry point wiring settings, agent, transports and relay.
// main.ts calls initAi() once; the editor registers/unregisters its session.
import { aiSettings, loadAiSettings } from './settings.js';
import { AgentAPI } from './agent-api.js';
import { installChannelBridge, installPostMessageBridge, installWindowBridge } from './bridge.js';
import { RelayClient } from './relay.js';
import type { AgentSessionLike } from './types.js';

let api: AgentAPI | null = null;
let relay: RelayClient | null = null;
let sessionGetter: () => AgentSessionLike | null = () => null;
let initialized = false;

/** Called by the editor on mount/unmount so the agent tracks the live project. */
export function setEditorSession(session: AgentSessionLike | null): void {
  sessionGetter = () => session;
}

export function getAgent(): AgentAPI {
  if (!api) api = new AgentAPI(() => sessionGetter());
  return api;
}

export function getRelay(): RelayClient {
  if (!relay) relay = new RelayClient(getAgent());
  return relay;
}

export async function initAi(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const agent = getAgent();
  try {
    await loadAiSettings();
  } catch {
    /* defaults already in place */
  }
  try {
    installWindowBridge(agent);
  } catch {
    /* non-DOM environment (tests) */
  }
  try {
    installPostMessageBridge(agent);
    installChannelBridge(agent);
  } catch {
    /* non-DOM environment (tests) */
  }
  // Autostart the relay loop only when the user configured it before.
  const s = aiSettings.get();
  if (s.agent.enabled && s.agent.relayUrl && s.agent.relayToken) {
    try {
      await getRelay().start();
    } catch {
      /* relay server not running — user can reconnect from the UI */
    }
  }
}

export { AGENT_API_VERSION } from './agent-api.js';
