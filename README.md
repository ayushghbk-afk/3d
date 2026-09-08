# Web 3D Studio

Lightweight browser-based 3D modeling, animation and real-time collaboration.
Mobile-first, local-first, cloud-synced. Not a bloated Blender clone.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Works immediately in **local mode** (IndexedDB, guest identity, full editor +
animation + GLB + GitHub import/export). Add Supabase env vars for cloud sync,
auth and collaboration (see `.env.example`).

## Cloud setup (Supabase)

1. Create a project at [supabase.com](https://supabase.com).
2. Run `supabase/migrations/20260908000000_init.sql` in the SQL editor
   (or `supabase db push` with the Supabase CLI).
3. Enable **Email** auth provider. Optionally enable the GitHub provider.
4. Copy the project URL + anon key into `.env`:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

Frontend uses the **anon key only** — all access is enforced by Row Level
Security. Never put a service-role key in the app.

## GitHub integration

Editor → **GitHub** button → **Import from GitHub**:

- **Device flow** (recommended): set `VITE_GITHUB_CLIENT_ID` from a GitHub OAuth
  App (no backend needed), click *Connect*, enter the code at github.com/login/device.
- **Personal token**: paste a fine-grained PAT (stored in `sessionStorage` only).

Import detects `project.json` / `scene.json` or loose `*.glb / *.gltf / *.obj` +
textures. **Export to GitHub** commits `project.json`, `scene.json`,
`assets.json`, `AI_PROJECT_CONTEXT.md`, `README.md` and binary assets so an
external AI coding agent can build on the project.

## Workflow (acceptance test)

Sign in → New Project (Solo/Team) → add cube → move → autosave → refresh →
invite member → both online → move cube (peer sees it live) → add keyframes →
play → Export GLB → Import/Export via GitHub.

## Docs

- `docs/ARCHITECTURE.md` — technical architecture + phase tracker.
- `supabase/migrations/` — canonical cloud schema + RLS + storage policies.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (all interfaces, :5173) |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Serve production build (:4173) |
