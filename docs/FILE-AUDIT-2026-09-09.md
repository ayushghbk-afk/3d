# File-by-file audit — 2026-09-09

> **Resolution update (same day, this branch):** §1.1–§1.7 and most of §2 are now
> implemented — see the table at the bottom (§7). 209 unit tests pass.
> Playwright browser verification still can't run in this sandbox (Chromium
> download is TLS-blocked), and the §1.7 import-side mapping + light export,
> §2.3 mesh editing, §2.5 zoom/key-drag and §2.7–2.8 remain open.

Concrete follow-up to the product review. Every claim below was verified against this
checkout (baseline: `tsc --noEmit` clean, 194 unit/PG tests passing). Review items are
mapped to `file:line`; ✅ = already implemented (don't rebuild), ⚠️ = exists but broken
or half-wired, ❌ = genuinely missing.

The single most important correction to the product-level review: **the architecture is
already what the review says to build.** `ProjectDoc` in `EditorSession` is the one
source of truth; the viewport is a mirror; every mutation flows through
`session.markDirty()` → IndexedDB (debounced 400 ms) + Supabase (debounced 2 s). Do not
rewrite this. What's missing is fidelity *at the edges* (export/thumbnail/history/GitHub
round-trip) and several editor-UX affordances. The repo's own
`docs/AUDIT-2026-09-08.md` / `docs/HARDENING-REPORT-2026-09-08.md` agree — "remaining
priorities" §6 lists almost exactly the items below.

---

## 0. Review claims vs. reality

| Review item | Status | Evidence |
|---|---|---|
| A. One connected application | ✅ mostly | `#/join` route, `?import=github`, save badges, autosave, refresh-reopen all wired in `src/ui/editor.ts:150-190`, `src/editor/session.ts:163-196` |
| B. One source of truth | ✅ | `src/editor/session.ts` (doc + viewport mirror), `src/state/models.ts`; **do not restructure** |
| 1. Scene/Hierarchy panel | ⚠️ | `src/ui/outliner.ts` — tree, eye-toggle, collapse exist; no DnD, no per-row actions, rename via `prompt()` (line 90) |
| 2. Professional Inspector | ⚠️ | `src/ui/inspector.ts` — transform/material/light/parent exist; no Reset/Apply/Copy-Paste Transform, no animation section |
| 3. Asset manager | ❌ | no asset browser anywhere; assets only surface as texture thumbs in inspector |
| 4. Modeling tools | ❌ | primitives ✅ (`geometry.ts`); vertex/edge/face, extrude/inset/bevel/loopcut absent (`SelectionMode` type in `models.ts:15` is dead — zero usages) |
| 5. Gizmos + W/E/R | ✅/⚠️ | `src/engine/transform.ts` + `src/ui/editor.ts:52-58`; snap API exists but is **dead code** (see §2.6) |
| 6. Timeline | ⚠️ | `src/ui/timeline.ts` — play/stop/fps/keys/interp/scrub exist; no zoom, no per-object rows, loop always on |
| 7. Undo/redo | ⚠️ | `src/editor/history.ts` — snapshot ring, covers objects/materials/clips/scripts; **not** assets/settings; **not** collab-safe (§2.2, §2.3) |
| 8. Autosave indicator | ✅ | `SaveState` badges "✓ Saved / … Saving / 💾 Local / ⚠ Offline / ✕ Error" — `src/ui/editor.ts:196-205` |
| 9. Offline-first | ⚠️ | IndexedDB + queue + flush + online/offline events ✅; "N changes uploaded" progress ❌ |
| 10. Collaboration | ⚠️ | locks, presence, `editing X` status, ephemeral 15 Hz transforms ✅; no 3D cursors; conflicts whole-project only (`session` onRecovery modal) |
| 11. GitHub UX | ⚠️ | real import/export/device-flow ✅ (`src/github/github.ts`); no change-preview/`+/-/~` list; **round-trip loses textures** (§2.5) |
| 12. AI structured ops | ✅ | Agent API + scripts run through session mutators, checkpointed → undoable (`src/ai/agent-api.ts:851`, `session.ts:1009`) |
| 13. Mobile | ⚠️ | bottom bar + slide-up sheets exist (`styles.css:331-348`); props button opens two overlapping sheets; no undo/add-asset in bar |
| 14. Adaptive quality | ❌ | one static `lowPower` heuristic (`renderer.ts:25`); no tiers, no FPS loop |
| 16. Golden test | ⚠️ | Playwright covers steps 1-11 & partial offline (`tests/pages/pages.spec.ts`); nothing beyond "refresh" |

