# Web 3D Studio — Technical Architecture

> Lightweight 3D creation for the web. Mobile-first, local-first, cloud-synced.

## 0. Repo state at start

Empty repository (`README.md` only). No existing architecture to preserve, so this
document defines the greenfield architecture per the master spec §60.

## 1. Stack (chosen = simplest that satisfies requirements)

| Concern | Choice | Why |
|---|---|---|
| Language/build | TypeScript + Vite | Native ESM, fast HMR, tiny output |
| 3D engine | Three.js (WebGL2) | Mature, tree-shakeable, GLB pipeline, TransformControls; Babylon would add weight for no V1 benefit |
| WebGPU | Detection + badge now; WebGPURenderer path later | Never mandatory (§3); dynamic import when a subsystem needs compute |
| UI | Vanilla TS + hand-rolled stores + one CSS file | No framework runtime (~0 kB); full control over mobile layout |
| Cloud | Supabase (Auth, Postgres+RLS, Storage, Realtime) | Single backend for §22–§35 |
| Local-first | IndexedDB (`projects`, `blobs`, `queue`, `settings`) | Offline editing + pending-change queue (§33) |
| State | `Store<T>` pub/sub slices | Separate editor/ui/network/project/collab/selection/animation (§44) |
| Workers/Wasm | Reserved (`src/workers/`) | Only when measurable benefit (§11–12); GLB parse stays main-thread until profiling says otherwise |
| PWA | Hand-rolled `sw.js` + manifest | App-shell caching only, no asset bloat (§58) |

### Non-goals for V1
Node material editor, texture painting, IK/weight painting, path tracing, WebRTC
 meshes — architecture reserves seams (see §8) but does not implement them.

## 2. Runtime architecture

```
 index.html ──► main.ts ──► router (hash: #/ dashboard, #/p/:id editor, #/login)
                                │                     │
                          dashboard.ts            editor.ts
                                                        ├─ viewport.ts (three scene)
                                                        ├─ outliner / inspector / toolbar / timeline
                                                        ├─ history.ts (undo/redo)
                                                        ├─ animation.ts (playback/sampling)
                                                        └─ sync.ts (autosave + realtime)
```

### Data flow (local-first, §33–34)

```
 user gesture
     │  (continuous, 60fps)
     ▼
 runtime three objects + ProjectDoc (in-memory, authoritative for UI)
     │  (debounced 400ms)
     ▼
 IndexedDB ──► pending queue ──► (online? Supabase upsert+Broadcast : wait)
```

- Viewport renders from three objects; `ProjectDoc` is the serializable mirror.
- Every mutation goes through `EditorSession.mutate()` which: applies to three,
  updates doc, pushes history entry, marks dirty, schedules local save + cloud save.
- Remote changes apply to three + doc, never to history.

## 3. Module map (`src/`)

