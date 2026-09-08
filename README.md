# Web 3D Studio

Lightweight browser-based 3D modeling, animation and real-time collaboration.
Mobile-first, local-first, cloud-synced.

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

## Docs

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — required dashboard settings and live checks.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture and phase tracker.
- [`supabase/migrations/`](supabase/migrations/) — canonical cloud schema and policies.