---

## 1. P0 — correctness bugs (fix before any new feature)

### 1.1 Selection-highlight blue leaks into GLB export and thumbnails
`src/engine/viewport.ts:44-70` mutates the **shared** material's `emissive` to
`0x2266ff` for highlighting. `EditorSession.exportGlb` (`src/editor/session.ts:795-811`)
clones live objects — clones **share the material instance** — so the selected object's
GLB comes back with a blue glow; `captureThumbnail()` (`session.ts:239`) does the same to
project thumbnails.

> Fix: in `exportGlb()` and before thumbnail capture, call `viewport.outline(null)` and
> `viewport.outline(prevId)` after; long-term move highlight to an additive outline pass
> (never mutate material state). Also restore `mat.userData.highlighted` handling in
> `materials.ts:37` stays valid after that.

### 1.2 Undo/redo can silently revert a collaborator's work
Undo restores whole-doc snapshots then `markDirty('undo')` (`session.ts:1076-1089`), which
bumps `doc.version` and `pushDoc()` writes the **entire document** — including remote
edits that landed after the checkpoint — back to Supabase. There is no version guard:
`persistDoc` updates `projects` with `.eq('id')` only (`sync.ts:212`), last-write-wins.

> Fixes, in order of effort:
> 1. `sync.ts:212`: add `.eq('version', doc.cloudVersion)` optimistic check; on 0-rows
>    returned, pull + run the existing recovery modal.
> 2. `session.ts undo()/redo()`: after `rebuildFromDoc()`, merge remote-touched objects
>    back (track `lastRemoteApply` map of id→version in `applyRemote*` and skip doc
>    entries whose remote version > snapshot version).
> 3. Longer term: per-object op log (the seam `sync.ts` already exposes via
>    `broadcastOp`) so undo replays inverse ops, not doc snapshots.

### 1.3 History ignores `assets` — GLB import/delete/re-import corrupts
`Snap` (`src/editor/history.ts:6-11,22-31`) copies objects/materials/clips/scripts only.
Undo of an import leaves the `AssetMeta` in `doc.assets` (orphan, uploaded to storage,
bloats every GitHub export); redo of a delete keeps a `SceneObjectData` whose `assetId`
may point at an asset entry that… exists, so mostly harmless — but `sync.ts:196-201`
deletes remote rows for **missing** objects while assets are never reconciled in either
direction.

> Fix: include `assets: deepClone(doc.assets)` in `take()`/`undo()`/`redo()`;
> add `localDb` blob GC: on delete, refcount assets (`objects + materials.mapAssetId`);
> on 0 refs after save, `deleteBlob`. (Dashboard project delete at
> `src/ui/dashboard.ts:256` also skips this — mirror `agent-api.ts:347` which already
> deletes blobs.)

### 1.4 `deleteObject` orphans grandchildren
`session.ts:356` collects `target + direct children` only. Delete a Group with children
that have children and the leaves survive with a dangling `parentId` (the outliner even
renders this "orphans (bad parentId)" band, `outliner.ts:39-41`). Remotes get only
`broadcastOp('delete', { id: target })` (`session.ts:362`) so peers get the *opposite*
scene: they delete less.

> Fix: walk `children` transitively (one pass, same order as `sync.ts` persistence);
> broadcast each removed id (batch in one `ops` message to keep 15 Hz budget).

