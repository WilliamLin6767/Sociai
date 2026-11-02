// Sign-in with Supabase Auth: email and password, with a confirmation email on sign-up and
// a reset link for forgotten passwords. The page gets the project URL and anon key from
// /api/config, so nothing is hardcoded. The server checks every access token itself.
//
// PKCE flow: the links in confirmation and reset emails carry a one-time ?code= that this
// browser exchanges for a session using a secret it kept when the email was requested, so a
// link that leaks on its own can't sign anyone in. Opened in a different browser, the link
// still confirms the email (Supabase does that before redirecting); the page then asks the
// person to sign in with their password, or to request the reset link again from this browser.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";

let client = null;

// Where email links land. The "auth" query parameter tells the page which link it was.
const returnTo = (kind) => `${location.origin}${location.pathname}?auth=${kind}`;

export async function initAuth() {
  const res = await fetch("/api/config");
  const cfg = await res.json();
  if (!cfg.configured) return { configured: false };
  client = createClient(cfg.supabase_url, cfg.supabase_anon_key, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  });
  // Exchanges a ?code= from an email link if this browser started that flow. An expired or
  // used link comes back as an error here. A reset link is recognised by supabase-js itself
  // (PASSWORD_RECOVERY, sent right after the exchange), so it's caught even if Supabase dropped
  // the ?auth=reset from the redirect.
  let recovery = false;
  const { data: listener } = client.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") recovery = true; });
  const { error } = await client.auth.initialize();
  await new Promise((r) => setTimeout(r, 0));
  listener.subscription.unsubscribe();
  const { data } = await client.auth.getSession();
  return { configured: true, session: data.session, linkError: error || null, recovery };
}

export async function accessToken() {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.access_token || null;
}

export async function currentSession() {
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function refreshSession() {
  const { data, error } = await client.auth.refreshSession();
  return error ? null : data.session;
}

// data is stored on the Supabase user (user_metadata), e.g. when the Terms were accepted.
export function signUp(email, password, data = {}) {
  return client.auth.signUp({ email, password, options: { emailRedirectTo: returnTo("confirmed"), data } });
}

export function updateUserData(data) {
  return client.auth.updateUser({ data });
}

export function signIn(email, password) {
  return client.auth.signInWithPassword({ email, password });
}

export function resendConfirmation(email) {
  return client.auth.resend({ type: "signup", email, options: { emailRedirectTo: returnTo("confirmed") } });
}

export function sendPasswordReset(email) {
  return client.auth.resetPasswordForEmail(email, { redirectTo: returnTo("reset") });
}

export function setPassword(password) {
  return client.auth.updateUser({ password });
}

// For email templates that link with ?token_hash=...&type=... instead of the default ?code=.
// Those links work in any browser (see the README).
export function verifyEmailLink(tokenHash, type) {
  return client.auth.verifyOtp({ token_hash: tokenHash, type });
}

// scope "local" signs out this browser only, e.g. after the account itself was deleted.
export function signOut(scope) {
  return client.auth.signOut(scope ? { scope } : undefined);
}

export function onAuthChange(fn) {
  return client.auth.onAuthStateChange((event, session) => fn(event, session));
}
