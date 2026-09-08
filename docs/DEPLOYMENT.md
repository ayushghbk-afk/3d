# Finish GitHub Pages + Supabase setup

## Already configured in the code

- Site: **https://ayushghbk-afk.github.io/3d/**
- Supabase project: **https://xzlimjmnspjmqjyqqxam.supabase.co**
- `.env.production` contains the supplied **public publishable key**. No GitHub secret is required for this deployment.
- GitHub Actions builds and tests the app, then publishes **`dist/`**, not the TypeScript source.
- Hash routes, lazy editor assets, the manifest and the service worker work inside `/3d/`.
- Email confirmation and magic links return to the app's directory.

**Code changes do not automatically configure your Supabase database or dashboard settings. Complete the steps below. Never send a service-role key, secret key or database password.**

## 1. GitHub Pages: one setting, then merge

1. Open [Repository Settings → Pages](https://github.com/ayushghbk-afk/3d/settings/pages).
2. Under **Build and deployment → Source**, select **GitHub Actions**.
   Do **not** select “Deploy from a branch / main / root”: that serves source files without building them.
3. Merge the fix into `main`.
4. Open [Actions](https://github.com/ayushghbk-afk/3d/actions) and wait for **Build and deploy GitHub Pages** to finish.
5. Open **https://ayushghbk-afk.github.io/3d/**.

The workflow deploys only `main`. Pull requests run the same checks but never replace the live site. After the workflow exists on `main`, **Run workflow** on `main` can retry a deployment.

The connected GitHub app could read this repository's Pages settings but received HTTP 403 when attempting to change them. The repository owner must make the Source selection above.

## 2. Supabase: create the app database

Open the [SQL editor for your project](https://supabase.com/dashboard/project/xzlimjmnspjmqjyqqxam/sql/new).

### Fresh project / no Studio tables yet

Copy the **entire** contents of [`supabase/setup.sql`](../supabase/setup.sql) into a new SQL query and click **Run** once.

This creates all tables, permission helpers, Row Level Security policies, asset/thumbnail buckets, invite handling and private Realtime policies in one transaction. It does not require you to disable RLS.

### Already ran an earlier Studio setup

Do **not** rerun the initial schema or delete any tables. Apply only the migrations you have not already run, in this order:

1. [`20260908000000_init.sql`](../supabase/migrations/20260908000000_init.sql) — fresh databases only.
2. [`20260908000001_invites.sql`](../supabase/migrations/20260908000001_invites.sql).
3. [`20260908000002_materials_textures.sql`](../supabase/migrations/20260908000002_materials_textures.sql).
4. [`20260908000003_cloud_repairs.sql`](../supabase/migrations/20260908000003_cloud_repairs.sql) — the new repair, safe to rerun.

If the first three were already installed successfully, run **only number 4**. If setup previously failed halfway and you see “relation already exists,” stop and share the exact error/table name; do not drop existing data to force it through.

The CLI can also apply these migrations with `supabase db push` after you have linked the project locally. Keep database credentials outside this repository.

## 3. Supabase Auth: allow the Pages return URL

Open [Authentication → URL Configuration](https://supabase.com/dashboard/project/xzlimjmnspjmqjyqqxam/auth/url-configuration).

Set **Site URL** to:

```text
https://ayushghbk-afk.github.io/3d/
```

Add the same exact URL to **Redirect URLs**:

```text
https://ayushghbk-afk.github.io/3d/
```

Save. Keep the trailing `/`; do not add `#/login` or remove `/3d/`.

Under **Authentication → Sign In / Providers → Email**, enable Email sign-in. Email confirmations can remain enabled: the app now tells users to check their email instead of incorrectly treating signup as an active session.

For real email-flow tests from another deployment, add its exact app-directory URL to Redirect URLs too. Examples for local development:

```text
http://localhost:5173/
http://localhost:4174/3d/
```

Keep the production Site URL unchanged. For an Arena live preview, allow only that exact preview URL plus `/3d/`, not a wildcard covering every preview host.

If emails do not arrive, check spam, Supabase Auth logs and the project's email/SMTP sending restrictions. A browser public key cannot change those settings.

## 4. Verify the live setup

1. Sign up on the Pages site. Confirm the email, then sign in.
2. Create a project, add a cube and wait for **✓ Saved**.
3. Refresh. Then sign in in a separate browser/device and open the same project.
4. In a team project, enable an invite link and join from another account. New members are viewers; the owner/admin can promote them to editor.
5. Import a model or texture, save, and verify it from the second browser. Repeated thumbnail/asset uploads should work, not only the first upload.

**Local** means the project is saved on this device, not yet in Supabase. **Error** includes a detailed explanation on the save badge; projects remain accessible locally if cloud setup is incomplete.

## Configuration reference

This is **Vite**, not Next.js. Use these names:

| Vite setting | Value |
|---|---|
| `VITE_SUPABASE_URL` | Supabase Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` browser key |
| `VITE_SUPABASE_ANON_KEY` | Optional older `anon` JWT alternative |

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` alone will not configure this app. The values supplied in chat have already been mapped to the correct Vite names in `.env.production`.

To use another project, replace the public values in `.env.production`, or set **both** Vite settings under **Repository Settings → Secrets and variables → Actions → Variables**. The workflow only applies overrides when a full URL/key pair is provided. Rebuild/redeploy after changes; GitHub Pages has no runtime environment-variable server.

For local development, copy `.env.example` to ignored `.env.local`. Empty settings keep `npm run dev` in local mode. Production uses `.env.production`; an ignored `.env.production.local` can override it for local production testing.

Never use `sb_secret_…` or a `service_role` JWT in any frontend setting. The build rejects those keys in the Supabase configuration. Public keys being visible in browser JavaScript is normal; database/storage/private-Realtime policies are the security boundary.

## Checks included in this fix

```bash
npm ci
npm test                   # config/auth/sync tests + PostgreSQL migration/RLS tests
npm run build              # typecheck and static production build
npx playwright install --with-deps chromium
npm run test:pages         # real browser, plain /3d/ static server, no SPA rewrites
npm run preview:pages      # Pages-like preview on :4174/3d/
```

Browser tests cover nested-path assets, editor refresh/offline reopening, email-return URLs, confirmation messaging and local fallback on cloud errors. Auth responses in these tests are mocked; they never create real accounts or send emails. Database tests run the actual setup SQL in local PostgreSQL via PGlite, with managed Supabase primitives stubbed.

Live Supabase requests could not be verified from the editing sandbox (outbound TLS connections to Supabase failed). This is **not** evidence that your key is invalid. The live checks above still need to be completed after the dashboard setup.

`supabase/setup.sql` is generated from the migrations. After editing migrations, run `npm run supabase:setup`; the tests reject a stale setup file.

## Scene/project integrity upgrade (20260908000004)

On existing installations apply only missing migrations, in filename order,
including `20260908000004_scene_project_integrity.sql`. **Do not run setup.sql
or the initial migration again.** Back up first and use a maintenance window:
creating the composite index and validating existing data can take locks.

The upgrade rejects new mismatched scene/project references in scene_objects,
materials and animations. It does not delete or reassign legacy rows. If it emits
a legacy-data warning, those historical inconsistencies remain until reviewed.
Find them in the SQL editor (repeat for materials and animations):

```sql
select o.id, o.scene_id, o.project_id, s.project_id as scene_project_id
from public.scene_objects o
left join public.scenes s on s.id = o.scene_id
where o.scene_id is not null
  and (s.id is null or o.project_id is distinct from s.project_id);
```

Review each row's intended ownership with the affected project owners; do not
blindly change project IDs or delete rows. After a reviewed repair:

```sql
alter table public.scene_objects validate constraint scene_objects_scene_project_fkey;
alter table public.materials validate constraint materials_scene_project_fkey;
alter table public.animations validate constraint animations_scene_project_fkey;

select conname, convalidated from pg_constraint
where conname in ('scene_objects_scene_project_fkey',
                  'materials_scene_project_fkey', 'animations_scene_project_fkey');
```

All three must report `convalidated = true` before declaring legacy integrity
clean. New writes are checked even while a constraint is NOT VALID. Parent,
asset, material and animation-object references require a further integrity pass.

### Verify the deployed invite contract, not argument-order guesses

Run with database-admin access, not the public browser key:

```sql
select n.nspname, p.proname,
       pg_get_function_identity_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid) as result
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'join_project';

notify pgrst, 'reload schema';
```

The frontend expects the names `p_project_id uuid, p_code text`, returning void.
Resolve unexpected overloads deliberately; do not reverse frontend arguments.
Test a valid invite with a separate real account, invalid/disabled codes and
existing owner/admin membership. Removed-member bans and restricted invite-code
reads are not implemented yet; rotate the invite after member removal as an
interim operational precaution, not as a substitute for a ban model.
