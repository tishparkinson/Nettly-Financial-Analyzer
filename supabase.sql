create table if not exists public.profiles (
  user_id uuid primary key,
  email text,
  plan_status text not null default 'free',
  stripe_customer_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_history (
  user_id uuid primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_events (
  id bigserial primary key,
  stripe_event_id text not null unique,
  event_type text not null,
  customer_id text,
  user_id uuid,
  payload jsonb not null default '{}'::jsonb,
  processing_state text not null default 'received',
  processing_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.user_history enable row level security;
alter table public.billing_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'users_own_profile_read'
  ) then
    create policy users_own_profile_read on public.profiles
      for select using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'billing_events' and policyname = 'deny_client_billing_events'
  ) then
    create policy deny_client_billing_events on public.billing_events
      for all using (false) with check (false);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_history' and policyname = 'users_own_history_read'
  ) then
    create policy users_own_history_read on public.user_history
      for select using (auth.uid() = user_id);
  end if;
end $$;
