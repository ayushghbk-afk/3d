-- Storage-bucket repair for installations where the schema applied but the
-- storage buckets did not. The editor's save badge then reads "✕ Error" and the
-- server's own message is "Bucket not found" (NoSuchBucket): every durable push
-- uploads a project thumbnail, and imports / mesh rewrites / AI models upload
-- into `assets`, so nothing can be stored in the cloud at all.
--
-- Diagnose first: in the editor click the save badge (or ⌘K → Cloud
-- Diagnostics). A `✕ Storage upload … NoSuchBucket — Bucket not found` line
-- with a green "Database tables" line is exactly this state — the tables came
-- from init.sql but the `insert into storage.buckets` rows are absent.
--
-- This migration is idempotent: safe to rerun on any installation, and it never
-- deletes objects.

-- 1) Guarantee both buckets exist with the visibility the app depends on.
--    `assets` MUST stay private (its objects are gated by RLS policies below);
--    `thumbnails` MUST be public because the editor stores the returned
--    getPublicUrl() on projects.thumbnail_url and the dashboard renders it
--    straight into an <img>.
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('thumbnails', 'thumbnails', true)
on conflict (id) do update set public = excluded.public;

-- 2) Re-declare every storage policy, so an installation that created the
--    buckets by hand in the dashboard (which adds no policies) is complete too.
--    Uploads use upsert:true, so UPDATE policies are required, not just INSERT.

drop policy if exists "assets read" on storage.objects;
create policy "assets read" on storage.objects for select to authenticated
  using (bucket_id = 'assets' and public.is_project_member((storage.foldername(name))[1]::uuid));

drop policy if exists "assets write" on storage.objects;
create policy "assets write" on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "assets update" on storage.objects;
create policy "assets update" on storage.objects for update to authenticated
  using (bucket_id = 'assets' and public.can_edit_project((storage.foldername(name))[1]::uuid))
  with check (bucket_id = 'assets' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "assets delete" on storage.objects;
create policy "assets delete" on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "thumbs public read" on storage.objects;
create policy "thumbs public read" on storage.objects for select
  using (bucket_id = 'thumbnails');

drop policy if exists "thumbs write" on storage.objects;
create policy "thumbs write" on storage.objects for insert to authenticated
  with check (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "thumbs update" on storage.objects;
create policy "thumbs update" on storage.objects for update to authenticated
  using (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid))
  with check (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "thumbs delete" on storage.objects;
create policy "thumbs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid));
