# Agent API + AI Setup — Web 3D Studio

Let an AI agent connect to Web 3D Studio and **make changes in projects**:
list projects, add/edit/delete objects, materials, textures, AI-generated 3D
models, animation keyframes, history and saves.

The app is a static page (GitHub Pages, no server), so the API runs
**in the browser** and offers four ways to connect. Everything works
**local-first**: with no editor open, calls apply to the on-device copy
(headless mode); with a project open, they drive the live editor with
undo/redo, viewport updates and realtime sync.

- **Free 3D generator:** Stable Fast 3D (Stability AI, game-ready meshes with
  UVs + textures) via the public Hugging Face Space — text → image → GLB →
  scene. No signup, no key. TripoSR is the automatic fallback if SF3D is busy.
- **Free texture generator:** Pollinations Flux — text → texture → material map.
  No signup, no key (~1 image / 15s on the anonymous tier).
- **Free assistant:** Pollinations text (OpenAI-compatible) for the Ask tab and
  `ai.ask`. Needs a free key from enter.pollinations.ai/keys (paste in
  ✨ AI → Setup) — Pollinations ended anonymous text access; factual scene
  questions still answer offline without one.
- **Custom API:** point any slot (assistant / image / 3D) at your own
  OpenAI-compatible endpoint + key in ✨ AI → Setup. Keys stay in this
  browser's IndexedDB and are only ever sent to the endpoint you configured.
- **Offline fallbacks:** if AI is unreachable, textures degrade to a seeded
  canvas pattern and 3D degrades to primitive mockups (chair, table, robot…),
  applied through the normal object API — undoable, saved and synced.

## 1. Quick start (2 minutes)

1. Open any project in the editor.
2. Click **✨ AI → 🤖 Agent API → enable the Agent API**.
3. **＋ New token** (pick scopes) and copy the secret — it is shown **once**.
4. Open DevTools on the page and run:

```js
const agent = window.Web3DStudio.agent;
await agent.call('project.list', {}, 'w3d_PASTE_TOKEN_HERE');
await agent.call('object.add',
  { kind: 'cube', name: 'Agent Cube', color: '#ff4444' },
  'w3d_PASTE_TOKEN_HERE');
```

That is the whole API. Everything below is transports, auth details and the
method reference.

## 2. Connection methods

All transports call the same methods with the same auth. Enable the API and
create a token first (tokens are per-browser-install).

### A. In-page JavaScript (console, extensions, userscripts)

```js
// No token needed for these two:
await window.Web3DStudio.agent.capabilities();
await window.Web3DStudio.agent.call('agent.ping', {});

// Everything else needs the secret as the 3rd argument:
await window.Web3DStudio.agent.call('project.context', {}, TOKEN);
await window.Web3DStudio.agent.call('object.add', { kind: 'sphere' }, TOKEN);
```

(`window.__WEB3D_AGENT__` is a legacy alias of the same object.)

### B. postMessage (iframes, popups, embedded agents)

Send to the app window; listen for the matching `id`:

```js
const target = window.opener ?? window.parent; // the app window
const id = crypto.randomUUID();
window.addEventListener('message', (e) => {
  if (e.data?.type === 'web3d-agent-response' && e.data.id === id) {
    console.log(e.data.ok ? e.data.result : e.data.error);
  }
});
target.postMessage({
  type: 'web3d-agent-request',
  id, method: 'project.list', params: {}, token: TOKEN,
}, 'https://ayushghbk-afk.github.io');
```

Same-origin and `http://localhost:*` callers are always allowed; add other
origins in ✨ AI → Agent API → postMessage origins.

### C. BroadcastChannel (other tabs, extension pages)

```js
const ch = new BroadcastChannel('web3dstudio-agent-v1');
const id = crypto.randomUUID();
ch.onmessage = (e) => { if (e.data?.id === id) console.log(e.data); };
ch.postMessage({ type: 'web3d-agent-request', id,
  method: 'model.generate', params: { prompt: 'toy rocket' }, token: TOKEN });
```

### D. HTTP relay (external processes, real REST)

For agents running **outside** the browser (Claude Code, scripts, servers):

```bash
# Terminal 1 — zero-dependency relay (Node 20+):
npm run agent-relay
# → prints a token, e.g. Relay token: 9f2c…

# In the app: ✨ AI → Agent API → Relay URL http://127.0.0.1:8787
# + paste the token → Connect. (App polls the relay; agents call the relay.)
```

```bash
# Terminal 2 — any HTTP client:
curl -s http://127.0.0.1:8787/v1/call \
  -H 'Authorization: Bearer RELAY_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"method":"project.list","params":{}}'

curl -s http://127.0.0.1:8787/v1/call \
  -H 'Authorization: Bearer RELAY_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"method":"texture.generate","params":{"prompt":"lava rock"},"timeoutMs":120000}'
```

