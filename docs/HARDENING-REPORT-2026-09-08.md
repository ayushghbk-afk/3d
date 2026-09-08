# Hardening results — 2026-09-08

## Delivery scope

Completed a first prioritized hardening slice, not the full nineteen-phase program. No rewrite, production deployment, remote push, or production database change was made. The repository audit is preliminary; see AUDIT-2026-09-08.md for findings and remaining review scope.

## Files changed

- `src/lib/indexeddb.ts`: generic storage operations resolve at transaction completion, not request success; explicit transaction-abort rejection for generic operations and queue deletion.
- `src/editor/session.ts`: mutations immediately invalidate Saved before debounce timers run.
- `supabase/migrations/20260908000004_scene_project_integrity.sql`: composite scene/project FKs for scene_objects, materials and animations; shared unique index; safe legacy-data validation; PostgREST reload notification.
- `supabase/setup.sql`: regenerated fresh-install bundle.
- `tests/database/migrations.test.ts`: nine additional PostgreSQL tests.
- `tests/unit/indexeddb.test.ts`: three transaction persistence/abort tests.
- `tests/unit/save-state.test.ts`: immediate save-state invalidation test.
- `package.json`, `package-lock.json`: fake-indexeddb development-only test dependency.
- `README.md`, `docs/DEPLOYMENT.md`: migration and operator validation instructions.
- `docs/AUDIT-2026-09-08.md`, this report: findings, scope, results.

## Fixes and security

Locally verified that mismatched scene/project inserts are rejected even when the caller owns both projects. Matching rows remain valid; scene deletion cascades; populated scenes cannot be reassigned inconsistently. Legacy inconsistent rows are retained, not automatically repaired or deleted: the upgrade warns and leaves constraints NOT VALID while enforcing new writes. Tests cover repair followed by successful validation/rerun.

Locally verified that a put request which succeeds and then aborts rejects the save promise and retains the old document. Aborted queue deletion rejects and retains the operation. A mutation immediately changes Saved to Saving.

No complete new modeling feature, mobile redesign or measured performance improvement is claimed. Existing formats, renderer, local-first storage and integrations are preserved. RLS remains enabled. The invite function and frontend named argument contract are unchanged.

## Verification

| Check | Result |
|---|---|
| Baseline typecheck/build | Passed |
| Baseline test suite | 59 passed |
| Final typecheck | Passed |
| Final unit/PostgreSQL suite | 72 passed across 6 files |
| Final production build | Passed |
| npm install audit | Zero vulnerabilities reported |
| Production static preview | Running on 0.0.0.0:4174, /3d/ |
| HTTP index, manifest, service worker | Successful curl requests |
| Browser test suite | Blocked: all 6 failed at browser launch; no app assertions executed |
| Browser installation | Failed: cdn.playwright.dev TLS ECONNRESET |
| Mobile portrait/landscape | Not verified |
| Real auth/invite/collaboration/GitHub | Not verified |
| Full golden-path acceptance | NOT PASSED / incomplete |

PGlite runs real PostgreSQL SQL with managed Supabase auth/storage/realtime primitives stubbed. Existing sync/auth unit tests use mocked HTTP. Neither establishes live Supabase behavior. Public frontend configuration does not grant database-admin access to inspect deployed pg_proc. The exact inspection SQL and reload command are in DEPLOYMENT.md.

## Commands used for installation and verification

```sh
npm install
npm run typecheck
npm test
npm run build
npm install --save-dev fake-indexeddb
npm run supabase:setup
npx playwright install chromium
npm run test:pages
npm run preview:pages
curl -fsS http://localhost:4174/3d/
curl -fsS http://localhost:4174/3d/manifest.webmanifest
curl -fsS http://localhost:4174/3d/sw.js
git diff --check
```

The localhost requests above are sandbox-side HTTP checks, not browser-facing service URLs. The preview is exposed through Arena's proxy.

## Commits

Both implementation commits are on `arena/01a08151-3d`:

- `25d3b60062ab98c9e8f0488353d1754a17322b0e` — Harden scene/project integrity with non-destructive upgrade and regression tests.
- `dff98c8318ee2fd32328fa74b557b449217fb2df` — Acknowledge local writes only after transaction commit and invalidate saved state.

Commands: `git add` the related files followed by `git commit -m` with the messages above. No push or PR created.

## Remaining priorities

1. Atomic local snapshot + queue persistence, version-safe queue acknowledgement, retry/backoff and crash recovery. The present change fixes transaction acknowledgements, not the complete save lifecycle.
2. Transactional cloud snapshot saves with revision/conflict checks; current multi-request saves can partially apply or overwrite concurrent edits.
3. Idempotent provisioning/reconnect and truthful save notifications on all failure paths.
4. Invite-code confidentiality, removal/ban tombstones and real deployed RPC/invite verification.
5. Remaining parent/material/asset/animation-object integrity constraints and reviewed cleanup of any historical violations.
6. Conflict-safe undo, GLB animation export, asynchronous routing/cleanup review, mobile testing, and the rest of the roadmap.

Existing installations must apply only missing migrations in order, never rerun fresh setup. Back up first; index creation and validation can take locks. Resolve any legacy-data warnings and confirm all three constraints are validated before declaring historical project isolation clean.
