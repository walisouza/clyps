-- Clyps — schema inicial
-- Tabelas: profiles, jobs, clips, credit_ledger
-- Buckets: uploads (vídeos enviados), clips (cortes renderizados)

create extension if not exists pgcrypto;

-- ───────────────────────── Perfis ─────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  credits integer not null default 0,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── Jobs ─────────────────────────
create type public.job_status as enum ('queued', 'processing', 'completed', 'failed', 'cancelled');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status public.job_status not null default 'queued',
  stage text,
  progress integer not null default 0 check (progress between 0 and 100),
  source_type text not null check (source_type in ('url', 'upload')),
  source_url text,
  storage_key text,
  title text,
  duration_seconds numeric,
  options jsonb not null default '{}'::jsonb,
  error text,
  credit_cost integer not null default 0,
  attempts integer not null default 0,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint jobs_source_present check (
    (source_type = 'url' and source_url is not null)
    or (source_type = 'upload' and storage_key is not null)
  )
);

create index jobs_user_created_idx on public.jobs (user_id, created_at desc);
create index jobs_queue_idx on public.jobs (status, created_at);

-- ───────────────────────── Clips ─────────────────────────
create table public.clips (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  idx integer not null,
  title text not null,
  reason text,
  score integer,
  start_ms integer not null,
  end_ms integer not null,
  transcript text,
  storage_key text not null,
  aspect text not null,
  created_at timestamptz not null default now(),
  unique (job_id, idx)
);

create index clips_job_idx on public.clips (job_id, idx);

-- ───────────────────────── Créditos (preparado para SaaS) ─────────────────────────
create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  delta integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

-- ───────────────────────── RLS ─────────────────────────
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.clips enable row level security;
alter table public.credit_ledger enable row level security;

create policy "profiles: ler o próprio" on public.profiles
  for select to authenticated using (id = auth.uid());

create policy "profiles: editar o próprio" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- O usuário só pode alterar o nome; créditos só mudam pelo servidor.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "jobs: ler os próprios" on public.jobs
  for select to authenticated using (user_id = auth.uid());

-- O usuário só cria jobs na fila; status, progresso e custo são do worker.
create policy "jobs: criar na fila" on public.jobs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'queued'
    and progress = 0
    and credit_cost = 0
    and attempts = 0
  );

create policy "clips: ler os próprios" on public.clips
  for select to authenticated using (user_id = auth.uid());

create policy "ledger: ler o próprio" on public.credit_ledger
  for select to authenticated using (user_id = auth.uid());

-- ───────────────────────── Fila ─────────────────────────
-- O worker (service role) chama esta função para pegar o próximo job.
-- Jobs travados há mais de 45 min voltam para a fila (até 3 tentativas).
create or replace function public.claim_next_job()
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.jobs;
begin
  update public.jobs
     set status = 'failed',
         error = 'Processamento interrompido após 3 tentativas.',
         completed_at = now()
   where status = 'processing'
     and locked_at < now() - interval '45 minutes'
     and attempts >= 3;

  select * into j
    from public.jobs
   where status = 'queued'
      or (status = 'processing' and locked_at < now() - interval '45 minutes' and attempts < 3)
   order by created_at
   for update skip locked
   limit 1;

  if not found then
    return;
  end if;

  update public.jobs
     set status = 'processing',
         stage = 'starting',
         progress = 0,
         attempts = attempts + 1,
         locked_at = now(),
         started_at = coalesce(started_at, now()),
         error = null
   where id = j.id
  returning * into j;

  return next j;
end $$;

revoke all on function public.claim_next_job() from public, anon, authenticated;
grant execute on function public.claim_next_job() to service_role;

-- Débito/crédito atômico. delta negativo exige saldo suficiente.
create or replace function public.adjust_credits(p_user uuid, p_job uuid, p_delta integer, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set credits = credits + p_delta
   where id = p_user
     and credits + p_delta >= 0;

  if not found then
    return false;
  end if;

  insert into public.credit_ledger (user_id, job_id, delta, reason)
  values (p_user, p_job, p_delta, p_reason);

  return true;
end $$;

revoke all on function public.adjust_credits(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.adjust_credits(uuid, uuid, integer, text) to service_role;

-- A função do gatilho não deve ser chamável pela API.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ───────────────────────── Storage ─────────────────────────
insert into storage.buckets (id, name, public, allowed_mime_types)
values
  ('uploads', 'uploads', false, array['video/mp4', 'video/quicktime', 'video/webm']),
  ('clips', 'clips', false, array['video/mp4'])
on conflict (id) do nothing;

-- Arquivos ficam em <user_id>/...; cada usuário só enxerga a própria pasta.
create policy "uploads: enviar na própria pasta" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "uploads: ler a própria pasta" on storage.objects
  for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "clips: ler a própria pasta" on storage.objects
  for select to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);
