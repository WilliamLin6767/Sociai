-- Signed-in users always have a profile. Normally the sign-up trigger creates it, but if that
-- row is missing (for example the account existed before the trigger, or the insert failed),
-- the server's first call (sociai_activate) now creates it instead of failing with "no_profile".
--
-- One function holds the sign-up rules, used by both the trigger and sociai_activate:
-- 2 free credits and a 'signup_bonus' ledger row, or 0 credits if the email belongs to a
-- deleted account (deleted_accounts keeps a hash of it).

create function public.sociai_ensure_profile(p_user uuid, p_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  bonus integer := 2;
  created uuid;
begin
  if exists (select 1 from public.deleted_accounts
             where email_hash = encode(sha256(convert_to(lower(coalesce(p_email, '')), 'UTF8')), 'hex')) then
    bonus := 0;
  end if;
  insert into public.profiles (id, email, credits) values (p_user, p_email, bonus)
    on conflict (id) do nothing
    returning id into created;
  if created is not null and bonus > 0 then
    insert into public.credit_ledger (user_id, delta, reason) values (p_user, bonus, 'signup_bonus');
  end if;
  return created is not null;  -- true only for the call that created the row
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.sociai_ensure_profile(new.id, new.email);
  return new;
end $$;

-- As before, plus: a missing profile is created first. {error: 'no_user'} only if the auth user
-- itself is gone.
create or replace function public.sociai_activate(p_user uuid, p_ip text, p_disposable boolean, p_max_per_ip integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prof public.profiles;
  reason text;
  auth_email text;
begin
  select * into prof from public.profiles where id = p_user for update;
  if not found then
    select email into auth_email from auth.users where id = p_user;
    if not found then
      return jsonb_build_object('error', 'no_user');
    end if;
    perform public.sociai_ensure_profile(p_user, auth_email);
    select * into prof from public.profiles where id = p_user for update;
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

revoke execute on function public.sociai_ensure_profile(uuid, text) from public, anon, authenticated;
grant execute on function public.sociai_ensure_profile(uuid, text) to service_role;
