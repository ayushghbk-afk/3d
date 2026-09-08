-- Additive upgrade; apply after 00003. Never deletes or reassigns user data.
-- NOT VALID enforces new writes immediately while allowing an installation with
-- legacy inconsistent rows to upgrade. Validate after operator-reviewed repair
-- (see docs/DEPLOYMENT.md). Clean installations validate automatically below.
create unique index if not exists scenes_id_project_unique
  on public.scenes(id, project_id);

do $$
declare
  t text;
  constraint_name text;
begin
  foreach t in array array['scene_objects', 'materials', 'animations'] loop
    constraint_name := t || '_scene_project_fkey';
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', t)::regclass and conname = constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (scene_id, project_id) references public.scenes(id, project_id) on delete cascade not valid',
        t, constraint_name
      );
    end if;
    -- Each validation runs in a subtransaction. Invalid legacy rows are retained;
    -- the constraint remains installed and protects all subsequent writes.
    begin
      execute format('alter table public.%I validate constraint %I', t, constraint_name);
    exception when foreign_key_violation then
      raise warning '% has inconsistent legacy rows; review and validate %', t, constraint_name;
    end;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
