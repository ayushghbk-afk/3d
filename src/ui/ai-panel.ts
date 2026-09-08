// ✨ AI panel: free 3D generation (TripoSR), free texture generation
// (Pollinations Flux), project Q&A, Agent API management and custom API setup.
import type { EditorSession } from '../editor/session.js';
import type { PrimitiveType } from '../state/models.js';
import { toAiContext } from '../editor/serialization.js';
import { escapeHtml } from '../lib/utils.js';
import { toast } from './toast.js';
import { openModal } from './modals.js';
import {
  aiSettings, createAgentToken, flushAiSettings, loadAiSettings, revokeAgentToken, updateAiSettings,
} from '../ai/settings.js';
import { generateImageSmart, generateMeshSmart, getChatProvider, getImageProvider, getMeshProvider } from '../ai/factory.js';
import { texturePrompt } from '../ai/pollinations.js';
import { getAgent, getRelay } from '../ai/index.js';
import { bridgeStatus, snippetChannel, snippetCurlRelay, snippetJs, snippetPostMessage } from '../ai/bridge.js';
import { checkRelayHealth, relayStatus } from '../ai/relay.js';
import type { AgentScope } from '../ai/types.js';

type AiTab = 'model' | 'texture' | 'ask' | 'agent' | 'settings';

export function openAiPanel(session: EditorSession, initialTab: AiTab = 'model'): void {
  const root = document.createElement('div');
  root.className = 'ai-panel';
  openModal({ title: '✨ AI Studio', body: root, wide: true });
  void loadAiSettings().then(() => renderTabs(session, root, initialTab));
}

function renderTabs(session: EditorSession, root: HTMLElement, active: AiTab): void {
  const tabs: { id: AiTab; label: string }[] = [
    { id: 'model', label: '🧊 3D Model' },
    { id: 'texture', label: '🎨 Texture' },
    { id: 'ask', label: '💬 Ask' },
    { id: 'agent', label: '🤖 Agent API' },
    { id: 'settings', label: '⚙️ Setup' },
  ];
  root.innerHTML = `
    <div class="tabs ai-tabs" role="tablist">
      ${tabs.map((t) => `<button class="tab${t.id === active ? ' active' : ''}" data-tab="${t.id}" role="tab">${t.label}</button>`).join('')}
    </div>
    <div id="ai-tab-body" class="ai-tab-body"></div>`;
  const body = root.querySelector('#ai-tab-body') as HTMLElement;
  root.querySelectorAll('[data-tab]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => renderTabs(session, root, (b as HTMLElement).dataset.tab as AiTab);
  });
  if (active === 'model') renderModelTab(session, body);
  else if (active === 'texture') renderTextureTab(session, body);
  else if (active === 'ask') renderAskTab(session, body);
  else if (active === 'agent') renderAgentTab(body);
  else renderSettingsTab(body);
}

function providerBadge(): string {
  const s = aiSettings.get();
  const mesh = s.meshProvider === 'custom' ? 'Custom 3D API' : 'TripoSR (free, no key)';
  const img = s.imageProvider === 'custom' ? 'Custom image API' : 'Pollinations Flux (free, no key)';
  return `<p class="small muted">3D: <b>${escapeHtml(mesh)}</b> · Textures: <b>${escapeHtml(img)}</b> · <a href="#" id="ai-goto-setup">change</a></p>`;
}

function wireSetupLink(scope: HTMLElement, session: EditorSession, root: HTMLElement): void {
  const link = scope.querySelector('#ai-goto-setup') as HTMLElement | null;
  if (link) {
    link.onclick = (e) => {
      e.preventDefault();
      renderTabs(session, root, 'settings');
    };
  }
}

// =====================================================================
// Tab: 3D model generation
// =====================================================================

