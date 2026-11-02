-- Sociai payments (Stripe Checkout): one Stripe customer per user, and credits granted from
-- Stripe webhooks exactly once per event, using the unique credit_ledger.stripe_event_id.

alter table public.profiles add column stripe_customer_id text unique;  -- set by the server only

-- The user's billing customer, if any (server only).
create function public.sociai_get_customer(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('customer', stripe_customer_id, 'email', email)
  from public.profiles where id = p_user
$$;

-- Remember the user's Stripe customer. If one is already stored (two checkouts racing),
-- the stored one wins and is returned, so every user keeps a single customer.
create function public.sociai_set_customer(p_user uuid, p_customer text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare stored text;
begin
  update public.profiles set stripe_customer_id = coalesce(stripe_customer_id, p_customer)
    where id = p_user returning stripe_customer_id into stored;
  return jsonb_build_object('customer', stored);
end $$;

create function public.sociai_user_for_customer(p_customer text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('user_id', id) from public.profiles where stripe_customer_id = p_customer
$$;

-- Add credits for a Stripe event, once. A repeated delivery of the same event changes nothing.
-- Returns {granted, credits}.
create function public.sociai_grant_credits(p_user uuid, p_delta integer, p_reason text, p_event text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  balance integer;
  new_row uuid;
begin
  if p_delta <= 0 or p_event is null then
    return jsonb_build_object('error', 'bad_grant');
  end if;
  perform 1 from public.profiles where id = p_user for update;
  if not found then
    return jsonb_build_object('error', 'no_profile');
  end if;
  insert into public.credit_ledger (user_id, delta, reason, stripe_event_id)
    values (p_user, p_delta, p_reason, p_event)
    on conflict (stripe_event_id) do nothing
    returning id into new_row;
  if new_row is not null then
    update public.profiles set credits = credits + p_delta where id = p_user;
  end if;
  select credits into balance from public.profiles where id = p_user;
  return jsonb_build_object('granted', new_row is not null, 'credits', balance);
end $$;

-- The Account page: balance, whether there's a billing account, and recent credit activity.
-- Runs as the user, so row-level security limits it to their own rows.
create function public.sociai_account() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'credits', p.credits,
    'has_billing', p.stripe_customer_id is not null,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('delta', l.delta, 'reason', l.reason, 'project_id', l.project_id,
                                          'created_at', l.created_at) order by l.created_at desc)
      from (select * from public.credit_ledger where user_id = p.id order by created_at desc limit 100) l), '[]'::jsonb))
  from public.profiles p where p.id = (select auth.uid())
$$;

revoke execute on function public.sociai_get_customer(uuid) from public, anon, authenticated;
revoke execute on function public.sociai_set_customer(uuid, text) from public, anon, authenticated;
revoke execute on function public.sociai_user_for_customer(text) from public, anon, authenticated;
revoke execute on function public.sociai_grant_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.sociai_account() from public, anon;
grant execute on function public.sociai_get_customer(uuid) to service_role;
grant execute on function public.sociai_set_customer(uuid, text) to service_role;
grant execute on function public.sociai_user_for_customer(text) to service_role;
grant execute on function public.sociai_grant_credits(uuid, integer, text, text) to service_role;
grant execute on function public.sociai_account() to authenticated;
