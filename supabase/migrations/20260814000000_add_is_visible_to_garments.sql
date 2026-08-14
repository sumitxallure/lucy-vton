alter table public.garments
add column if not exists is_visible boolean not null default true;

create index if not exists garments_is_visible_created_at_idx
on public.garments (is_visible, created_at desc);