Relay endpoints: `GET /v1/health`, `POST /v1/call`, plus the internal
`GET /v1/queue` / `POST /v1/result` used by the browser loop. Options:
`--port`, `--host` (default `127.0.0.1`), `--token`, `--cors`, or the
`AGENT_RELAY_*` env vars. See `examples/agent-node.mjs` and
`examples/agent-python.py` for ready-made clients.

> The relay binds to localhost. Only expose it publicly (or via a tunnel) if
> you accept that the token is the only protection — anyone with it can edit
> projects through your open browser.

## 3. Auth, scopes, limits

- **Tokens:** `w3d_<id>_<secret>`, created in ✨ AI → Agent API. Only a
  SHA-256 hash is stored; the secret is shown once — lose it, revoke and
  re-create. Optional expiry (1/7/30 days or never).
- **Scopes:** `read` (list/get/context/scene/activity), `write` (all edits,
  history, saves), `generate` (`ai.ask`, `image/texture/model.generate`).
  `agent.ping` and `agent.capabilities` need no token.
- **Rate limit:** 120 calls/min per token by default (configurable 1–600).
- **Audit log:** every call is logged (actor, method, project, ok/ms, error) —
  view in ✨ AI → Agent API → Recent activity or via `agent.activity`.
- **Modes:** responses include `mode: "live" | "headless"`. Live = an editor
  has the project open (viewport + undo + cloud sync). Headless = the
  on-device copy was edited directly (loads fully when opened next; cloud
  sync runs on open). `history.undo/redo` need a live editor.

Error shape: `{ ok: false, error: { code, message } }` over the relay, or a
thrown `AgentError` with `.code` in-page. Codes: `AUTH_DISABLED`,
`AUTH_REQUIRED`, `AUTH_INVALID`, `FORBIDDEN_SCOPE`, `RATE_LIMITED`,
`NOT_FOUND`, `VALIDATION`, `NO_SESSION`, `PROVIDER`, `TIMEOUT`, `INTERNAL`.

## 4. Method reference

Omit `projectId` to target the open project (live), or pass one from
`project.list` to target any on-device project (live if open, else headless).

| Method | Scope | Params |
|---|---|---|
| `agent.ping` | — | → `{ok, version, time, sessionOpen}` |
| `agent.capabilities` | — | → methods, providers, open project |
| `agent.activity` | read | `{limit?}` |
| `project.list` | read | → summaries (id, name, counts) |
| `project.get` | read | `{id}` → full document |
| `project.create` | write | `{name, mode?}` |
| `project.update` | write | `{id, name}` |
| `project.delete` | write | `{id}` (must be closed in the editor) |
| `project.context` | read | `{projectId?}` → AI_PROJECT_CONTEXT.md text — **agents start here** |
| `project.scene` | read | `{projectId?}` → project.json + scene.json graph |
| `object.list` | read | `{projectId?}` |
| `object.add` | write | `{projectId?, kind, name?, position?, rotationDeg?, scale?, color?, lightKind?}` — kind: cube/sphere/cylinder/cone/plane/torus/group/light |
| `object.update` | write | `{projectId?, id, name?, position?, rotationDeg?, scale?, visible?, locked?, materialId?, parentId?, color?, light?}` |
| `object.delete` | write | `{projectId?, id}` (+ children) |
| `object.duplicate` | write | `{projectId?, id}` |
| `material.list` | read | `{projectId?}` |
| `material.add` | write | `{projectId?, name?, baseColor?, metalness?, roughness?, emissive?, emissiveIntensity?, opacity?, transparent?, flatShading?, side?}` |
| `material.update` | write | `{projectId?, id, …same fields}` |
| `asset.list` | read | `{projectId?}` |
| `asset.import` | write | `{projectId?, name, dataBase64}` (GLB ≤ ~30MB) |
| `clip.list` | read | `{projectId?}` |
| `clip.add` | write | `{projectId?, name?}` |
| `keyframe.add` | write | `{projectId?, objectId, property?, frame?, value?, clipId?}` |
| `keyframe.delete` | write | `{projectId?, objectId, property?, frame}` |
| `scene.analyze` | read | `{projectId?}` → per-group model identification (chair, car, …) + part roles — **agents start here for styling** |
| `scene.autopaint` | write | `{projectId?, groupIds?}` → coherent colors per part role; live = one Undo step |
| `scene.autotexture` | generate | `{projectId?, groupIds?, size?, maxTextures?}` → autopaint + one AI texture per part role (slow, free tier ≈ 1 img/15s) |
| `scene.tidy` | write | `{projectId?, spacing?}` → arrange top-level models in a grid |
| `history.undo` / `history.redo` | write | live editor only |
| `save.now` | write | `{projectId?}` → local + cloud (when signed in) |
| `ai.ask` | generate | `{projectId?, question}` → grounded answer (`offline:true` + local scene answer when the cloud AI is unreachable) |
| `image.generate` | generate | `{prompt, width?, height?, seed?, strict?}` → `{dataUrl, …}` |
| `texture.generate` | generate | `{projectId?, prompt, materialId?, size?, seamless?, strict?}` → applied to material (new one if omitted) |
| `model.generate` | generate | `{projectId?, prompt, name?, quality?, model?, strict?}` → GLB imported; `quality`: fast/balanced/high; `model`: `sf3d` (best, default) or `triposr` (faster) |