function renderModelTab(session: EditorSession, body: HTMLElement): void {
  const s = aiSettings.get();
  body.innerHTML = `
    <div class="banner banner-info">Free text-to-3D: your prompt → reference image → <b>TripoSR</b> (Stability AI, open source) → GLB imported into the scene. First run of the day can take 1–3 min while the free service wakes up. Offline? It builds a primitive mockup instead.</div>
    ${providerBadge()}
    <label class="field">Describe the model
      <textarea id="ai3d-prompt" class="input" rows="2" placeholder="e.g. a cute low-poly robot toy"></textarea>
    </label>
    <div class="row-between">
      <label class="field" style="flex:1">Name <input id="ai3d-name" class="input" placeholder="auto from prompt" /></label>
      <label class="field">Quality
        <select id="ai3d-quality" class="input">
          <option value="fast">Fast</option>
          <option value="balanced" selected>Balanced</option>
          <option value="high">High</option>
        </select>
      </label>
    </div>
    <div id="ai3d-progress" class="ai-progress" hidden>
      <div class="ai-progress-bar"><div id="ai3d-bar"></div></div>
      <div id="ai3d-stage" class="small muted"></div>
    </div>
    <div id="ai3d-result"></div>
    <div class="row-between" style="margin-top:10px">
      <span class="small muted">${s.meshProvider === 'custom' ? 'Using your custom 3D API.' : 'Free tier · no key needed.'}</span>
      <span>
        <button class="btn btn-ghost" id="ai3d-cancel" hidden>Cancel</button>
        <button class="btn btn-primary" id="ai3d-go">Generate & add to scene</button>
      </span>
    </div>`;
  const root = body.closest('.ai-panel') as HTMLElement;
  wireSetupLink(body, session, root);
  const promptEl = body.querySelector('#ai3d-prompt') as HTMLTextAreaElement;
  const nameEl = body.querySelector('#ai3d-name') as HTMLInputElement;
  const qualityEl = body.querySelector('#ai3d-quality') as HTMLSelectElement;
  const goBtn = body.querySelector('#ai3d-go') as HTMLButtonElement;
  const cancelBtn = body.querySelector('#ai3d-cancel') as HTMLButtonElement;
  const progressEl = body.querySelector('#ai3d-progress') as HTMLElement;
  const barEl = body.querySelector('#ai3d-bar') as HTMLElement;
  const stageEl = body.querySelector('#ai3d-stage') as HTMLElement;
  const resultEl = body.querySelector('#ai3d-result') as HTMLElement;
  let ctrl: AbortController | null = null;

  cancelBtn.onclick = () => ctrl?.abort();
  goBtn.onclick = async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      toast('Describe the model first', 'warn');
      return;
    }
    ctrl = new AbortController();
    goBtn.disabled = true;
    cancelBtn.hidden = false;
    progressEl.hidden = false;
    resultEl.innerHTML = '';
    const setProgress = (stage: string, frac: number): void => {
      stageEl.textContent = stage;
      barEl.style.width = `${Math.round(frac * 100)}%`;
    };
    try {
      const outcome = await generateMeshSmart(
        prompt,
        {
          quality: qualityEl.value as 'fast' | 'balanced' | 'high',
          signal: ctrl.signal,
          onProgress: setProgress,
        },
      );
      setProgress('adding to scene', 0.95);
      if (outcome.kind === 'glb') {
        const name = nameEl.value.trim() || prompt.slice(0, 40);
        const obj = await session.importGlbBytes(name, outcome.result.glb.slice(0), `${name}.glb`);
        if (!obj) throw new Error('The generated file was not a valid 3D model.');
        resultEl.innerHTML = `<div class="banner banner-info">✅ <b>${escapeHtml(obj.name)}</b> added (${(outcome.result.glb.byteLength / 1024).toFixed(0)} KB, via ${escapeHtml(outcome.result.provider)}).${outcome.fallback ? `<br />Fallback: ${escapeHtml(outcome.fallback.to)} — ${escapeHtml(outcome.fallback.reason)}` : ''}</div>`;
        toast(`3D model added: ${obj.name}`, 'success');
      } else {
        const ids: string[] = [];
        for (const part of outcome.parts) {
          const created = part.kind === 'group' ? session.addGroup() : session.addPrimitive(part.kind as PrimitiveType);
          session.renameObject(created.id, part.name);
          session.setTransform(
            created.id,
            { x: part.position[0], y: part.position[1], z: part.position[2] },
            undefined,
            part.scale ? { x: part.scale[0], y: part.scale[1], z: part.scale[2] } : undefined,
          );
          if (part.color) {
            const mat = session.addMaterial();
            session.updateMaterial(mat.id, { name: `${part.name} color`, baseColor: part.color });
            session.assignMaterial(created.id, mat.id);
          }
          ids.push(created.id);
        }
        resultEl.innerHTML = `<div class="banner banner-warn">⚙️ AI service unavailable — built an offline primitive mockup (${ids.length} parts, template: ${escapeHtml(outcome.template)}).<br /><span class="small">${escapeHtml(outcome.fallback?.reason ?? '')}</span></div>`;
        toast('Offline mockup added (AI unavailable)', 'warn');
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        resultEl.innerHTML = '<p class="muted">Cancelled.</p>';
      } else {
        resultEl.innerHTML = `
          <div class="banner banner-warn">❌ <b>Generation failed.</b><br />${escapeHtml((e as Error).message)}
          <br /><span class="small">Common fixes: wait 1–2 min and retry (the free Space sleeps when idle and its queue fills up), check the browser console for the failing stage, or open <a href="#" id="ai3d-err-setup">Setup</a> for offline/custom 3D.</span></div>`;
        const setupLink = resultEl.querySelector('#ai3d-err-setup') as HTMLElement | null;
        setupLink?.addEventListener('click', (ev) => {
          ev.preventDefault();
          renderTabs(session, root, 'settings');
        });
        console.warn('[ai] model.generate failed at stage:', stageEl.textContent, e);
      }
    } finally {
      goBtn.disabled = false;
      cancelBtn.hidden = true;
      ctrl = null;
    }
  };
}

