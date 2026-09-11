# Web 3D Studio

Lightweight browser-based 3D modeling, animation and real-time collaboration.
Mobile-first, local-first, cloud-synced.

## Features

Everything below runs in the browser — no install, no backend to host. The app
stays deliberately small: vanilla TypeScript, one CSS file, three.js, and heavy
panels (AI Studio, Scripts, scene dialogs) loaded only when you open them.

### Edit

- **Transform gizmos** — move / rotate / scale (`W` `E` `R`) in world or local
  space (`X`), with grid snapping, rotation snapping and object snapping.
- **Multi-select** — Shift/Ctrl-click, box select (`Ctrl+drag`), select all,
  invert, cycle (`Tab`), select children/parent/siblings/same material. The
  inspector edits every selected object at once and the gizmo drives them
  together.
- **Real selection hygiene** — hide/show (`H`), solo (`/`), lock/unlock, inline
  rename, collections, drag-to-reparent in the outliner, and search that filters
  the tree as you type.
- **Apply / reset transforms**, **duplicate**, **mirror on X/Y/Z**,
  **drop to ground**, **align**, **snap to grid**, **pivot & origin editing**
  (bounds centre / bottom / top / object origin).
- **Command palette** (`Ctrl/⌘+K`) — every action, fuzzy-searchable, with
  recent commands remembered. `Shift+A` opens it straight on the create menu.
- **Outliner v2** — hierarchy, visibility, locks, drag-parenting, multi-select,
  search, collections.
- **Undo/redo that respects collaborators** — every entry is tagged with its
  author; if someone edited after you, undo tells you what else would be
  reverted and asks before throwing their work away. The collaboration panel
  lists recent changes with authors.
- **Autosave** every 20s plus crash recovery: a heartbeat lets the app offer
  your unsaved session back after a reload.

### Create

- **Primitives** (cube, sphere, cylinder, cone, plane, torus) and **lights**
  (point, spot, directional, ambient, hemisphere).
- **Material editor** — base colour, metallic, roughness, emission, opacity,
  transmission, side, plus base / normal / AO texture slots and one-click
  **presets**: plastic, metal, glass, wood, stone, fabric, neon, gold, chrome,
  rubber, emerald, matte.
- **Asset library** — models, materials, textures, HDRI environments and recent
  items; drag a tile into the viewport to drop it where you point.
- **Lighting & environment** — PMREM environment presets (room, studio, sunset,
  night, overcast, cyberpunk, forest, void), fog, and post-FX (bloom, vignette,
  grain, depth of field).
- **Procedural textures** — eight canvas-generated patterns (checker, grid,
  noise, wood, marble, bricks, camo, gradient) with no asset download.
- **Cameras** — perspective/orthographic (`Alt+5`), top/front/right/left/back/
  bottom presets (`Alt+7/1/3`), frame selected (`F`), focus, bookmarks,
  first-person walk mode.
- **Mesh tools** — merge, subdivide, decimate, mirror, plus GLB import with
  drag-and-drop placement.

### Animate

- **Timeline** with scrubbing, play/pause, loop, FPS selector and clip length.
- **Dope sheet** — one row per animated object/property, key diamonds you can
  drag, marquee select, copy/paste/delete keys, easing presets per key
  (linear, step, ease, ease-in, ease-out), and a **graph mode** for curves.
- **Auto-key** recording, previous/next keyframe jumps (`,` `.`), **bake to a
  new clip**, multiple clips, and animated **GLB export**.

### Collaborate

- Live **cursors**, **presence list** and "Ayush is editing *Cube*" selection
  indicators, with a **Focus** button to jump to what a teammate selected.
- **Object locks**, **activity feed**, **version history with restore**, and
  share roles (view / comment / edit / public link).
- Sync indicator, offline queue and conflict detection; everything keeps
  working with no network and reconciles when you come back.

### AI

