-- Invite links: owner/admin rotates a code; anyone with project id + code joins as viewer.
alter table public.projects add column if not exists invite_code text;

create or replace function public.join_project(p_project_id uuid, p_code text)
returns void
language plpgsql
security definer
as $$
declare
  v_code text;
  v_mode text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select invite_code, mode into v_code, v_mode
  from public.projects where id = p_project_id;
  if v_code is null or v_code = '' then
    raise exception 'Invites are disabled for this project';
  end if;
  if v_code != p_code then
    raise exception 'Invalid invite code';
  end if;
  if v_mode = 'solo' then
    update public.projects set mode = 'team' where id = p_project_id;
  end if;
  insert into public.project_members (project_id, user_id, role)
  values (p_project_id, auth.uid(), 'viewer')
  on conflict (project_id, user_id) do nothing;
end;
$$;