// =====================================================================
// Tab: texture generation
// =====================================================================

function renderTextureTab(session: EditorSession, body: HTMLElement): void {
  const s = aiSettings.get();
  const mats = session.doc.materials;
  body.innerHTML = `
    <div class="banner banner-info">Free text-to-texture (<b>Pollinations Flux</b>, no key): describe a surface and it is applied as the material's base-color map. Anonymous tier ≈ 1 image / 15s.</div>
    ${providerBadge()}
    <label class="field">Describe the texture
      <textarea id="aitex-prompt" class="input" rows="2" placeholder="e.g. rusty corrugated metal"></textarea>
    </label>
    <div class="row-between">
      <label class="field" style="flex:1">Apply to
        <select id="aitex-mat" class="input">
          <option value="">＋ New material</option>
          ${mats.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field">Size
        <select id="aitex-size" class="input">
          <option value="256">256</option>
          <option value="512" selected>512</option>
          <option value="1024">1024</option>
        </select>
      </label>
    </div>
    <label class="small"><input type="checkbox" id="aitex-seamless" checked /> Seamless / tileable</label>
    <div id="aitex-progress" class="ai-progress" hidden>
      <div class="ai-progress-bar"><div id="aitex-bar"></div></div>
      <div id="aitex-stage" class="small muted"></div>
    </div>
    <div id="aitex-result"></div>
    <div class="row-between" style="margin-top:10px">
      <span class="small muted">${s.imageProvider === 'custom' ? 'Using your custom image API.' : 'Free tier · no key needed.'}</span>
      <span>
        <button class="btn btn-ghost" id="aitex-cancel" hidden>Cancel</button>
        <button class="btn btn-primary" id="aitex-go">Generate & apply</button>
      </span>
    </div>`;
  const root = body.closest('.ai-panel') as HTMLElement;
  wireSetupLink(body, session, root);
  const promptEl = body.querySelector('#aitex-prompt') as HTMLTextAreaElement;
  const matEl = body.querySelector('#aitex-mat') as HTMLSelectElement;
  const sizeEl = body.querySelector('#aitex-size') as HTMLSelectElement;
  const seamlessEl = body.querySelector('#aitex-seamless') as HTMLInputElement;
  const goBtn = body.querySelector('#aitex-go') as HTMLButtonElement;
  const cancelBtn = body.querySelector('#aitex-cancel') as HTMLButtonElement;
  const progressEl = body.querySelector('#aitex-progress') as HTMLElement;
  const barEl = body.querySelector('#aitex-bar') as HTMLElement;
  const stageEl = body.querySelector('#aitex-stage') as HTMLElement;
  const resultEl = body.querySelector('#aitex-result') as HTMLElement;
  let ctrl: AbortController | null = null;
  cancelBtn.onclick = () => ctrl?.abort();
  goBtn.onclick = async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      toast('Describe the texture first', 'warn');
      return;
    }
    ctrl = new AbortController();
    goBtn.disabled = true;
    cancelBtn.hidden = false;
    progressEl.hidden = false;
    resultEl.innerHTML = '';
    stageEl.textContent = 'generating texture';
    barEl.style.width = '30%';
    try {
      const size = Number(sizeEl.value);
      const { result, fallback } = await generateImageSmart(texturePrompt(prompt, seamlessEl.checked), {
        width: size, height: size, signal: ctrl.signal,
      });
      stageEl.textContent = 'applying to material';
      barEl.style.width = '80%';
      let matId = matEl.value;
      if (!matId) {
        const mat = session.addMaterial();
        session.updateMaterial(mat.id, { name: prompt.slice(0, 32) });
        matId = mat.id;
      }
      const file = new File([result.blob], `${prompt.slice(0, 40)}.png`, { type: result.mime });
      await session.uploadTexture(matId, file);
      barEl.style.width = '100%';
      const url = URL.createObjectURL(result.blob);
      resultEl.innerHTML = `
        <div class="banner banner-info">✅ Texture applied to <b>${escapeHtml(session.doc.materials.find((m) => m.id === matId)?.name ?? 'material')}</b> (via ${escapeHtml(result.provider)}, seed ${result.seed}).${fallback ? `<br />Fallback: ${escapeHtml(fallback.to)} — ${escapeHtml(fallback.reason)}` : ''}</div>
        <img src="${url}" class="ai-preview" alt="Generated texture preview" />`;
      toast('Texture applied', 'success');
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') resultEl.innerHTML = '<p class="muted">Cancelled.</p>';
      else resultEl.innerHTML = `<p class="error">Failed: ${escapeHtml((e as Error).message)}</p>`;
    } finally {
      goBtn.disabled = false;
      cancelBtn.hidden = true;
      ctrl = null;
    }
  };
}

