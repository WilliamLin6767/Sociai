-- The landing-page demo, the sign-up funnel counts, and where new accounts came from.
--
-- All three tables are server-only (service role): no browser role can read or write them, and
-- every change goes through the functions below. Nothing here touches credits or the existing
-- tables.
--
--   demo_runs           one row per landing-page demo (research + draft for a person the visitor
--                       named), kept so the full draft is waiting after they sign up. Only a hash
--                       of the visitor's IP is stored, and rows are cleared after 30 days.
--   events              daily counts per funnel step (landing_view, demo_used, signup_started,
--                       signup_done, first_draft, checkout, ...). Counts only, nothing per visitor.
--   signup_attribution  the utm_* values and whether an fbclid was present when a user first
--                       opened the app, one row per user, written once.

-- ───────── Demo runs ─────────

create table public.demo_runs (
  id uuid primary key,
  ip_hash text not null,
  target text not null check (char_length(target) <= 200),
  goal text not null check (char_length(goal) <= 300),
  purpose text not null default '' check (char_length(purpose) <= 20),
  dossier jsonb not null,
  draft jsonb not null,
  claimed_by uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index demo_runs_created_idx on public.demo_runs (created_at);

alter table public.demo_runs enable row level security;
revoke all on public.demo_runs from anon, authenticated;

create function public.sociai_save_demo(p_id uuid, p_ip_hash text, p_target text, p_goal text, p_purpose text,
                                        p_dossier jsonb, p_draft jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  -- Rows older than 30 days are of no use to anyone; clear them as new ones arrive.
  delete from public.demo_runs where created_at < now() - interval '30 days';
  insert into public.demo_runs (id, ip_hash, target, goal, purpose, dossier, draft)
    values (p_id, p_ip_hash, p_target, p_goal, coalesce(p_purpose, ''), p_dossier, p_draft)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- A user claims a demo once; the same user may fetch it again (e.g. after a refresh), nobody else.
create function public.sociai_claim_demo(p_id uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.demo_runs;
begin
  update public.demo_runs set claimed_by = p_user, claimed_at = coalesce(claimed_at, now())
    where id = p_id and (claimed_by is null or claimed_by = p_user)
    returning * into d;
  if not found then
    return null;
  end if;
  return jsonb_build_object('id', d.id, 'target', d.target, 'goal', d.goal, 'purpose', d.purpose,
                            'dossier', d.dossier, 'draft', d.draft, 'created_at', d.created_at);
end $$;

-- ───────── Funnel counts ─────────

create table public.events (
  day date not null,
  name text not null check (name ~ '^[a-z_]{1,40}$'),
  count integer not null default 0,
  primary key (day, name)
);
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;

create function public.sociai_count_event(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.events (day, name, count) values ((now() at time zone 'utc')::date, p_name, 1)
  on conflict (day, name) do update set count = public.events.count + 1;
  return jsonb_build_object('ok', true);
end $$;

-- The last p_days days, newest first: [{day, counts: {name: count, ...}}, ...]
create function public.sociai_funnel(p_days integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('day', day, 'counts', counts) order by day desc), '[]'::jsonb)
  from (select day, jsonb_object_agg(name, count) as counts
        from public.events
        where day >= (now() at time zone 'utc')::date - greatest(coalesce(p_days, 14) - 1, 0)
        group by day) d
$$;

-- ───────── Sign-up attribution ─────────

create table public.signup_attribution (
  user_id uuid primary key references auth.users (id) on delete cascade,
  utm_source text not null default '' check (char_length(utm_source) <= 64),
  utm_medium text not null default '' check (char_length(utm_medium) <= 64),
  utm_campaign text not null default '' check (char_length(utm_campaign) <= 64),
  fbclid boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.signup_attribution enable row level security;
revoke all on public.signup_attribution from anon, authenticated;

-- Written once per user; a second call changes nothing.
create function public.sociai_set_attribution(p_user uuid, p_source text, p_medium text, p_campaign text, p_fbclid boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare created uuid;
begin
  insert into public.signup_attribution (user_id, utm_source, utm_medium, utm_campaign, fbclid)
    values (p_user, coalesce(p_source, ''), coalesce(p_medium, ''), coalesce(p_campaign, ''), coalesce(p_fbclid, false))
  on conflict (user_id) do nothing
  returning user_id into created;
  return jsonb_build_object('recorded', created is not null);
end $$;

-- ───────── Only the server may call these ─────────

revoke execute on function public.sociai_save_demo(uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.sociai_claim_demo(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.sociai_count_event(text) from public, anon, authenticated;
revoke execute on function public.sociai_funnel(integer) from public, anon, authenticated;
revoke execute on function public.sociai_set_attribution(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sociai_save_demo(uuid, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.sociai_claim_demo(uuid, uuid) to service_role;
grant execute on function public.sociai_count_event(text) to service_role;
grant execute on function public.sociai_funnel(integer) to service_role;
grant execute on function public.sociai_set_attribution(uuid, text, text, text, boolean) to service_role;
