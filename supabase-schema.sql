create table if not exists public.presentation_projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  script text not null default '',
  important_map jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.presentation_projects enable row level security;

create policy "Users can read own projects"
on public.presentation_projects for select
using (auth.uid() = user_id);

create policy "Users can insert own projects"
on public.presentation_projects for insert
with check (auth.uid() = user_id);

create policy "Users can update own projects"
on public.presentation_projects for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete own projects"
on public.presentation_projects for delete
using (auth.uid() = user_id);

create table if not exists public.presentation_recordings (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.presentation_projects(id) on delete set null,
  title text not null,
  storage_path text not null,
  mime_type text not null,
  extension text not null,
  seconds integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.presentation_recordings enable row level security;

create policy "Users can read own recordings"
on public.presentation_recordings for select
using (auth.uid() = user_id);

create policy "Users can insert own recordings"
on public.presentation_recordings for insert
with check (auth.uid() = user_id);

create policy "Users can delete own recordings"
on public.presentation_recordings for delete
using (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('presentation-recordings', 'presentation-recordings', false)
on conflict (id) do nothing;

create policy "Users can read own recording files"
on storage.objects for select
using (
  bucket_id = 'presentation-recordings'
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "Users can upload own recording files"
on storage.objects for insert
with check (
  bucket_id = 'presentation-recordings'
  and auth.uid()::text = (storage.foldername(name))[1]
);

create policy "Users can delete own recording files"
on storage.objects for delete
using (
  bucket_id = 'presentation-recordings'
  and auth.uid()::text = (storage.foldername(name))[1]
);