// =====================================================================
// Tab: Ask
// =====================================================================

function renderAskTab(session: EditorSession, body: HTMLElement): void {
  body.innerHTML = `
    <div class="banner banner-info">Ask about <b>${escapeHtml(session.doc.name)}</b> — the free assistant reads the live scene summary (objects, materials, clips) before answering.</div>
    <div id="aiask-log" class="ai-chat"></div>
    <div class="row-between">
      <input id="aiask-q" class="input" placeholder="e.g. How many lights are in my scene?" style="flex:1" />
      <button class="btn btn-primary" id="aiask-go">Ask</button>
    </div>`;
  const log = body.querySelector('#aiask-log') as HTMLElement;
  const input = body.querySelector('#aiask-q') as HTMLInputElement;
  const go = body.querySelector('#aiask-go') as HTMLButtonElement;
  const push = (who: string, text: string): void => {
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${who}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  };
  const ask = async (): Promise<void> => {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    go.disabled = true;
    push('user', q);
    push('assistant', '…');
    try {
      const chat = getChatProvider();
      const context = toAiContext(session.doc).slice(0, 6000);
      const answer = await chat.chat([
        { role: 'system', content: `You are the Web 3D Studio assistant. Answer briefly using this live project summary. Suggest concrete Agent API calls when relevant.\n\n${context}` },
        { role: 'user', content: q },
      ]);
      (log.lastChild as HTMLElement).textContent = answer;
      log.scrollTop = log.scrollHeight;
    } catch (e) {
      (log.lastChild as HTMLElement).textContent = `Error: ${(e as Error).message}`;
    } finally {
      go.disabled = false;
    }
  };
  go.onclick = () => void ask();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void ask();
  };
}

// =====================================================================
// Tab: Agent API
// =====================================================================

