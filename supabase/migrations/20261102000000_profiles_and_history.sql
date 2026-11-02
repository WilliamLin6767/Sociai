-- Sociai profiles and saved history: what users tell Sociai about themselves (background,
-- defaults, writing samples, resume) and every project they work on, saved per account.
--
-- Unlike credits, these rows belong to the user, so users may change them, but only their own
-- (row-level security). The server sends the user's own access token for these calls, so the
-- same rules guard the server's requests. Resume files live in the private "resumes" Storage
-- bucket, in a folder named after the user's id.

-- ───────── Profile fields ─────────

alter table public.profiles
  add column background text not null default '' check (char_length(background) <= 20000),
  add column default_channel text not null default 'email'
    check (default_channel in ('email', 'linkedin', 'direct message')),
  add column default_max_words integer not null default 160 check (default_max_words between 40 and 600),
  add column resume_text text not null default '' check (char_length(resume_text) <= 30000),
  add column resume_path text,        -- set by the server only
  add column resume_filename text,    -- set by the server only
  add column resume_updated_at timestamptz,
  add column updated_at timestamptz not null default now();

create policy "Users can update their own profile" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- Only these columns. Credits, blocks and resume file details stay server-only.
grant update (background, default_channel, default_max_words, resume_text, updated_at)
  on public.profiles to authenticated;

-- ───────── Writing samples ─────────

create table public.writing_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 20000),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index writing_samples_user_idx on public.writing_samples (user_id, position);

-- ───────── Projects (one per outreach, the whole working state as JSON) ─────────

create table public.projects (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),  -- chosen by the browser
  name text not null default '' check (char_length(name) <= 300),
  summary jsonb not null default '{}'::jsonb,  -- what the Desk list shows
  data jsonb not null,                         -- request, research, corrections, threads, drafts
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (octet_length(data::text) <= 2000000)
);
create index projects_recent_idx on public.projects (user_id, updated_at desc);

-- Keep one account from filling the database.
create function public.sociai_enforce_caps() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'writing_samples'
     and (select count(*) from public.writing_samples where user_id = new.user_id) >= 10 then
    raise exception 'You can keep up to 10 writing samples.';
  end if;
  if tg_table_name = 'projects'
     and (select count(*) from public.projects where user_id = new.user_id) >= 500 then
    raise exception 'You can keep up to 500 projects. Delete some old ones first.';
  end if;
  return new;
end $$;
create trigger writing_samples_cap before insert on public.writing_samples
  for each row execute function public.sociai_enforce_caps();
create trigger projects_cap before insert on public.projects
  for each row execute function public.sociai_enforce_caps();

-- ───────── Row-level security: users read and write only their own rows ─────────

alter table public.writing_samples enable row level security;
alter table public.projects enable row level security;

create policy "Users manage their own writing samples" on public.writing_samples
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users manage their own projects" on public.projects
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.writing_samples, public.projects from anon;

-- ───────── Deleted accounts: no second round of free credits ─────────

-- Only a hash of the email address is kept, so the address itself is gone.
create table public.deleted_accounts (
  email_hash text primary key,
  deleted_at timestamptz not null default now()
);
alter table public.deleted_accounts enable row level security;
revoke all on public.deleted_accounts from anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare bonus integer := 2;
begin
  if exists (select 1 from public.deleted_accounts
             where email_hash = encode(sha256(convert_to(lower(coalesce(new.email, '')), 'UTF8')), 'hex')) then
    bonus := 0;
  end if;
  insert into public.profiles (id, email, credits) values (new.id, new.email, bonus);
  if bonus > 0 then
    insert into public.credit_ledger (user_id, delta, reason) values (new.id, bonus, 'signup_bonus');
  end if;
  return new;
end $$;

-- ───────── Functions the server calls with the user's own token (RLS applies) ─────────

create function public.sociai_get_profile() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'email', p.email, 'credits', p.credits, 'background', p.background,
    'default_channel', p.default_channel, 'default_max_words', p.default_max_words,
    'resume_text', p.resume_text, 'resume_filename', p.resume_filename,
    'resume_updated_at', p.resume_updated_at,
    'samples', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'body', s.body) order by s.position, s.created_at)
                         from public.writing_samples s where s.user_id = p.id), '[]'::jsonb))
  from public.profiles p where p.id = (select auth.uid())
$$;