```
lib/        utils, supabase client, auth, indexeddb, database.types
state/      store.ts, models.ts (ProjectDoc, SceneObjectData, clips…)
engine/
  renderer.ts   WebGL2 renderer, WebGPU detection, PBR/env/shadows, resize, dispose
  viewport.ts   scene graph mirror, cameras (persp/ortho), lights, grid, picking,
                shading modes, OrbitControls w/ touch mapping
  transform.ts  TransformControls wrapper, snap, mobile-friendly handles
  geometry.ts   primitive factory + params, imported GLB attachment, disposal
  materials.ts  MaterialData ⇄ MeshStandardMaterial, env intensity, transparency
  gltf.ts       GLB import (Loader) / export (Exporter), asset blob plumbing
editor/
  session.ts    EditorSession: owns doc, three mirror, mutate(), save scheduling
  history.ts    snapshot-ring undo/redo (cap 60, coalesced during drags)
  animation.ts  clip/track/keyframe ops + playback sampler
  serialization.ts  project.json / scene.json / assets.json / AI_PROJECT_CONTEXT.md
  sync.ts       cloud load/save, Broadcast transforms, Presence, locks,
                offline queue flush, versions, change log
github/
  github.ts     PAT + Device-Flow auth, repo/branch/tree APIs, blob upload,
                import detection, export commit builder
ai/
  agent-api.ts  AgentAPI: projects/objects/materials/assets/clips/scripts/
                camera/playback/history/AI + Texture API, token auth + scopes +
                rate limits + audit log; live EditorSession or headless IndexedDB
  scripts.ts    sandboxed scene JS (meshes, keyframes, camera, AI generate)
  bridge.ts     transports: window.Web3DStudio.agent + .textures + postMessage + BroadcastChannel
  relay.ts      browser long-poll client for server/agent-relay.mjs (real HTTP)
  settings.ts   provider + token settings (on-device IndexedDB, VITE_AI_* defaults)
  factory.ts    provider wiring with custom → free → offline fallbacks
  groq.ts       default Ask assistant (Llama via groq-proxy worker)
  pollinations.ts  FREE image/texture (Flux) + Ask fallback chat
  gradio.ts     shared Gradio Space client (config/upload/queue/SSE/download)
  sf3d.ts       FREE text→3D (Stable Fast 3D Space, best quality, default)
  triposr.ts    FREE text→3D fallback (TripoSR Space, faster)
  custom.ts     user OpenAI-compatible chat/image/3D endpoints
  procedural.ts offline fallbacks: canvas textures + primitive 3D plans
server/agent-relay.mjs  zero-dep localhost HTTP relay for external agents
ui/
  router, toast, dashboard, editor shell, outliner, inspector, toolbar,
  timeline, modals, github-modal
workers/      (reserved) asset-thumbnail.worker.ts in Phase 7
```

## 4. Rendering (§3–5)

- One `WebGLRenderer({ antialias: !lowPower, powerPreference })`, pixel ratio
  clamped to ≤2 (≤1.5 on small screens).
- PBR: `MeshStandardMaterial` + RoomEnvironment PMREM + ACES tone mapping.
- Shadows: single directional light w/ 1024 map, disabled on `lowPower` Tier.
- Picking: raycast against object roots (cheap; GPU picking deferred to Phase 7).
- Shading modes: `solid` (standard), `material` (env-boosted preview), `wireframe`.
- Frustum culling default; instancing/LOD hooks in `viewport.ts` Phase 7.
- Disposal discipline: geometry/material/texture disposed on remove/unload (§46).

## 5. Input (§6–7)

- Desktop: Orbit (LMB), pan (RMB/MMB), wheel zoom, WASD optional, shortcuts:
  `W/E/R` gizmo, `V` select, `F` focus, `Del`, `Ctrl+D`, `Ctrl+Z/Shift+Z`, `Ctrl+S`.
- Mobile: tap = select, 1-finger drag = orbit, 2-finger = pan+pinch, gizmo handles
  enlarged via `transform.ts` scale factor; bottom toolbar + bottom-sheet inspector.
- Tap-vs-drag disambiguation by pointer travel < 8px within 300ms.

## 6. Geometry & materials (§8–15)

- `SceneObjectData` mirrors Mesh{vertices…} conceptually; three holds buffers.
- Half-edge: deferred until bevel/knife need it (Phase 6 evaluates `three-bvh`/`manifold`).
- Mesh edit V1 (vertex/edge/face + extrude/inset/delete/merge): implemented on
  BufferGeometry with selection overlay; heavy ops move to worker when profiled.
- Materials: flat PBR fields now; `node_graph: null` reserved in DB + doc.

## 7. Animation (§18–20)

- Clips → tracks(objectId+property) → keyframes(frame,value,interp).
- Sampler applies position/rotation(rad)/scale each frame while playing;
  scrubbing re-samples without history writes.
- GLB clips import to native tracks where channels map to TRS (Phase 5).
- Bones: `type:'bone'` + skeleton helpers reserved; IK/skinning Phase 6+.