- **Build a scene from text** — "create a small sci-fi room with a desk, two
  monitors, blue neon lights and a chair" produces a whole named hierarchy with
  materials, lights, environment and post-FX. Works offline (deterministic
  composer) and improves with an LLM when one is configured.
- **Restyle the scene** — "make this look like a cyberpunk game" remaps
  materials, lighting, environment, fog and post-FX across 12 styles.
- **Optimize**, **AI textures**, **text-to-3D**, **Ask** (project-grounded Q&A)
  and the **Agent API** — see [`docs/AGENT_API.md`](docs/AGENT_API.md).

### Play & ship

- **▶ Play Mode** (`P`) — first-person WASD + mouse look, touch joystick + jump
  button, gravity, colliders, trigger volumes, and `play`/`frame` scripts.
  Exiting restores your authored scene exactly.
- **Export a playable web game** — one self-contained HTML file with the scene
  embedded, ▶ Play, WASD/touch controls, physics, triggers and your `play`
  scripts. Host it anywhere.
- Also **GLB**, **OBJ**, **PNG** render, **.3dproject backup**, and
  **GitHub** import/export.

### Save everywhere

Three layers, always: **IndexedDB on the device**, **Supabase in the cloud**
(when signed in), and **.3dproject file export/import**. Autosave, offline
queue with reconnect flush, sync indicator, conflict detection, version history
with restore and backup download/import.

### Mobile

On phones and tablets the editor becomes a bottom-sheet workflow — Add /
Object / AI / More sheets, a transform bar and a transport row — so the 3D view
keeps most of the screen. Touch gestures: one finger orbits, two fingers pan,
pinch zooms, long-press selects, double-tap focuses.

### Templates

New projects start from Blank, Product Showcase, Low-Poly World, Room, Game
Environment, Character, Solar System, Animation or 3D Logo.


## GitHub Pages + Supabase

**Site:** https://ayushghbk-afk.github.io/3d/

The app is static and runs on GitHub Pages without a Node server. The Pages
workflow builds `dist/`, tests it under `/3d/`, and deploys after changes reach
`main`. Set **Settings → Pages → Source → GitHub Actions** first.

**[Finish the setup: GitHub Pages, Supabase SQL and email redirects →](docs/DEPLOYMENT.md)**

The supplied Supabase project URL and **public publishable key** are configured
in `.env.production`. This is a **Vite** app: use `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`, not Next.js `NEXT_PUBLIC_*` variable names.
The legacy `VITE_SUPABASE_ANON_KEY` also works. Never use a secret/service-role key.

## Quick start

Requires **Node.js 22+**.

```bash
npm ci
npm run dev        # http://localhost:5173 — local mode by default
```

Local mode provides IndexedDB saves, guest identity, the editor, animation and
GLB import/export. To enable cloud during development, copy `.env.example` to
`.env.local` and supply your Supabase public settings.

To preview the configured production site exactly as a Pages subdirectory:

```bash
npm run build
npm run preview:pages   # http://localhost:4174/3d/
```

## Cloud database

For a **fresh** Supabase project, run [`supabase/setup.sql`](supabase/setup.sql)
in the SQL editor. For an existing installation, apply only the missing files
in `supabase/migrations/`, in filename order. The repair migrations include
`20260908000003_cloud_repairs.sql` and
`20260908000004_scene_project_integrity.sql`; neither deletes user data.
See the deployment guide for legacy-integrity validation before declaring an
existing database clean.

Enable Email auth and allow `https://ayushghbk-afk.github.io/3d/` as both the
Site URL and an allowed Redirect URL. Full instructions and troubleshooting are
in [the deployment guide](docs/DEPLOYMENT.md).

Database access is protected by Row Level Security. Uploaded assets use a
private bucket; thumbnails are public. Collaboration uses private, authorized
Realtime channels.

## GitHub import/export

