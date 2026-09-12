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
engine/
  renderer.ts   WebGL2 renderer, WebGPU detection, PBR/env/shadows, resize, dispose
  viewport.ts   scene graph mirror, cameras (persp/ortho), lights, grid, picking,
                box select, touch gestures, environment/fog/post-FX wiring,
                first-person mode, PNG capture, screen/ground projection
  transform.ts  TransformControls wrapper: space, snap (grid/rotation/object),
                pivot modes, mobile-friendly handles
  geometry.ts   primitive factory + params, imported GLB attachment, disposal
  materials.ts  MaterialData ⇄ MeshPhysicalMaterial, presets, slot maps
  gltf.ts       GLB import (Loader) / export (Exporter), clip ⇄ track mapping
  environments.ts  PMREM environment presets (room/studio/sunset/night/…)
  postfx.ts     bloom / vignette / grain / DoF composer pass
  modeling.ts   merge, subdivide, decimate (no CSG — booleans stay out of scope)
  fps-controls.ts  first-person controller used by Play Mode
  procedural-textures.ts  canvas-generated textures (no asset download)
editor/
  session.ts    EditorSession: owns doc + three mirror, mixin host for every op
  history.ts    snapshot-ring undo/redo (cap 60, coalesced drags, authored
                entries → `undoThrough` / `depthOfMine` for per-user undo)
  animation.ts  clip/track/keyframe ops + playback sampler
  transform-rig.ts  gizmo ↔ selection binding, pivot + snapping state
  transform-ops.ts  duplicate, mirror, apply/reset, pivot presets, align, drop
  selection-ops.ts  multi-select, hide/solo/lock, groups, collections
  scene-ops.ts  environments, fog, post-FX, bookmarks, mesh tools, stats
  animation-ops.ts  keys, easing, clips, dope sheet model, bake
  material-ops.ts   presets, map slots (base/normal/AO), texture upload
  export-ops.ts     OBJ / PNG / GLB / .3dproject / web game
  web-game-export.ts  pure template builder for the playable HTML export
  ai-ops.ts      build scene from text, restyle, optimize
  serialization.ts  project.json / scene.json / assets.json / AI_PROJECT_CONTEXT.md
  sync.ts       cloud load/save, Broadcast transforms, Presence, locks,
                offline queue flush, versions, change log
state/
  store.ts      Store<T> pub/sub slices
  selection.ts  multi-selection with a single-id back-compat surface
  models.ts     ProjectDoc, SceneObjectData, clips, materials, scripts…
  tree.ts       subtree collection / cycle-safe parenting
github/
  github.ts     PAT + Device-Flow auth, repo/branch/tree APIs, blob upload,
                import detection, export commit builder
ai/
  agent-api.ts  AgentAPI: projects/objects/materials/assets/clips/scripts/
                camera/playback/history/AI + Texture API, token auth + scopes +
                rate limits + audit log; live EditorSession or headless IndexedDB
  scene-planner.ts  prompt → ScenePlan (deterministic local composer + LLM JSON)
  style.ts      12 scene styles: palette, lights, environment, fog, post-FX
  scripts.ts    sandboxed scene JS (meshes, keyframes, camera, AI generate)
  bridge.ts     transports: window.Web3DStudio.agent + .textures + postMessage + BroadcastChannel
  relay.ts      browser long-poll client for server/agent-relay.mjs (real HTTP)
  settings.ts   provider + token settings (on-device IndexedDB, VITE_AI_* defaults)
  factory.ts    provider wiring with custom → free → offline fallbacks
  groq.ts       default Ask assistant (Llama via groq-proxy worker)
  pollinations.ts  FREE image/texture (legacy host: flux alias -> whatever it
                   actually serves) + keyed gen.pollinations.ai + Ask fallback chat
  gradio.ts     shared Gradio Space client (config/upload/queue/SSE/download)
  sf3d.ts       FREE text→3D (Stable Fast 3D Space, best quality, default)
  triposr.ts    FREE text→3D fallback (TripoSR Space, faster)
  custom.ts     user OpenAI-compatible chat/image/3D endpoints
  procedural.ts offline fallbacks: canvas textures + primitive 3D plans
server/agent-relay.mjs  zero-dep localhost HTTP relay for external agents
ui/
  router, toast, dashboard, editor shell
  commands.ts        single action registry (palette + menus + mobile + agent)
  command-palette.ts Ctrl/⌘+K fuzzy palette with recents
  outliner.ts        hierarchy, search, rename, drag-parenting, collections
  inspector.ts       transforms, PBR material editor, lights, physics, stats
  asset-browser.ts   models/materials/textures/HDRIs/environments, drag-drop
  dopesheet.ts       dope sheet + graph editor (keys, easing, copy/paste)
  timeline.ts        transport, scrubbing, FPS, clip length
  presence.ts        people, live cursors, locks, activity, recent changes
  playmode.ts        ▶ Play: FPS controls, gravity, colliders, triggers
  mobile.ts          bottom-sheet editing mode + touch bars
  layout.ts          dockable panel layout persistence
  panels-extra.ts    export hub, share roles
  ai-scene-ui.ts     build-from-text / restyle dialogs
  chrome.ts          fullscreen + auto-hide tools
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