### 1.5 Parent cycle = frozen tab
`session.setParent` (`session.ts:394-420`) guards `childId === parentId` only. Selecting
an object's own descendant as parent (the inspector `<select>` lists all other objects,
`inspector.ts:101-106`) creates a THREE parent cycle; the next
`updateWorldMatrix`/render loop recurses forever.

> Fix: shared `isAncestor(doc, childId, maybeAncestor)` helper; use it in
> `session.setParent`, the inspector option list (exclude descendants), and
> `agent-api`/`scripts` `setParent` (`scripts.ts:679`, agent-api `object.setParent`).

### 1.6 GitHub round-trip loses textures (and `scene.json` never carries them back)
Export writes `assets.json` with texture paths and `scene.json` materials keep
`mapAssetId` (`serialization.ts:26-59`), but `importStudioProject` (`src/github/github.ts:200-263`)
only reads model blobs (`det.models`) and never rebuilds `doc.assets` for textures →
`MaterialData.mapAssetId` points to a non-existent asset id; viewport shows flat color
until someone deletes the material.

> Fix: in `importStudioProject`, parse `assets.json` when present, download
> `det.textures` for kind=texture, push `AssetMeta` entries, and remap both
> `o.assetId` **and** `m.mapAssetId` (old-id → new-id) instead of filename guessing
> (`github.ts:249-256`). Round-trip check belongs in the golden test (§4).

