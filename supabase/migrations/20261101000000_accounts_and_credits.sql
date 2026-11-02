-- Sociai accounts: credit balances, an append-only credit ledger, and job records.
--
-- Users may read their own rows (row-level security) and never write them. Every
-- write goes through the security-definer functions at the bottom, which only the
-- server may call (with the service-role key).
--
-- Credit rules: 1 credit = one research run plus up to 3 drafts or revisions for
-- that project. A failed research run is refunded. New users get 2 free credits.

-- ───────── Tables ─────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  credits integer not null default 0 check (credits >= 0),
  signup_ip text,           -- IP seen on the account's first API call
  activated_at timestamptz, -- when the server first saw this account
  blocked_reason text,      -- 'disposable_email' | 'too_many_accounts'
  created_at timestamptz not null default now()
);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  delta integer not null,
  reason text not null,     -- 'signup_bonus' | 'research' | 'refund' | 'purchase' ...
  project_id text,
  job_id uuid,
  stripe_event_id text unique, -- set by future Stripe webhooks so an event is credited once
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  project_id text not null,
  kind text not null check (kind in ('research', 'draft')),
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  charged boolean not null default false,  -- a credit was taken for this job
  refunded boolean not null default false,
  usage jsonb,                             -- tokens, web calls and estimated cost
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_user_status_idx on public.jobs (user_id, status);
create index jobs_project_idx on public.jobs (user_id, project_id, kind);
create index jobs_created_idx on public.jobs (created_at);

-- ───────── Row-level security: read your own rows, write nothing ─────────

alter table public.profiles enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.jobs enable row level security;

create policy "Users can read their own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "Users can read their own ledger" on public.credit_ledger
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can read their own jobs" on public.jobs
  for select to authenticated using ((select auth.uid()) = user_id);

-- Belt and braces: no write privileges for browser roles even if a policy is added later.
revoke all on public.profiles, public.credit_ledger, public.jobs from anon;
revoke insert, update, delete, truncate on public.profiles, public.credit_ledger, public.jobs from authenticated;

-- ───────── New users: profile + 2 free credits ─────────

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, credits) values (new.id, new.email, 2);
  insert into public.credit_ledger (user_id, delta, reason) values (new.id, 2, 'signup_bonus');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users who signed up before this migration get the same start.
insert into public.profiles (id, email, credits)
  select id, email, 2 from auth.users on conflict (id) do nothing;
insert into public.credit_ledger (user_id, delta, reason)
  select p.id, 2, 'signup_bonus' from public.profiles p
  where not exists (select 1 from public.credit_ledger l where l.user_id = p.id);

-- ───────── Server functions (service role only) ─────────