function renderAgentTab(body: HTMLElement): void {
  const s = aiSettings.get();
  const agent = getAgent();
  body.innerHTML = `
    <div class="banner banner-info">Let an AI agent drive this app: list projects, add/edit objects, materials, textures, 3D models and keyframes — from DevTools, an extension, another tab, or real HTTP via the relay server. <b>Keys never leave this device.</b></div>
    <label class="small"><input type="checkbox" id="ag-enabled" ${s.agent.enabled ? 'checked' : ''} /> <b>Enable Agent API</b></label>
    <div class="panel-sub">Connection status</div>
    <div id="ag-status" class="small"></div>
    <div class="panel-sub">API tokens</div>
    <div class="row-between">
      <input id="ag-label" class="input input-sm" placeholder="Token label (e.g. Claude)" style="flex:1" />
      <select id="ag-expiry" class="input input-sm" title="Expiry">
        <option value="30">30 days</option>
        <option value="7">7 days</option>
        <option value="1">1 day</option>
        <option value="">Never</option>
      </select>
    </div>
    <div class="row-between" style="margin-top:6px">
      <span class="small">
        <label><input type="checkbox" id="ag-sc-read" checked /> read</label>
        <label><input type="checkbox" id="ag-sc-write" checked /> write</label>
        <label><input type="checkbox" id="ag-sc-gen" checked /> generate</label>
      </span>
      <button class="btn btn-sm btn-primary" id="ag-new">＋ New token</button>
    </div>
    <div id="ag-new-secret"></div>
    <div id="ag-tokens" class="member-list" style="margin-top:8px"></div>
    <div class="panel-sub">HTTP relay (for external agents)</div>
    <div class="row-between">
      <input id="ag-relay-url" class="input input-sm" placeholder="http://127.0.0.1:8787" style="flex:1" value="${escapeHtml(s.agent.relayUrl)}" />
    </div>
    <div class="row-between" style="margin-top:6px">
      <input id="ag-relay-token" class="input input-sm" type="password" placeholder="relay token from terminal" style="flex:1" value="${escapeHtml(s.agent.relayToken)}" />
    </div>
    <div class="row-between" style="margin-top:6px">
      <span class="small muted">Run <code class="code">npm run agent-relay</code>, paste URL + token.</span>
      <span>
        <button class="btn btn-sm" id="ag-relay-test">Test</button>
        <button class="btn btn-sm btn-primary" id="ag-relay-toggle">Connect</button>
      </span>
    </div>
    <div id="ag-relay-status" class="small" style="margin-top:4px"></div>
    <div class="panel-sub">postMessage origins (one per line)</div>
    <textarea id="ag-origins" class="input" rows="2" placeholder="https://your-agent-app.com">${escapeHtml(s.agent.allowedOrigins.join('\n'))}</textarea>
    <div class="panel-sub">Client code</div>
    <div class="row-between">
      <select id="ag-snippet" class="input input-sm">
        <option value="js">In-page JavaScript</option>
        <option value="pm">postMessage (iframe/popup)</option>
        <option value="ch">BroadcastChannel (other tab)</option>
        <option value="curl">cURL via relay</option>
      </select>
      <button class="btn btn-sm" id="ag-copy">Copy</button>
    </div>
    <pre id="ag-code" class="code ai-code"></pre>
    <div class="panel-sub">Recent activity <button class="btn btn-sm" id="ag-refresh">↻</button></div>
    <div id="ag-activity" class="ai-activity"></div>`;

  const enabledEl = body.querySelector('#ag-enabled') as HTMLInputElement;
  enabledEl.onchange = () => {
    updateAiSettings((prev) => ({ ...prev, agent: { ...prev.agent, enabled: enabledEl.checked } }));
    toast(enabledEl.checked ? 'Agent API enabled' : 'Agent API disabled', enabledEl.checked ? 'success' : 'warn');
    refreshStatus();
  };

  const refreshStatus = (): void => {
    const b = bridgeStatus.get();
    const r = relayStatus.get();
    const st = body.querySelector('#ag-status') as HTMLElement;
    if (!document.contains(st)) return;
    const dot = (on: boolean): string => (on ? '🟢' : '⚪');
    st.innerHTML =
      `${dot(aiSettings.get().agent.enabled && b.page)} Page JS &nbsp; ` +
      `${dot(aiSettings.get().agent.enabled && b.postmessage)} postMessage &nbsp; ` +
      `${dot(aiSettings.get().agent.enabled && b.channel)} Channel &nbsp; ` +
      `${dot(r.running && r.connected)} Relay${r.error ? ` <span class="error">(${escapeHtml(r.error)})</span>` : ''}`;
    const toggle = body.querySelector('#ag-relay-toggle') as HTMLButtonElement;
    if (toggle) toggle.textContent = r.running ? 'Disconnect' : 'Connect';
    const rs = body.querySelector('#ag-relay-status') as HTMLElement;
    if (rs) {
      rs.textContent = r.running
        ? (r.connected ? `Relay connected${r.lastSeen ? ` · last poll ${new Date(r.lastSeen).toLocaleTimeString()}` : ''}` : 'Relay connecting…')
        : 'Relay disconnected.';
    }
  };
  const unsub1 = bridgeStatus.subscribe(() => refreshStatus());
  const unsub2 = relayStatus.subscribe(() => refreshStatus());
  const poll = setInterval(() => {
    if (!document.contains(body)) {
      clearInterval(poll);
      unsub1();
      unsub2();
    }
  }, 3000);
  refreshStatus();

  const refreshTokens = (): void => {
    const list = body.querySelector('#ag-tokens') as HTMLElement;
    const tokens = aiSettings.get().agent.tokens;
    list.innerHTML = tokens.length
      ? tokens.map((t) => `
        <div class="member-row">
          <span class="member-name">🔑 <b>${escapeHtml(t.label)}</b><br />
            <span class="muted small">${t.scopes.join(', ')} · ${t.calls} calls${t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ''}</span>
          </span>
          <button class="btn btn-sm" data-revoke="${t.id}">Revoke</button>
        </div>`).join('')
      : '<p class="muted small">No tokens yet — create one above.</p>';
    list.querySelectorAll('[data-revoke]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        revokeAgentToken((b as HTMLElement).dataset.revoke as string);
        toast('Token revoked', 'success');
        refreshTokens();
      };
    });
  };
  refreshTokens();

  (body.querySelector('#ag-new') as HTMLButtonElement).onclick = async () => {
    const label = (body.querySelector('#ag-label') as HTMLInputElement).value.trim() || 'Agent';
    const scopes: AgentScope[] = [];
    if ((body.querySelector('#ag-sc-read') as HTMLInputElement).checked) scopes.push('read');
    if ((body.querySelector('#ag-sc-write') as HTMLInputElement).checked) scopes.push('write');
    if ((body.querySelector('#ag-sc-gen') as HTMLInputElement).checked) scopes.push('generate');
    if (!scopes.length) {
      toast('Pick at least one scope', 'warn');
      return;
    }
    const expiryRaw = (body.querySelector('#ag-expiry') as HTMLSelectElement).value;
    const { secret } = await createAgentToken(label, scopes, expiryRaw ? Number(expiryRaw) : null);
    const box = body.querySelector('#ag-new-secret') as HTMLElement;
    box.innerHTML = `
      <div class="banner banner-warn">Copy now — shown <b>once</b>:<br />
        <code class="code" id="ag-secret">${escapeHtml(secret)}</code>
        <button class="btn btn-sm" id="ag-secret-copy">Copy</button>
      </div>`;
    (box.querySelector('#ag-secret-copy') as HTMLButtonElement).onclick = async () => {
      await navigator.clipboard.writeText(secret).catch(() => undefined);
      toast('Token copied', 'success');
    };
    refreshTokens();
  };

  const relayUrlEl = body.querySelector('#ag-relay-url') as HTMLInputElement;
  const relayTokenEl = body.querySelector('#ag-relay-token') as HTMLInputElement;
  const saveRelay = (): void => {
    updateAiSettings((prev) => ({
      ...prev,
      agent: { ...prev.agent, relayUrl: relayUrlEl.value.trim(), relayToken: relayTokenEl.value.trim() },
    }));
  };
  relayUrlEl.onchange = saveRelay;
  relayTokenEl.onchange = saveRelay;
  (body.querySelector('#ag-relay-test') as HTMLButtonElement).onclick = async () => {
    saveRelay();
    await flushAiSettings();
    try {
      const h = await checkRelayHealth();
      toast(`Relay OK (v${h.version}, ${h.pendingCalls} pending)`, 'success');
    } catch (e) {
      toast(`Relay: ${(e as Error).message}`, 'error');
    }
  };
  (body.querySelector('#ag-relay-toggle') as HTMLButtonElement).onclick = async () => {
    const relay = getRelay();
    if (relay.isRunning) {
      relay.stop();
      refreshStatus();
      return;
    }
    saveRelay();
    await flushAiSettings();
    try {
      await relay.start();
      toast('Relay connected', 'success');
    } catch (e) {
      toast(`Relay: ${(e as Error).message}`, 'error');
    }
    refreshStatus();
  };

  (body.querySelector('#ag-origins') as HTMLTextAreaElement).onchange = (e) => {
    const origins = (e.target as HTMLTextAreaElement).value
      .split('\n')
      .map((o) => o.trim())
      .filter((o) => o.startsWith('http'));
    updateAiSettings((prev) => ({ ...prev, agent: { ...prev.agent, allowedOrigins: origins } }));
    toast('Allowed origins saved', 'success');
  };

  const snippetEl = body.querySelector('#ag-snippet') as HTMLSelectElement;
  const codeEl = body.querySelector('#ag-code') as HTMLElement;
  const refreshSnippet = (): void => {
    const token = 'w3d_PASTE_TOKEN_HERE';
    const origin = window.location.origin;
    const s = aiSettings.get();
    codeEl.textContent =
      snippetEl.value === 'pm' ? snippetPostMessage(token, origin)
      : snippetEl.value === 'ch' ? snippetChannel(token)
      : snippetEl.value === 'curl' ? snippetCurlRelay(s.agent.relayUrl, s.agent.relayToken || 'RELAY_TOKEN')
      : snippetJs(token);
  };
  snippetEl.onchange = refreshSnippet;
  refreshSnippet();
  (body.querySelector('#ag-copy') as HTMLButtonElement).onclick = async () => {
    await navigator.clipboard.writeText(codeEl.textContent ?? '').catch(() => undefined);
    toast('Snippet copied', 'success');
  };

  const refreshActivity = (): void => {
    const box = body.querySelector('#ag-activity') as HTMLElement;
    const entries = aiSettings.get().activity.slice(-20).reverse();
    box.innerHTML = entries.length
      ? entries.map((a) => `
        <div class="ai-log-row">
          <span>${a.ok ? '✅' : '❌'}</span>
          <code class="code">${escapeHtml(a.method)}</code>
          <span class="muted small">${escapeHtml(a.actor)} · ${a.ms}ms${a.error ? ` · ${escapeHtml(a.error.slice(0, 80))}` : ''}</span>
        </div>`).join('')
      : '<p class="muted small">No agent calls yet.</p>';
  };
  (body.querySelector('#ag-refresh') as HTMLButtonElement).onclick = refreshActivity;
  refreshActivity();
  void agent; // capabilities are listed in docs/AGENT_API.md
}