-- Null arguments leave a field unchanged.
create function public.sociai_save_profile(p_background text, p_channel text, p_max_words integer, p_resume_text text)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  update public.profiles set
    background = coalesce(p_background, background),
    default_channel = coalesce(p_channel, default_channel),
    default_max_words = coalesce(p_max_words, default_max_words),
    resume_text = coalesce(p_resume_text, resume_text),
    updated_at = now()
  where id = (select auth.uid());
  return public.sociai_get_profile();
end $$;

-- Replace all of the user's samples with this list, in order (blank ones are dropped).
create function public.sociai_replace_samples(p_bodies text[]) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce(array_length(p_bodies, 1), 0) > 10 then
    raise exception 'You can keep up to 10 writing samples.';
  end if;
  delete from public.writing_samples where user_id = (select auth.uid());
  insert into public.writing_samples (user_id, body, position)
    select (select auth.uid()), b, i::integer
    from unnest(p_bodies) with ordinality as t(b, i) where btrim(b) <> '';
  return public.sociai_get_profile();
end $$;

create function public.sociai_save_project(p_id text, p_name text, p_summary jsonb, p_data jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare saved timestamptz;
begin
  insert into public.projects (user_id, id, name, summary, data)
    values ((select auth.uid()), p_id, coalesce(p_name, ''), coalesce(p_summary, '{}'::jsonb), p_data)
  on conflict (user_id, id) do update
    set name = excluded.name, summary = excluded.summary, data = excluded.data, updated_at = now()
  returning updated_at into saved;
  return jsonb_build_object('id', p_id, 'updated_at', saved);
end $$;

-- Newest first; p_query filters by name (case-insensitive).
create function public.sociai_list_projects(p_query text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'summary', summary, 'updated_at', updated_at)
                            order by updated_at desc), '[]'::jsonb)
  from (select id, summary, updated_at from public.projects
        where user_id = (select auth.uid())
          and (coalesce(p_query, '') = '' or strpos(lower(name), lower(p_query)) > 0)
        order by updated_at desc limit 500) recent
$$;

create function public.sociai_get_project(p_id text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select data from public.projects where user_id = (select auth.uid()) and id = p_id
$$;

create function public.sociai_delete_project(p_id text) returns jsonb
language sql security invoker set search_path = '' as $$
  with gone as (delete from public.projects where user_id = (select auth.uid()) and id = p_id returning 1)
  select jsonb_build_object('deleted', count(*)) from gone
$$;

-- ───────── Server-only functions (service role) ─────────

-- Record (or clear, with nulls) the uploaded resume file and the text extracted from it.
create function public.sociai_set_resume(p_user uuid, p_path text, p_filename text, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set
    resume_path = p_path, resume_filename = p_filename, resume_text = coalesce(p_text, ''),
    resume_updated_at = case when p_path is null then null else now() end, updated_at = now()
  where id = p_user;
  return jsonb_build_object('ok', found);
end $$;

-- Before deleting an account: remember a hash of its email so a new sign-up gets no free credits.
create function public.sociai_forget_user(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.deleted_accounts (email_hash)
    select encode(sha256(convert_to(lower(email), 'UTF8')), 'hex')
    from public.profiles where id = p_user and email is not null
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.sociai_enforce_caps() from public, anon, authenticated;
revoke execute on function public.sociai_get_profile() from public, anon;
revoke execute on function public.sociai_save_profile(text, text, integer, text) from public, anon;
revoke execute on function public.sociai_replace_samples(text[]) from public, anon;
revoke execute on function public.sociai_save_project(text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.sociai_list_projects(text) from public, anon;
revoke execute on function public.sociai_get_project(text) from public, anon;
revoke execute on function public.sociai_delete_project(text) from public, anon;
grant execute on function public.sociai_get_profile() to authenticated;
grant execute on function public.sociai_save_profile(text, text, integer, text) to authenticated;
grant execute on function public.sociai_replace_samples(text[]) to authenticated;
grant execute on function public.sociai_save_project(text, text, jsonb, jsonb) to authenticated;
grant execute on function public.sociai_list_projects(text) to authenticated;
grant execute on function public.sociai_get_project(text) to authenticated;
grant execute on function public.sociai_delete_project(text) to authenticated;
revoke execute on function public.sociai_set_resume(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.sociai_forget_user(uuid) from public, anon, authenticated;
grant execute on function public.sociai_set_resume(uuid, text, text, text) to service_role;
grant execute on function public.sociai_forget_user(uuid) to service_role;

-- ───────── Storage: private "resumes" bucket, one folder per user ─────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 5242880,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read their own resume" on storage.objects
  for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users can upload their own resume" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users can replace their own resume" on storage.objects
  for update to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users can delete their own resume" on storage.objects
  for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