-- Refund a charged job once. Caller must hold the user's profile row lock.
create function public.sociai_refund(p_job uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs set refunded = true
    where id = p_job and charged and not refunded returning * into j;
  if found then
    update public.profiles set credits = credits + 1 where id = j.user_id;
    insert into public.credit_ledger (user_id, delta, reason, project_id, job_id)
      values (j.user_id, 1, 'refund', j.project_id, j.id);
  end if;
end $$;

-- First API call from an account: record its IP and apply the sign-up abuse rules.
-- Returns {credits, blocked_reason}. Safe to call on every request.
create function public.sociai_activate(p_user uuid, p_ip text, p_disposable boolean, p_max_per_ip integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
  reason text;
begin
  select * into prof from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('error', 'no_profile');
  end if;
  if prof.activated_at is null then
    if p_disposable then
      reason := 'disposable_email';
    elsif p_ip is not null then
      -- Serialize activations from one IP so concurrent sign-ups can't slip past the count.
      perform pg_advisory_xact_lock(hashtext('sociai_ip:' || p_ip));
      if (select count(*) from public.profiles
          where signup_ip = p_ip and id <> p_user and activated_at > now() - interval '1 day') >= p_max_per_ip then
        reason := 'too_many_accounts';
      end if;
    end if;
    update public.profiles set activated_at = now(), signup_ip = p_ip, blocked_reason = reason
      where id = p_user returning * into prof;
  end if;
  return jsonb_build_object('credits', prof.credits, 'blocked_reason', prof.blocked_reason);
end $$;

-- Start a research or draft job, enforcing every limit in one transaction.
-- Research takes 1 credit; each finished research run allows 3 drafts for its project.
-- Returns {job_id, credits, drafts_left} or {error: code}.
create function public.sociai_start_job(
  p_user uuid, p_project text, p_kind text, p_max_running integer, p_global_daily integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
  stale record;
  new_job uuid;
  allowance integer;
  used integer;
begin
  if p_kind not in ('research', 'draft') then
    return jsonb_build_object('error', 'bad_kind');
  end if;
  select * into prof from public.profiles where id = p_user for update;
  if not found or prof.activated_at is null then
    return jsonb_build_object('error', 'not_activated');
  end if;
  if prof.blocked_reason is not null then
    return jsonb_build_object('error', 'blocked', 'reason', prof.blocked_reason);
  end if;

  -- Jobs stuck "running" for 15 minutes died with a server restart: close them, refund research.
  for stale in
    select id from public.jobs
    where user_id = p_user and status = 'running' and created_at < now() - interval '15 minutes'
  loop
    update public.jobs set status = 'error', finished_at = now() where id = stale.id;
    perform public.sociai_refund(stale.id);
  end loop;
  select * into prof from public.profiles where id = p_user;

  if (select count(*) from public.jobs where user_id = p_user and status = 'running') >= p_max_running then
    return jsonb_build_object('error', 'too_many_running');
  end if;

  perform pg_advisory_xact_lock(hashtext('sociai_global_daily'));
  if (select count(*) from public.jobs
      where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') >= p_global_daily then
    return jsonb_build_object('error', 'global_limit');
  end if;

  if p_kind = 'research' then
    if prof.credits < 1 then
      return jsonb_build_object('error', 'no_credits', 'credits', prof.credits);
    end if;
    update public.profiles set credits = credits - 1 where id = p_user returning * into prof;
    insert into public.jobs (user_id, project_id, kind, charged)
      values (p_user, p_project, 'research', true) returning id into new_job;
    insert into public.credit_ledger (user_id, delta, reason, project_id, job_id)
      values (p_user, -1, 'research', p_project, new_job);
    return jsonb_build_object('job_id', new_job, 'credits', prof.credits);
  end if;

  select 3 * count(*) into allowance from public.jobs
    where user_id = p_user and project_id = p_project and kind = 'research' and status = 'done';
  select count(*) into used from public.jobs
    where user_id = p_user and project_id = p_project and kind = 'draft' and status in ('running', 'done');
  if allowance = 0 then
    return jsonb_build_object('error', 'no_research', 'credits', prof.credits);
  end if;
  if used >= allowance then
    return jsonb_build_object('error', 'draft_limit', 'credits', prof.credits);
  end if;
  insert into public.jobs (user_id, project_id, kind) values (p_user, p_project, 'draft') returning id into new_job;
  return jsonb_build_object('job_id', new_job, 'credits', prof.credits, 'drafts_left', allowance - used - 1);
end $$;

-- Record how a job ended. A failed research run gets its credit back.
create function public.sociai_finish_job(p_job uuid, p_status text, p_usage jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  j public.jobs;
  balance integer;
begin
  if p_status not in ('done', 'error') then
    return jsonb_build_object('error', 'bad_status');
  end if;
  select user_id into owner from public.jobs where id = p_job;
  if owner is null then
    return jsonb_build_object('error', 'no_job');
  end if;
  perform 1 from public.profiles where id = owner for update; -- same lock order as sociai_start_job
  update public.jobs set status = p_status, finished_at = now(), usage = p_usage
    where id = p_job and status = 'running' returning * into j;
  if not found then
    return jsonb_build_object('error', 'not_running');
  end if;
  if j.kind = 'research' and p_status = 'error' then
    perform public.sociai_refund(j.id);
  end if;
  select credits into balance from public.profiles where id = owner;
  return jsonb_build_object('credits', balance);
end $$;

-- Only the server may call these. (Postgres grants EXECUTE to PUBLIC by default.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.sociai_refund(uuid) from public, anon, authenticated;
revoke execute on function public.sociai_activate(uuid, text, boolean, integer) from public, anon, authenticated;
revoke execute on function public.sociai_start_job(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.sociai_finish_job(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.sociai_activate(uuid, text, boolean, integer) to service_role;
grant execute on function public.sociai_start_job(uuid, text, text, integer, integer) to service_role;
grant execute on function public.sociai_finish_job(uuid, text, jsonb) to service_role;