- Desktop: Orbit (LMB), pan (RMB/MMB), wheel zoom, `Ctrl+drag` box select.
- Mobile: tap = select, long-press = select/add, 1-finger drag = orbit,
  2-finger = pan + pinch, double-tap = focus; gizmo handles enlarged via
  `transform.ts` scale factor; bottom-sheet panels instead of side columns.
- Tap-vs-drag disambiguation by pointer travel < 8px within 400ms.
- Shortcuts (also in the in-app **?** sheet and the command palette):
  `W/E/R` gizmo · `X` space · `Alt+R` reset · `Ctrl+Shift+A` apply transforms ·
  `Ctrl+D` duplicate · `Ctrl+G`/`Ctrl+Shift+G` group/ungroup · `Del` delete ·
  `Ctrl+A`/`Ctrl+I` select all/invert · `Tab` cycle · `V` deselect ·
  `H`/`Shift+H` hide/show · `/` solo · `F`/`Shift+F` frame selected/all ·
  `G` grid · `Z` wireframe · `Alt+1/3/7` views · `Alt+5` ortho ·
  `K` keyframe · `,`/`.` prev/next key · `Space` play · `P` play mode ·
  `A` AI Studio · `J` Scripts · `Ctrl+K` palette · `Shift+A` add menu ·
  `?` shortcuts · `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo · `Ctrl+S` save ·
  `F11` fullscreen · `Esc` show tools / exit.

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
  Current build: `three` ≈ 135 kB gz, app shell ≈ 119 kB gz, editor ≈ 135 kB gz,
  CSS ≈ 8 kB gz; AI Studio (10 kB gz), Scripts (2 kB gz) and the scene dialogs
  (1.5 kB gz) are separate chunks fetched on first open.
- First paint < 2s on Moto G-class; viewport ≥ 30fps with 200 primitives.
- Debounced cloud writes; Broadcast ≤ 15Hz/object; progressive asset load
  (metadata → thumbnails → visible → rest).

## 13. Phase tracker

- [x] Phase 1 — foundation: scaffold, viewport, auth, dashboard, solo/team
      create, cloud save/load, offline queue, presence + locks, timeline V1,
      GLB import/export, GitHub import/export window, PWA shell.
- [x] Phase 2 — hardening: outliner DnD + search + collections, full
      multi-select, command palette, mobile editing mode, shortcuts sheet.
- [x] Phase 3 — storage pipeline: thumbnails, blobs in IndexedDB, autosave +
      crash-recovery heartbeat, `.3dproject` backup/import.
- [x] Phase 4 — collab polish: live cursors, "X is editing Y" indicators, locks,
      activity feed, share roles, version history + restore, authored undo with
      peer-conflict confirmation. Remaining: follow mode, conflict merge UI.
- [x] Animation basics+: auto-key, prev/next key, per-key easing, dope sheet with
      draggable keys, graph mode, clips, bake, animated GLB export.
- [x] Lighting basics: point/spot/directional/ambient/hemisphere, PMREM
      environment presets, fog, post-FX (bloom/vignette/grain/DoF).
- [x] Material/texture basics: PBR fields, 12 presets, base/normal/AO slots,
      procedural textures, AI textures.
- [~] Phase 5 — animation: graph editor (inside the dope sheet) done, GLB clip
      import done; retarget basics still open.
- [~] Phase 6 — modeling: merge / subdivide / decimate / mirror done.
      Half-edge ops (extrude, inset, bevel, loop-cut, knife) and booleans stay
      deliberately unimplemented: a real implementation needs a half-edge
      kernel, and faking them has burned every lightweight web editor.
- [ ] Phase 7 — workers/wasm/UV/paint/LOD/node materials.
- [x] Phase 8 (agent/API slice) — AI Studio: Groq Llama Ask (proxy) + free
      Stable Fast 3D (+TripoSR fallback) + Pollinations textures, custom
      OpenAI-compatible endpoints, Agent API (page/postMessage/channel/relay),
      token auth + audit log, offline fallbacks, scene-from-text + restyle.
      Remaining: PR export, repo templates.
- [x] Play mode slice — first-person controls, gravity, colliders, triggers,
      `play`/`frame` scripts, playable single-file HTML export.
- [ ] Phase 9 — perf/a11y/i18n/docs pass.
