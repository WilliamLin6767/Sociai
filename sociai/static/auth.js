// Sign-in with Supabase Auth. The page gets the project URL and anon key from
// /api/config, so nothing is hardcoded. Email magic links are the only method for now;
// signInWithProvider("google") works too once that provider is enabled in Supabase.
// The server checks every access token itself, whichever way the user signed in.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";

let client = null;

export async function initAuth() {
  const res = await fetch("/api/config");
  const cfg = await res.json();
  if (!cfg.configured) return { configured: false };
  client = createClient(cfg.supabase_url, cfg.supabase_anon_key, {
    // Implicit flow: the link works even if it's opened in a different browser than the one that asked.
    auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  });
  const { data } = await client.auth.getSession();
  return { configured: true, session: data.session };
}

export async function accessToken() {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.access_token || null;
}

export async function refreshSession() {
  const { data, error } = await client.auth.refreshSession();
  return error ? null : data.session;
}

const redirectTo = () => location.origin + location.pathname;

export function sendMagicLink(email) {
  return client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo(), shouldCreateUser: true } });
}

export function signInWithProvider(provider) {
  return client.auth.signInWithOAuth({ provider, options: { redirectTo: redirectTo() } });
}

export function signOut() {
  return client.auth.signOut();
}

export function onAuthChange(fn) {
  return client.auth.onAuthStateChange((event, session) => fn(event, session));
}