Generation responses include `provider` and, when a fallback fired,
`fallback: {from, to, reason}`. Pass `strict: true` to disable fallbacks and
surface the raw provider error instead.

### Recommended agent loop

1. `project.list` → pick a project (or `project.create`).
2. `project.context` (+ `project.scene` for the full graph).
3. For styling an existing scene: `scene.analyze` → `scene.autopaint` (or
   `scene.autotexture` for AI surfaces) → `scene.tidy` to lay models out.
4. Make changes (`object.*`, `material.*`, `texture/model.generate`, …).
5. `save.now`.
5. On any error, read `error.code`/`message` — validation errors name the
   exact parameter.

## 5. Custom API setup (✨ AI → Setup)

Each slot is independent — mix free defaults with your own endpoints:

- **Assistant** (`Ask` tab + `ai.ask`): OpenAI-compatible
  `POST {baseUrl}/chat/completions`. Works with OpenAI, Azure OpenAI,
  OpenRouter, Together, Ollama (`http://localhost:11434/v1`), LM Studio
  (`http://localhost:1234/v1`), vLLM, … Before going custom, try the
  **Pollinations key** field (free at enter.pollinations.ai/keys) — it keeps
  the free assistant but routes it through the current keyed API, which
  survives anonymous-tier blocks and throttling.
- **Textures & images**: OpenAI-compatible `POST {baseUrl}/images/generations`
  (`b64_json` preferred, `url` accepted).
- **3D models**: `POST {endpointUrl}` with `{model, prompt, format:"glb"}`;
  respond with raw GLB bytes or JSON containing `glb_base64`, `glb_url`,
  `model_url`, `url` (or `{data:[{b64_json|url}]}`).

Every custom block has a **Test** button. Defaults can also be pre-seeded per
deployment with `VITE_AI_*` vars (see `.env.example`) — the UI can still
override them per browser.

3D tuning: override either Space URL (e.g. your own GPU Space running the SF3D
or TripoSR demo) and optionally add a Hugging Face token (free at
huggingface.co) for shorter queue waits on both. Generation tries your
selected model first, then the other free model, then the offline mockup —
unless `strict` is set.

## 6. Security notes

- Agent tokens and custom API keys live in the browser's IndexedDB on the
  user's device only; hashes (never secrets) are what's stored for tokens.
- `postMessage` enforces an origin allowlist (same-origin + localhost always
  allowed). BroadcastChannel is same-browser only.
- The relay token is a single shared secret — treat it like a password, pin it
  via `AGENT_RELAY_TOKEN`, and keep the relay on localhost unless you know
  what you're doing.
- Imported/generated content is data, never executed: GLBs go through the
  three.js loader, images through `createImageBitmap`.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `AUTH_DISABLED` | Enable the API in ✨ AI → Agent API. |
| `AUTH_INVALID` | Token typo / revoked / expired — create a new one. |
| `NO_SESSION` | Pass `projectId` (from `project.list`) — nothing is open. |
| Relay `TIMEOUT` | App tab open? Relay connected (green)? Long generations need bigger `timeoutMs`. |
| Free 3D stuck on “waking…” | The HF Space sleeps when idle; first boot takes 1–3 min. Retry, or add a free `hf_…` token / use offline/custom 3D. |
| Free texture 429 / slow | Anonymous Pollinations ≈ 1 req / 15s — wait and retry. |
| Ask / `ai.ask` “ended anonymous access (402)” | Pollinations now requires a key for text: get a free one at enter.pollinations.ai/keys → ✨ AI → Setup → Pollinations key → Save → Test. A custom assistant endpoint (OpenAI, Ollama, …) also works. Counts/lists/summaries still answer offline. |
| Ask / `ai.ask` “Couldn't reach…” (no 402) | The browser can't reach `*.pollinations.ai`: allow it in your ad-blocker/VPN/firewall, check DNS, or retry later. The free key above also routes around most anonymous-tier blocks. |
| Custom API CORS errors | The endpoint must allow browser calls (`Access-Control-Allow-Origin`). Local Ollama/LM Studio work; some clouds need a proxy. |
