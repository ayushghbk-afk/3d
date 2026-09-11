-- Invite-link repair for installations where the invites migration applied
-- only partially: public.projects.invite_code exists (so owners can mint
-- links) but the join_project RPC is missing or not executable by the
-- authenticated role. Every invite link then fails with
-- "Join failed: Could not find the function public.join_project…" (PGRST202)
-- and the project itself opens as "Failed to open project: Project not found"
-- because the invitee was never added as a member.
--
-- This migration is idempotent: safe to rerun on any installation.

-- 1) Guarantee the invite column exists even on half-applied installations.
alter table public.projects add column if not exists invite_code text;

-- 2) Recreate the join RPC with the exact contract the frontend calls:
--    join_project(p_project_id uuid, p_code text) returns void.
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

-- 3) Restore the standard Supabase baseline table grants. At least one
--    deployed installation lost them for public.profiles (HTTP 42501),
--    which breaks the members list and profile sync. Row Level Security
--    stays enabled on every table and continues to gate every row.
grant select on public.profiles to anon;
grant select, insert, update on public.profiles to authenticated;
grant select on
  public.projects, public.project_members, public.scenes, public.scene_objects,
  public.materials, public.textures, public.animations, public.animation_tracks,
  public.keyframes, public.assets, public.models, public.folders,
  public.project_versions, public.project_changes
  to anon;
grant select, insert, update, delete on
  public.projects, public.project_members, public.scenes, public.scene_objects,
  public.materials, public.textures, public.animations, public.animation_tracks,
  public.keyframes, public.assets, public.models, public.folders,
  public.project_versions, public.project_changes
  to authenticated;

-- 4) Make PostgREST see the (re)created function immediately.
notify pgrst, 'reload schema';
