-- Onboarding after sign-up: the user's main goal with Sociai, and whether they've been through
-- the short first-run setup (goal, background and resume, writing samples).
--
-- These are the user's own fields, so the same rules as the rest of the profile apply: users
-- change only their own row (row-level security), and only these columns (column grants).

-- ───────── Profile fields ─────────

alter table public.profiles
  add column main_goal text not null default ''
    check (main_goal in ('', 'research', 'job', 'fundraising', 'sales', 'networking', 'other')),
  add column main_goal_note text not null default '' check (char_length(main_goal_note) <= 500),
  add column onboarded_at timestamptz;  -- set when the user finishes or skips onboarding

grant update (main_goal, main_goal_note, onboarded_at) on public.profiles to authenticated;

-- People who already use Sociai skip onboarding; the Desk nudges them to add a main goal.
update public.profiles set onboarded_at = now() where activated_at is not null;

-- ───────── Functions the server calls with the user's own token (RLS applies) ─────────

create or replace function public.sociai_get_profile() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'email', p.email, 'credits', p.credits, 'background', p.background,
    'default_channel', p.default_channel, 'default_max_words', p.default_max_words,
    'resume_text', p.resume_text, 'resume_filename', p.resume_filename,
    'resume_updated_at', p.resume_updated_at,
    'main_goal', p.main_goal, 'main_goal_note', p.main_goal_note, 'onboarded_at', p.onboarded_at,
    'samples', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'body', s.body) order by s.position, s.created_at)
                         from public.writing_samples s where s.user_id = p.id), '[]'::jsonb))
  from public.profiles p where p.id = (select auth.uid())
$$;

-- Null arguments leave a field unchanged. Replaces the four-argument version.
drop function public.sociai_save_profile(text, text, integer, text);
create function public.sociai_save_profile(
  p_background text, p_channel text, p_max_words integer, p_resume_text text,
  p_main_goal text default null, p_main_goal_note text default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  update public.profiles set
    background = coalesce(p_background, background),
    default_channel = coalesce(p_channel, default_channel),
    default_max_words = coalesce(p_max_words, default_max_words),
    resume_text = coalesce(p_resume_text, resume_text),
    main_goal = coalesce(p_main_goal, main_goal),
    main_goal_note = coalesce(p_main_goal_note, main_goal_note),
    updated_at = now()
  where id = (select auth.uid());
  return public.sociai_get_profile();
end $$;

-- Onboarding is over (finished or skipped). Only the first call counts, so it never comes back.
create function public.sociai_finish_onboarding() returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  update public.profiles set onboarded_at = coalesce(onboarded_at, now()) where id = (select auth.uid());
  return public.sociai_get_profile();
end $$;

revoke execute on function public.sociai_save_profile(text, text, integer, text, text, text) from public, anon;
revoke execute on function public.sociai_finish_onboarding() from public, anon;
grant execute on function public.sociai_save_profile(text, text, integer, text, text, text) to authenticated;
grant execute on function public.sociai_finish_onboarding() to authenticated;