// =====================================================================
// Tab: custom API setup
// =====================================================================

function renderSettingsTab(body: HTMLElement): void {
  const s = aiSettings.get();
  const customBlock = (
    prefix: string,
    title: string,
    freeLabel: string,
    value: 'pollinations' | 'custom' | 'triposr',
    freeValue: string,
    ep: { baseUrl: string; apiKey: string; model: string },
    basePlaceholder: string,
    modelPlaceholder: string,
    hint: string,
  ): string => `
    <div class="panel-sub">${title}</div>
    <div class="radio-row">
      <label><input type="radio" name="${prefix}-prov" value="${freeValue}" ${value === freeValue ? 'checked' : ''} /> ${freeLabel}</label>
      <label><input type="radio" name="${prefix}-prov" value="custom" ${value === 'custom' ? 'checked' : ''} /> Custom API</label>
    </div>
    <div id="${prefix}-custom" ${value === 'custom' ? '' : 'hidden'}>
      <label class="field">Base URL <input id="${prefix}-url" class="input" placeholder="${basePlaceholder}" value="${escapeHtml(ep.baseUrl)}" /></label>
      <div class="row-between">
        <label class="field" style="flex:1">API key <input id="${prefix}-key" class="input" type="password" placeholder="sk-…" value="${escapeHtml(ep.apiKey)}" /></label>
        <label class="field">Model <input id="${prefix}-model" class="input" placeholder="${modelPlaceholder}" value="${escapeHtml(ep.model)}" /></label>
      </div>
      <div class="row-between">
        <span class="small muted">${hint}</span>
        <button class="btn btn-sm" id="${prefix}-test">Test</button>
      </div>
      <p class="small" id="${prefix}-test-out"></p>
    </div>`;

  body.innerHTML = `
    <div class="banner banner-info">Defaults are <b>100% free, no keys</b>. Point any slot at your own endpoint (OpenAI-compatible, Ollama, LM Studio, …) to override it. Keys stay in this browser's IndexedDB.</div>
    ${customBlock('ai-assistant', '💬 Assistant (Ask + ai.ask)', 'Pollinations free', s.assistantProvider, 'pollinations', s.assistantCustom, 'https://api.openai.com/v1', 'gpt-4o-mini', 'POST {base}/chat/completions')}
    ${customBlock('ai-image', '🎨 Textures & images', 'Pollinations Flux free', s.imageProvider, 'pollinations', s.imageCustom, 'https://api.openai.com/v1', 'dall-e-3', 'POST {base}/images/generations')}
    <div class="panel-sub">🧊 3D models</div>
    <div class="radio-row">
      <label><input type="radio" name="ai-mesh-prov" value="triposr" ${s.meshProvider === 'triposr' ? 'checked' : ''} /> TripoSR free</label>
      <label><input type="radio" name="ai-mesh-prov" value="custom" ${s.meshProvider === 'custom' ? 'checked' : ''} /> Custom API</label>
    </div>
    <div id="ai-mesh-custom" ${s.meshProvider === 'custom' ? '' : 'hidden'}>
      <label class="field">3D endpoint URL (full path) <input id="ai-mesh-url" class="input" placeholder="https://your-host/v1/text-to-3d" value="${escapeHtml(s.meshCustom.baseUrl)}" /></label>
      <div class="row-between">
        <label class="field" style="flex:1">API key <input id="ai-mesh-key" class="input" type="password" placeholder="…" value="${escapeHtml(s.meshCustom.apiKey)}" /></label>
        <label class="field">Model <input id="ai-mesh-model" class="input" placeholder="text-to-3d" value="${escapeHtml(s.meshCustom.model)}" /></label>
      </div>
      <div class="row-between">
        <span class="small muted">POST {prompt, format:"glb"} → {glb_base64|glb_url} or raw GLB.</span>
        <button class="btn btn-sm" id="ai-mesh-test">Test</button>
      </div>
      <p class="small" id="ai-mesh-test-out"></p>
    </div>
    <div class="panel-sub">TripoSR options</div>
    <label class="field">Space URL <input id="ai-space" class="input" value="${escapeHtml(s.meshCustom.spaceUrl)}" /></label>
    <label class="field">Hugging Face token (optional, shorter queues — free at huggingface.co)
      <input id="ai-hf" class="input" type="password" placeholder="hf_…" value="${escapeHtml(s.hfToken)}" />
    </label>
    <div class="row-between" style="margin-top:12px">
      <button class="btn btn-ghost" id="ai-reset">Reset to free defaults</button>
      <button class="btn btn-primary" id="ai-save">Save</button>
    </div>`;

  const toggleCustom = (prefix: string): void => {
    const checked = (body.querySelector(`input[name="${prefix}-prov"]:checked`) as HTMLInputElement)?.value;
    (body.querySelector(`#${prefix}-custom`) as HTMLElement).hidden = checked !== 'custom';
  };
  for (const prefix of ['ai-assistant', 'ai-image', 'ai-mesh']) {
    body.querySelectorAll(`input[name="${prefix}-prov"]`).forEach((r) => {
      (r as HTMLInputElement).onchange = () => toggleCustom(prefix);
    });
  }

  const read = (id: string): string => (body.querySelector(`#${id}`) as HTMLInputElement).value.trim();
  const save = async (): Promise<void> => {
    const picked = (name: string, free: string): 'pollinations' | 'custom' | 'triposr' => {
      const v = (body.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement)?.value;
      return (v === 'custom' ? 'custom' : free) as 'pollinations' | 'custom' | 'triposr';
    };
    updateAiSettings((prev) => ({
      ...prev,
      assistantProvider: picked('ai-assistant-prov', 'pollinations') as 'pollinations' | 'custom',
      assistantCustom: { baseUrl: read('ai-assistant-url'), apiKey: read('ai-assistant-key'), model: read('ai-assistant-model') || 'default' },
      imageProvider: picked('ai-image-prov', 'pollinations') as 'pollinations' | 'custom',
      imageCustom: { baseUrl: read('ai-image-url'), apiKey: read('ai-image-key'), model: read('ai-image-model') || 'default' },
      meshProvider: picked('ai-mesh-prov', 'triposr') as 'triposr' | 'custom',
      meshCustom: {
        baseUrl: read('ai-mesh-url'),
        apiKey: read('ai-mesh-key'),
        model: read('ai-mesh-model') || 'text-to-3d',
        spaceUrl: read('ai-space') || prev.meshCustom.spaceUrl,
      },
      hfToken: read('ai-hf'),
    }));
    await flushAiSettings();
    toast('AI settings saved', 'success');
  };
  (body.querySelector('#ai-save') as HTMLButtonElement).onclick = () => void save();
  (body.querySelector('#ai-reset') as HTMLButtonElement).onclick = async () => {
    const { defaultSettings } = await import('../ai/settings.js');
    const d = defaultSettings();
    updateAiSettings((prev) => ({
      ...prev,
      assistantProvider: d.assistantProvider,
      assistantCustom: d.assistantCustom,
      imageProvider: d.imageProvider,
      imageCustom: d.imageCustom,
      meshProvider: d.meshProvider,
      meshCustom: d.meshCustom,
      hfToken: d.hfToken,
    }));
    await flushAiSettings();
    renderSettingsTab(body);
    toast('Reset to free defaults', 'success');
  };

  const testBtn = async (prefix: string, run: () => Promise<string>): Promise<void> => {
    const out = body.querySelector(`#${prefix}-test-out`) as HTMLElement;
    out.textContent = 'Testing…';
    try {
      await save();
      out.textContent = `✅ ${await run()}`;
    } catch (e) {
      out.textContent = `❌ ${(e as Error).message}`;
    }
  };
  (body.querySelector('#ai-assistant-test') as HTMLButtonElement).onclick = () =>
    void testBtn('ai-assistant', () => (getChatProvider().test?.() ?? Promise.resolve('No test for this provider.')));
  (body.querySelector('#ai-image-test') as HTMLButtonElement).onclick = () =>
    void testBtn('ai-image', () => (getImageProvider().test?.() ?? Promise.resolve('No test for this provider.')));
  (body.querySelector('#ai-mesh-test') as HTMLButtonElement).onclick = () =>
    void testBtn('ai-mesh', () => (getMeshProvider().test?.() ?? Promise.resolve('No test for this provider.')));
}
