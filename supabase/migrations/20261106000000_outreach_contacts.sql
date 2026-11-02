-- Outreach tracker: the people a user has written to (or plans to), entered by hand, with the
-- dates that matter: when it was sent, when they replied, and when to follow up.
--
-- These rows belong to the user, so row-level security lets each user read and change only
-- their own. The server calls PostgREST with the user's own access token, so the same rules
-- guard its requests. Nothing here reads an inbox or sends anything, and no credits are used.
--
-- Follow-up defaults (sent: +30 days for professors, +7 for recruiters, +10 otherwise; replied:
-- no follow-up) are applied by the server (sociai/tracker.py), so they stay editable. A "sent"
-- contact whose follow-up date has arrived is shown as follow_up_due without being rewritten.

create table public.outreach_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  email text not null default '' check (char_length(email) <= 320),
  role text not null default 'other' check (role in ('professor', 'recruiter', 'alum', 'other')),
  organization text not null default '' check (char_length(organization) <= 200),
  subject text not null default '' check (char_length(subject) <= 300),
  sent_at date,
  status text not null default 'drafted'
    check (status in ('drafted', 'sent', 'replied', 'no_reply', 'follow_up_due', 'closed')),
  replied_at date,
  follow_up_at date,
  notes text not null default '' check (char_length(notes) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outreach_contacts_user_idx on public.outreach_contacts (user_id, created_at desc);

-- updated_at changes on every edit; the owner can't be moved to another account.
create function public.sociai_touch_contact() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  return new;
end $$;
create trigger outreach_contacts_touch before update on public.outreach_contacts
  for each row execute function public.sociai_touch_contact();

-- Keep one account from filling the database.
create function public.sociai_cap_contacts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.outreach_contacts where user_id = new.user_id) >= 2000 then
    raise exception 'You can keep up to 2,000 contacts in your tracker. Delete some old ones first.';
  end if;
  return new;
end $$;
create trigger outreach_contacts_cap before insert on public.outreach_contacts
  for each row execute function public.sociai_cap_contacts();

revoke execute on function public.sociai_touch_contact() from public, anon, authenticated;
revoke execute on function public.sociai_cap_contacts() from public, anon, authenticated;

-- ───────── Row-level security: users read and write only their own rows ─────────

alter table public.outreach_contacts enable row level security;

create policy "Users read their own contacts" on public.outreach_contacts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own contacts" on public.outreach_contacts
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change their own contacts" on public.outreach_contacts
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own contacts" on public.outreach_contacts
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.outreach_contacts from anon;
grant select, insert, update, delete on public.outreach_contacts to authenticated;
