-- Repair existing installations as well as fresh databases. No user data is deleted.

-- SECURITY DEFINER helpers must not inherit a caller-controlled search_path.
alter function public.is_project_member(uuid) set search_path = '';
alter function public.project_role(uuid) set search_path = '';
alter function public.can_edit_project(uuid) set search_path = '';
alter function public.can_admin_project(uuid) set search_path = '';
alter function public.touch_updated_at() set search_path = '';

-- Project ownership is authoritative, even if a stale membership row has another role.
create or replace function public.project_role(p_project_id uuid)
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select case when exists (
    select 1 from public.projects p where p.id = p_project_id and p.owner_id = auth.uid()
  ) then 'owner' else (
    select nullif(m.role, 'owner') from public.project_members m
    where m.project_id = p_project_id and m.user_id = auth.uid()
    limit 1
  ) end;
$$;

-- INSERT ... RETURNING checks SELECT policy before a STABLE helper can see the
-- newly inserted project. Check the owner directly on the new row as well.
drop policy if exists "projects member read" on public.projects;
create policy "projects member read" on public.projects for select to authenticated
  using (owner_id = auth.uid() or public.is_project_member(id));

-- Existing uploads use upsert:true, which needs UPDATE as well as INSERT/SELECT.
drop policy if exists "assets edit update" on public.assets;
create policy "assets edit update" on public.assets for update to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

drop policy if exists "assets update" on storage.objects;
create policy "assets update" on storage.objects for update to authenticated
  using (bucket_id = 'assets' and public.can_edit_project((storage.foldername(name))[1]::uuid))
  with check (bucket_id = 'assets' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "thumbs update" on storage.objects;
create policy "thumbs update" on storage.objects for update to authenticated
  using (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid))
  with check (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid));

drop policy if exists "thumbs delete" on storage.objects;
create policy "thumbs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'thumbnails' and public.can_edit_project((storage.foldername(name))[1]::uuid));

-- SQL NULL comparisons do not return true: explicitly reject a missing code.
create or replace function public.join_project(p_project_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select invite_code into v_code from public.projects where id = p_project_id;
  if v_code is null or v_code = '' then
    raise exception 'Invites are disabled for this project';
  end if;
  if p_code is null or p_code = '' or v_code is distinct from p_code then
    raise exception 'Invalid invite code';
  end if;
  update public.projects set mode = 'team' where id = p_project_id and mode = 'solo';
  insert into public.project_members (project_id, user_id, role)
  values (p_project_id, auth.uid(), 'viewer')
  on conflict (project_id, user_id) do nothing;
end;
$$;
revoke all on function public.join_project(uuid, text) from public, anon;
grant execute on function public.join_project(uuid, text) to authenticated;

-- Editing a scene must not let an editor take ownership or rotate admin invite codes.
create or replace function public.guard_project_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    if new.owner_id is distinct from old.owner_id or new.id is distinct from old.id then
      raise exception 'Project ownership and id cannot be changed by the client';
    end if;
    if new.invite_code is distinct from old.invite_code and not public.can_admin_project(old.id) then
      raise exception 'Only owners and admins can change invites';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists projects_guard_identity on public.projects;
create trigger projects_guard_identity before update on public.projects
  for each row execute function public.guard_project_identity();

-- Realtime is a separate permission boundary from the public table policies.
-- The client uses private project:<uuid> channels; outsiders cannot read/broadcast.
create or replace function public.realtime_project_id(p_topic text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_topic !~ '^project:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  return split_part(p_topic, ':', 2)::uuid;
end;
$$;

drop policy if exists "studio project realtime read" on realtime.messages;
create policy "studio project realtime read" on realtime.messages for select to authenticated
  using (
    extension in ('broadcast', 'presence')
    and public.is_project_member(public.realtime_project_id(realtime.topic()))
  );

drop policy if exists "studio project realtime write" on realtime.messages;
create policy "studio project realtime write" on realtime.messages for insert to authenticated
  with check (
    (extension = 'broadcast' and public.can_edit_project(public.realtime_project_id(realtime.topic())))
    or (extension = 'presence' and public.is_project_member(public.realtime_project_id(realtime.topic())))
  );

-- Explicit grants make setup work on projects without Supabase's legacy defaults.
-- RLS remains enabled; an API grant does not bypass a policy.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles, public.projects, public.project_members, public.scenes,
  public.scene_objects, public.folders, public.assets, public.models,
  public.materials, public.textures, public.animations, public.animation_tracks,
  public.keyframes, public.project_versions, public.project_changes
  to authenticated;
grant execute on function public.is_project_member(uuid), public.project_role(uuid),
  public.can_edit_project(uuid), public.can_admin_project(uuid), public.realtime_project_id(text)
  to authenticated;

notify pgrst, 'reload schema';