## 8. Collaboration (§28–32)

- Phase 4 transport: **Supabase Realtime Broadcast** (ephemeral transforms @15Hz,
  locks, cursors) + **Presence** (online users, editing target) + Postgres
  upserts (durable, debounced).
- Change envelope `{ op, objectId, data, baseVersion, actor }`; conflicts resolve
  by (lock holder wins) → (highest version) → (last writer) — never silent (§32).
- CRDT seam: `sync.ts` exposes `applyRemoteOp()`; a Yjs/Loro doc can replace the
  envelope transport without touching UI or three layers.

## 9. Offline & versions (§33–35)

- Offline: mutations persist to IndexedDB + `queue`; banner shows state;
  reconnect flushes queue then pulls cloud version; conflicts surface a resolver
  modal (keep mine / take theirs / merge transforms).
- Versions: explicit checkpoints → `project_versions.snapshot`; restore = replace
  doc + full three rebuild (objects only; blobs lazy).

## 10. GitHub layer (§37–43, Phase 8)

- Auth: Device Flow (no backend) or PAT in `sessionStorage`; never in source.
- Import modal: search repos → branches → tree → detect `project.json`/`scene.json`
  or `*.glb/gltf/obj` + textures → import as project/assets.
- Export: builds Git Data API commit (`project.json`, `scene.json`, `assets.json`,
  `AI_PROJECT_CONTEXT.md`, `README.md`, `assets/models|textures|animations/*`).
- Imported repos treated as untrusted: only parsed as data, never executed (§55).

## 11. Security (§24, §27, §55)

- Frontend holds anon key only; RLS enforces owner/admin/editor/animator/viewer.
- Storage paths namespaced `<project_id>/…`; policies re-check membership.
- No `eval` of imported content; GLB parsed by three loader (no script execution).
  User/agent scene scripts compile through `new Function` with a sealed `scene`
  API; GitHub imports force `enabled: false`.

## 12. Performance budget (§45–47)

- Initial JS ≤ 350 kB gzip (three chunk lazy-loads editor only on `#/p/`).
- First paint < 2s on Moto G-class; viewport ≥ 30fps with 200 primitives.
- Debounced cloud writes; Broadcast ≤ 15Hz/object; progressive asset load
  (metadata → thumbnails → visible → rest).

## 13. Phase tracker

- [x] Phase 1 — foundation (this drop): scaffold, viewport, auth, dashboard,
      solo/team create, cloud save/load, offline queue, presence+locks (supabase
      path implemented, local fallback), timeline V1, GLB import/export,
      GitHub import/export window, PWA shell.
- [ ] Phase 2 — hardening: outliner DnD, multi-select, measurement, shortcuts UI.
- [ ] Phase 3 — storage pipeline: thumbnails, compression, progressive LOD rows.
- [ ] Phase 4 — collab polish: cursors, follow mode, conflict UI, invite links.
- [x] Animation basics+: auto-key record mode, prev/next keyframe, linear/step toggle.
- [x] Lighting basics: point/spot/directional/ambient/hemisphere + env/shadow scene settings.
- [x] Material/texture basics: presets, flat/double-sided, emissive intensity, image maps.
- [ ] Phase 5 — animation: graph editor, GLB clip import, retarget basics.
- [ ] Phase 6 — modeling: half-edge ops, bevel/loopcut/knife/mirror/subdiv.
- [ ] Phase 7 — workers/wasm/UV/paint/LOD/node materials.
- [x] Phase 8 (agent/API slice) — AI Studio: Groq Llama Ask (proxy) + free Stable Fast 3D (+TripoSR fallback) + Pollinations textures,
      custom OpenAI-compatible endpoints, Agent API (page/postMessage/channel/relay),
      token auth + audit log, offline fallbacks. Remaining: PR export, repo templates.
- [ ] Phase 8 — GitHub: PR export, repo templates.
- [ ] Phase 9 — perf/a11y/i18n/docs pass.
