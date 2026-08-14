create table if not exists public.garments (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  image_path text not null unique,
  image_filename text not null,
  image_mime_type text not null,
  description_filename text,
  raw_description text not null,
  parsed_description jsonb not null,
  generated_prompt text not null,
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists garments_created_at_idx on public.garments (created_at desc);
create index if not exists garments_is_visible_created_at_idx on public.garments (is_visible, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_garments_updated_at on public.garments;
create trigger set_garments_updated_at
before update on public.garments
for each row
execute function public.set_updated_at();

alter table public.garments enable row level security;

drop policy if exists "Backend service key manages garments" on public.garments;
create policy "Backend service key manages garments"
on public.garments
for all
to service_role
using (true)
with check (true);
