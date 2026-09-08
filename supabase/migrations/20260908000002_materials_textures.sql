-- Materials v2: double-sided, flat shading, base-color texture map.
alter table public.materials add column if not exists side text not null default 'front';
alter table public.materials add column if not exists flat_shading boolean not null default false;
alter table public.materials add column if not exists map_asset_id uuid;