Editor → **GitHub** → **Import from GitHub** can import a repository's
`project.json` / `scene.json`, or loose `*.glb / *.gltf / *.obj` and textures.
Export writes `project.json`, `scene.json`, `assets.json`,
`AI_PROJECT_CONTEXT.md`, `README.md` and binary assets.

The token-based integration stores a user-provided token in `sessionStorage`
only; never put one in source or share it in chat. The optional GitHub OAuth
Device Flow uses GitHub's OAuth endpoints, whose browser CORS restrictions can
prevent direct use from a static Pages site; do not assume a client ID alone
removes that restriction.

## AI & Agent API

Editor → **✨ AI** opens AI Studio:

- **🧊 3D Model** — free text-to-3D (Stable Fast 3D via Hugging Face, no key;
  TripoSR fallback), with an offline primitive mockup when AI is unreachable.
- **🎨 Texture** — free text-to-texture (Pollinations Flux, no key) applied to
  any material.
- **🖌️ Paint** — the AI looks at your groups to identify each model and its
  parts, then auto-paints, AI-textures or tidies the whole scene at once.
- **💬 Ask** — project-grounded Q&A over the live scene summary. Default model
  is Groq Llama via `groq-proxy.mr-hackerdon808.workers.dev` (no browser key).
  Pollinations is the fallback; counts, lists and summaries keep working offline.
- **🤖 Agent API** — let an AI agent list projects and make changes (objects,
  materials, textures, models, keyframes, camera, scene scripts) via in-page JS,
  `postMessage`, `BroadcastChannel`, or real HTTP through `npm run agent-relay`.
- **🎨 Texture API** — dedicated sibling of the Agent API
  (`window.Web3DStudio.textures`) so AI can generate and apply maps without
  going through the full agent surface.
- **{ } Scripts** — user (or AI) JavaScript that controls any mesh: coordinates,
  keyframes, camera angle, extra models, AI textures. Toolbar **Scripts** or `J`.
- **⚙️ Setup** — point the assistant, image or 3D slot at your own
  OpenAI-compatible endpoint + key. Keys never leave the browser.

**[Full spec: connection methods, auth, method reference, custom APIs →](docs/AGENT_API.md)**

## Movable interface

- **✨ AI Studio** is a floating window: drag it by the title bar, resize it by
  the corner, collapse it to a bar, or toggle it with the **✨ AI** button (or
  the `A` key) to reveal the 3D scene. Its position and size are remembered.
- **{ } Scripts** is the same kind of floating window (`J` or the Scripts
  button): write restricted JavaScript that moves any mesh, writes keyframes,
  aims the camera, adds models and calls the texture generator. AI can add and
  run the same scripts through `script.add` / `script.run`.
- **Outliner, inspector and timeline** resize by dragging their edges and
  collapse via the arrow button or double-click; the layout is remembered.
- **Every dialog** (menus, GitHub, members, shortcuts…) drags by its title bar
  and resizes by its corner.
- **Fullscreen** (⛶ in the toolbar, **More**, or `F11`) hides the browser chrome.
  After a moment of idle the editor tools auto-hide so the 3D view fills the
  screen; move the mouse or tap **Show tools** to bring them back. `Esc` exits.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local Vite development (:5173) |
| `npm test` | Config, auth, sync and PostgreSQL/RLS regression tests |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Serve the production build at root (:4173) |
| `npm run preview:pages` | Plain static `/3d/` preview (:4174) |
| `npm run test:pages` | Playwright production smoke tests; install Chromium first |
| `npm run supabase:setup` | Regenerate the one-paste fresh database setup SQL |
| `npm run agent-relay` | Local HTTP relay so external agents can call the Agent API |

## Docs

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — required dashboard settings and live checks.
- [`docs/AGENT_API.md`](docs/AGENT_API.md) — Agent API, free/custom AI setup, relay server.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture and phase tracker.
- [`supabase/migrations/`](supabase/migrations/) — canonical cloud schema and policies.