### 1.7 GLB export drops animations and lights; import drops animations
- `src/engine/gltf.ts:26` — `animations: []` hardcoded (repo's own audit P1 #7).
- `session.exportGlb` builds the group from **live viewport objects**: exporting while the
  playhead sits mid-clip bakes the sampled pose into the file (doc transforms untouched,
  so it looks fine in-app then breaks on re-import — exactly the review's failure class).
- `parseGlb` returns `animations` (`gltf.ts:7,13`) — `importGlbBytes` (`session.ts:604-639`)
  ignores them; also ignores nested TRS mapping for imported meshes.
- THREE `Light`s aren't serialized by `GLTFExporter` → every exported GLB is unlit.

> Fix (small first slice):
> 1. `exportGlb`: restore doc transforms before export (`for o of roots: viewport.apply
>    from doc` — or export from a throwaway `Group` rebuilt from `doc`, reusing
>    `rebuildFromDoc` machinery), then re-`applyPose`.
> 2. Map `AnimClip`→`THREE.AnimationClip` (position/quaternion/scale tracks per objectId;
>   `interp:'step'` → `InterpolateDiscrete`) and pass them to
>   `exporter.parse(root, ..., { animations })` — three does the rest.
> 3. On import, match `gltf.animations` channel target nodes to child names → doc tracks
>    where `node ↔ objectId` is resolvable; toast what was skipped.
> 4. Lights: export as `KHR_lights_punctual` via `GLTFExporter.register(cb)` — or accept
>    and state it in the export modal ("lights don't survive GLB; use GitHub export").

### 1.8 `flushQueue` "latest wins" can drop an intermediate state on peers
`sync.ts:325-339`: the queue stores **one** full-doc snapshot (`push:<id>`, `sync.ts:340`
comment) and flush prefers `queued.updatedAt > current.updatedAt` — for a single device
that's fine, but combined with §1.2's unguarded `projects.update` two offline devices
both "win". Fix via the optimistic `.eq('version', cloudVersion)` guard in §1.2(1); the
queue itself can stay coarse.

---

## 2. P1 — half-wired things to finish

### 2.1 Snap is dead code
`TransformGizmo.setSnap` (`src/engine/transform.ts:63-67`) has **zero callers**.
Add a 🧲 toggle in the rail (session slice `snapEnabled = Store<boolean>`, persisted via
`localDb.setSetting('snap', …)`), call `gizmo.setSnap()` on subscribe. Values (0.1 / 15°)
are already right.

### 2.2 Inspector: the three buttons that make it feel pro
`src/ui/inspector.ts` — add to `prop-actions` (line ~89): **Reset Transform**
(`setTransform(o.id, {0,0,0}, {0,0,0}, {1,1,1})` after `history.checkpoint`),
**Copy / Paste Transform** (`navigator.clipboard` + id-based doc lookup; paste = same
path so it's undoable and broadcasts). `applyTransform`-style "apply" makes little sense
with live-viewport mirroring — skip it; the review over-scoped here.

### 2.3 `SelectionMode` exists, nothing uses it
`models.ts:15` declares `'object' | 'vertex' | 'face' | 'edge'`; grep shows no consumer.
Either delete the type (honest) or land the first slice: object-mode only for now +
**one** real mesh op (`extrude` on BufferGeometry for primitives is tractable, no
half-edge needed yet). Do **not** start a modeling subsystem before §4's round-trip tests
exist — that's where "looks right in viewport / gone after save" bugs live.

### 2.4 Outliner polish
`src/ui/outliner.ts`:
- Replace `prompt('Rename object')` (line 90) with inline `<input>` edit (the inspector
  already has a name field — dblclick should focus it instead: `s.select(id)` + focus).
- `draggable="true"` + `dragstart/dragover/drop` → `session.setParent(dragId,
  overId ?? null)` (after §1.5 guard). This single change delivers the review's "drag-
  and-drop hierarchy".
- Per-row hover actions (dup/delete/lock) reusing `session` methods — ~30 lines.

### 2.5 Timeline deltas
`src/ui/timeline.ts`: loop is unconditional (`animation.ts Playback.tick:120 f>len→0`).
Add `loop = Store<boolean>` + button; add `pxPerFrame` zoom (wheel on ruler, clamp
`[0.5, 20]`, ruler already draws via `x(f)` — one scalar); keyframe diamonds are already
drawn — make click-on-diamond `setFrame(k.frame)`; drag on diamond → `setKeyframe` (it
round-trips through `markDirty('animation')` for free). Per-object track rows: defer; the
"selected object shows its 3 lanes" model is actually fine for this product size.

### 2.6 Editor shell nits
- `src/ui/editor.ts:62` — `Space` toggles playback even with a modal open (guard exists
  for `a`/`j` only; check `document.getElementById('modal-root').hasChildNodes()`).
- `editor.ts:262` — `setInterval(updateGizmoButtons, 500)` → replace with
  `session.transformMode.subscribe(...)`.
- `index.html:5` — `maximum-scale=1.0, user-scalable=no` blocks pinch-zoom everywhere
  (login, dashboard forms). The canvas already sets `touch-action: none`
  (`styles.css:.viewport-canvas`) — that's the correct scope; drop the meta restriction.
- `styles.css` mobile sheet bug: `#mobilebar [data-m="props"]` toggles `.sheet-open` on
  *both* `.inspector` and `.outliner` (editor.ts ~line 385) — they overlap (z 51/50), so
  the outliner is invisible. Make it a segmented sheet: one container, two tabs.

### 2.7 Asset manager = 80% serialization already done
`doc.assets` has `id/name/kind/size/thumb/createdAt` (§ review asks exactly this). Add
`src/ui/assets-panel.ts` (dock like outliner): list `s.doc.assets`, thumbnails from
`AssetMeta.thumb` (textures) / capture-on-import for models, buttons: rename (updates
meta only), delete (with §1.3 refcount), drag-into-viewport (`drop` on `#vp` →
`importGlbFile`; `dragover` preventDefault). New model for the drop: viewport canvas
already owns pointer events — add handlers on `.vp-wrap` not the canvas.

### 2.8 Quality tiers (review §15) — smallest honest version
`renderer.ts:detectCaps` already computes `lowPower`. Add `perfMode = 'auto'|'low'|'med'|'high'`
to `ProjectSettings` (normalize in `models.ts:normalizeDoc`) + inspector "Preview
controls" card; in `Viewport.loop` measure EMA FPS; in auto mode when fps < 25 for 2 s
→ step down (shadows off → DPR 1 → `widthSeg/heightSeg` halved on *new* primitives only).
Do **not** rebuild live geometry — tier affects DPR/shadows/antialias(next open)/seg
defaults. ~150 lines total across `renderer.ts`, `viewport.ts`, `models.ts`, `inspector.ts`.

---

## 3. Things the review got wrong — don't do them

- **Don't rebuild state management.** The `ProjectDoc` + mirror + `markDirty` pipeline is
  the design the review prescribes; the bug classes it fears live at export/history/
  GitHub edges (fixed above), not in the store.
- **Don't add `Store` slices per panel.** `state/store.ts` slices are used for UI state
  only and that's correct; a reactive framework here violates the "no framework runtime"
  constraint in `docs/ARCHITECTURE.md §1`.
- **Skip per-object "Keep Mine/Theirs" merge UI for now** — the whole-project resolver
  modal (`editor.ts:158-189`) + the version-guard fix (§1.2) covers realistic conflicts;
  per-field merge is Phase-4/CRDT territory (the seam is documented in ARCHITECTURE §8).
- **Undo label UI**: `History.undoLabel()` exists and is only shown nowhere — one tooltip
  on the rail button (`title="Undo — ${label}"` on `rev` change), no toolbar redesign.

---

## 4. Test work — extend, don't restart

`tests/pages/pages.spec.ts` today = golden-path steps 1–11 (+offline reopen). Add
`tests/pages/golden.spec.ts` covering the rest of the review's list, all deterministic
and local (no Supabase; mock `#/login` like existing spec):

1. Move/rotate/scale via inspector inputs → values round-trip through reload (uses
   `.out-row`, `#insp-name`, `[data-vec]` selectors).
2. Keyframe (mobile `◉`), play, verify transform at frame == doc sample (read
   `window.Web3DStudio.agent` playback snapshot — the Agent API makes this observable;
   it exists precisely for this).
3. **GLB round-trip**: export via `session.exportGlb` path → capture download → re-import
   in a new project → assert object count/transform (post-§1.7 it also asserts material
   baseColor ≠ highlight-blue — regression for §1.1 — and 1 clip with ≥2 keys).
4. GitHub: unit-level round-trip on serialization only (`fromSceneJson(toSceneJson(doc))`
   equality incl. `mapAssetId` remap after §1.6) — no network.
5. Undo-scope: create A, B; remote-apply a doc change for B via `applyRemoteOp`;
   `undo()` must revert only A (§1.2 guard).

Unit additions: `history.test.ts` (assets in snapshots), `session.test.ts`
(`deleteObject` transitive, `setParent` cycle rejection), `serialization.test.ts`
(textures survive export → importStudioProject remap given fake tree/blobs).

---

## 5. Order of attack (patch-size estimates)

| # | Change | Files | Size |
|---|---|---|---|
| 1 | §1.1 highlight-before-export | `session.ts` | ~10 lines |
| 2 | §1.4 transitive delete + §1.5 cycle guard | `session.ts`, `inspector.ts`, `models.ts` (helper) | ~60 lines |
| 3 | §1.2 version-guarded push | `sync.ts` | ~40 lines |
| 4 | §1.3 assets in history + blob GC + dashboard delete | `history.ts`, `session.ts`, `dashboard.ts` | ~80 lines |
| 5 | §1.7 GLB pose-reset + animation export/import | `session.ts`, `gltf.ts` | ~150 lines |
| 6 | §1.6 texture round-trip | `github.ts` | ~70 lines |
| 7 | §2.1/2.2 snap toggle + reset/copy/paste | `editor.ts`, `inspector.ts`, `transform.ts` | ~120 lines |
| 8 | §2.4 DnD hierarchy + inline rename | `outliner.ts` | ~90 lines |
| 9 | §2.5 timeline loop/zoom/diamond-click | `timeline.ts`, `animation.ts` | ~100 lines |
| 10 | §4 golden spec additions | `tests/pages/*`, `tests/unit/*` | ~250 lines |
| 11 | §2.7 asset panel + drop-to-import | new `assets-panel.ts`, `editor.ts` | ~200 lines |
| 12 | §2.8 adaptive quality | `renderer.ts`, `viewport.ts`, `models.ts` | ~150 lines |

Items 1–6 are bug fixes with observable "disappears after refresh/export" symptoms — ship
them as one PR series before touching features 7+. Each already has a matching test in §4.

---

## 7. Resolution status — implemented on `arena/01a0864e-3d`

| Audit item | Fix | Verified by |
|---|---|---|
| §1.1 highlight leak | `EditorSession.withHighlightOff()` wraps GLB export **and** autosave thumbnails | code review (sync, non-UI logic) |
| §1.2 undo overwrites peers | `sync.ts`: `observedHead` compare-and-swap on `projects.version` (`PATCH … .eq('version', head)`); conflict → pull → recovery modal; idempotent-retry path when the row already holds our revision | `sync.test.ts` ×2 new |
| §1.3 assets outside history | `history.ts` snapshots include `doc.assets`; undo/redo restore them | `group.test.ts` |
| §1.4 delete orphans grandchildren | shared `state/tree.ts` `collectSubtree()`; `deleteObject` removes the full subtree, prunes animation tracks, and broadcasts every removed id (peers converge) | `group.test.ts` ×2 |
| §1.5 parent-cycle freeze | `isWithinSubtree()` guard in `session.setParent`, scripts `scene.setParent`, and agent `object.update`; inspector dropdown hides descendants; `viewport.attachToParent` refuses to create THREE cycles even for pre-existing corrupt saves | `group.test.ts`, `viewport-parenting.test.ts` |
| §1.6 GitHub texture round-trip | `importStudioProject` now consumes `assets.json` (`DetectedProject.assetsJson`), re-downloads textures, remaps `object.assetId` **and** `material.mapAssetId`; legacy repos keep the old filename fallback; blobs persist with their real mime; merge flow hydrates maps immediately | typecheck + code review (network path mocked elsewhere) |
| §1.7 GLB motion | `exportGlb` writes real glTF animations via `docClipsToAnimationClips` (quaternion-converted rotation, step-key hold baking, unique `exportNodeName` targets); export runs from the **document** pose, not the scrubbed viewport; orphan parents no longer vanish from the file. Still open: import-side clip→track mapping, lights (`KHR_lights_punctual`) | `glb-anim.test.ts` ×5 |
| §2.1 dead snap API | 🧲 Snap toggle in the tool rail (`session.snap` store → `gizmo.setSnap`, persisted in IndexedDB settings) | manual (preview) |
| §2.2 inspector actions | Reset / Copy / Paste Transform (clipboard string form, works cross-tab) + Ungroup on groups | manual (preview) |
| group button honesty | Rail "Group" now wraps the current selection (`groupSelection()`); empty selection still just adds a group | `group.test.ts` |
| duplicate honesty | `duplicateObject` copies the subtree with remapped parents | `group.test.ts` |
| §2.5 loop | `Playback.loop` + 🔁 timeline toggle (stops on last frame when off) | typecheck; loop wrap logic unchanged when on |
| mobile sheet stacking | Bottom bar split into 🗂 Scene / ⋮ Props; opening one closes the other | manual (preview) |
| key leak through modals | Space no longer toggles playback with a modal open | code review |
| gizmo-button poll | `setInterval(500ms)` → store subscriptions; undo button now shows the undo label as its tooltip | code review |
| dashboard blob leak | Project delete purges IndexedDB asset blobs (matches the Agent-API path) | code review |
| reparent on fresh objects | `reparentData` refreshes **both** world matrices before baking (freshly added objects had an identity `matrixWorld` — the exact trap documented in `viewport.ts`) | `group.test.ts` |

Not yet done (intentionally): outliner `prompt()` rename & DnD parenting (deferred — native drag is unusable on touch, which is this app's primary input), timeline zoom/key-drag, asset panel, quality tiers, GLB import animation mapping.
