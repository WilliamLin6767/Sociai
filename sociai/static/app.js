// Sociai: one workspace, four stages (Recipient → Research → Review → Draft) over a
// single saved project. Views are plain functions that render into #main and return
// a cleanup; store updates tell them what changed.

import { store } from "./store.js";
import {
  accessToken, currentSession, initAuth, onAuthChange, refreshSession, requestedScreen, resendConfirmation,
  sendPasswordReset, setPassword, signIn, signOut, signUp, updateUserData, verifyEmailLink,
} from "./auth.js";
import { Loom, domain, normUrl } from "./loom.js";
import { initTracker, openContactEditor, trackerView } from "./tracker.js";

/* ───────── Helpers ───────── */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(pointer: fine)");
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || "").trim());
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const uid = () => Math.random().toString(36).slice(2, 10);
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const isTyping = (el) => el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "button"].includes(el.type)) || el.isContentEditable);
const PLACEHOLDER = /\[[^\[\]\n]{1,80}\]/g;

const svg = (body, vb = "0 0 16 16") => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I = {
  arrow: svg('<path d="M3 8h10M9 4l4 4-4 4"/>'),
  back: svg('<path d="M13 8H3M7 4 3 8l4 4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
  x: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  pen: svg('<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/>'),
  check: svg('<path d="m3 8.5 3 3 7-7"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  book: svg('<path d="M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5V13a1 1 0 0 0-1-1h-4.5zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1 1 0 0 1 1-1h4.5z"/>'),
  focus: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9"/>'),
  redo: svg('<path d="M13 3v3.5H9.5"/><path d="M12.6 6.5A5 5 0 1 0 13 9"/>'),
  sparkle: svg('<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3"/>'),
  ext: svg('<path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5"/>'),
  sun: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>'),
  moon: svg('<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/>'),
  auto: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
  caret: svg('<path d="m4 10 4-4 4 4"/>'),
  track: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>'),
};
// The logo: two overlapping speech bubbles (forest green and tan) with a spark where they meet.
const MARK = `<svg class="brand-mark" viewBox="0 0 232 216" aria-hidden="true">
  <path class="b-green" d="M0 216V124C0 82 34 49 76 49h21c41 0 75 33 75 75s-32 66-72 66H44c-20 0-34 10-44 26z"/>
  <path class="b-tan" d="M135 0h62c19 0 35 16 35 35v47c0 38-31 70-70 70h-22c-39 0-70-32-70-70V65C70 29 99 0 135 0z"/>
  <path class="b-star" d="M120 79c3 17 10 24 27 27-17 3-24 10-27 27-3-17-10-24-27-27 17-3 24-10 27-27z"/></svg>`;
const WORDMARK = '<span class="brand-word">Socia<span class="brand-i">ı</span></span>';
const kbdMod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/* ───────── Domain ───────── */

const STAGES = ["recipient", "research", "review", "draft"];
const STAGE_LABEL = { recipient: "Recipient", research: "Research", review: "Review", draft: "Draft" };

const PURPOSES = [
  { id: "professor", label: "Professor", who: "Prof. Percy Liang, Stanford CS", channel: "email", words: 170,
    goal: "Ask whether their group takes undergraduate research assistants next semester, or for a short call about open projects.",
    about: "e.g. CS junior; took ML and NLP; built a small benchmark for LLM reasoning (on GitHub); ~10 hrs/week" },
  { id: "recruiter", label: "Recruiter", who: "Jane Doe, recruiter at Stripe", channel: "linkedin", words: 120,
    goal: "Get a referral or a first conversation about a role on their team.",
    about: "e.g. new-grad backend engineer; interned at Plaid on payments infrastructure" },
  { id: "investor", label: "Investor", who: "A partner at a seed fund, or a link to their page", channel: "email", words: 150,
    goal: "Get a 20-minute intro call about our pre-seed round.",
    about: "e.g. what you're building, early traction, why now" },
  { id: "prospect", label: "Prospect", who: "Head of Operations at a company you sell to", channel: "email", words: 120,
    goal: "Book a short demo of our product for their team.",
    about: "e.g. what your product does and who it already helps" },
  { id: "advice", label: "Advice", who: "Someone whose career path you admire", channel: "linkedin", words: 110,
    goal: "Ask for 15 minutes of advice about their career path.",
    about: "e.g. where you are now and the decision you're weighing" },
  { id: "podcast", label: "Podcast guest", who: "An author or researcher you'd like to interview", channel: "email", words: 160,
    goal: "Invite them to be interviewed on our podcast.",
    about: "e.g. the show, its audience, and a past episode they'd relate to" },
  { id: "other", label: "Something else", who: "A name with context, or a link to their page", goal: "", about: "A line or two about you" },
];
// The user's main goal (profile), and the purpose new outreach starts with for it.
const MAIN_GOALS = [
  ["research", "Reach professors or researchers", "professor"],
  ["job", "Find a job or internship", "recruiter"],
  ["fundraising", "Raise money or find investors", "investor"],
  ["sales", "Sales or partnerships", "prospect"],
  ["networking", "Networking", "advice"],
  ["other", "Something else", "other"],
];
const CHANNELS = [["email", "Email"], ["linkedin", "LinkedIn"], ["direct message", "Direct message"]];
const LENGTHS = [[100, "Short"], [160, "Medium"], [220, "Long"]];
const REFINES = [
  ["warmer", "Warmer", "Make it warmer and more personal, without becoming effusive."],
  ["formal", "More formal", "Make it more formal and polished."],
  ["direct", "More direct", "Make it more direct: lead with the ask sooner and cut any preamble."],
  ["shorter", "Shorter", "Make it noticeably shorter (about two thirds the length), keeping the most specific detail."],
  ["longer", "Longer", "Make it a little longer by adding one more concrete, relevant detail from the research. Stay within the word limit."],
];

function displayName(target) {
  const t = String(target || "").trim();
  if (isUrl(t)) {
    try {
      const u = new URL(t);
      const seg = u.pathname.split("/").filter(Boolean).pop();
      return trunc(seg ? decodeURIComponent(seg).replace(/[-_]+/g, " ") : u.hostname.replace(/^www\./, ""), 40);
    } catch {}
  }
  const first = t.split(/[,(\n|—–]| - | at /)[0].trim();
  return trunc(first || t, 44) || "Untitled";
}
const nameOf = (p) => p.research.dossier?.name || displayName(p.brief.target);
function initials(name) {
  const words = name.replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter((w) => w && !/^(prof|dr|mr|ms|mrs)$/i.test(w));
  if (!words.length) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

function available(p) {
  const a = ["recipient"];
  if (p.research.status !== "idle") a.push("research");
  if (p.research.dossier) a.push("review");
  if (p.draft.versions.length || p.draft.status === "running") a.push("draft");
  return a;
}
function resumeStage(p) {
  if (p.draft.versions.length || p.draft.status === "running") return "draft";
  if (p.research.status === "running") return "research";
  if (p.research.dossier) return "review";
  if (p.research.status === "error") return "research";
  return "recipient";
}
function stateOf(p) {
  if (p.research.status === "running") return { key: "research", text: "Researching", cls: "is-busy" };
  if (p.draft.status === "running") return { key: "draft", text: "Writing", cls: "is-busy" };
  if (p.draft.versions.length) return p.copiedAt ? { key: "copied", text: "Copied" } : { key: "draft", text: "Drafting" };
  if (p.research.dossier) return { key: "review", text: "Ready to review" };
  if (p.research.status === "error") return { key: "research", text: "Research stopped", cls: "is-warn" };
  return { key: "brief", text: "Not started" };
}
function briefChanged(p) {
  const s = p.research.brief;
  if (!s) return false;
  const n = (x) => String(x || "").trim();
  return n(s.target) !== n(p.brief.target) || n(s.goal) !== n(p.brief.goal) || n(s.background) !== n(p.brief.background);
}

function buildReview(d, prev) {
  const items = [
    ...(d.facts || []).map((f) => ({ id: uid(), kind: "fact", text: f.fact, original: f.fact, source: f.source, included: true, corrected: false })),
    ...(d.recent_work || []).map((w) => ({ id: uid(), kind: "work", title: w.title, text: w.detail, original: w.detail, source: w.source, included: true, corrected: false })),
  ];
  const hooks = (d.hooks || []).map((text) => ({ id: uid(), text, selected: false, custom: false }));
  if (prev) hooks.push(...prev.hooks.filter((h) => h.custom)); // the user's own threads survive a re-run
  return {
    summary: { text: d.summary || "", original: d.summary || "", corrected: false },
    items, hooks,
    cautions: (d.cautions || []).map((text) => ({ id: uid(), text, noted: false })),
    notes: prev?.notes || "",
  };
}

const requestOf = (p) => ({
  target: p.brief.target, goal: p.brief.goal, sender_background: p.brief.background || "",
  writing_samples: (p.brief.samples || []).map((s) => s.trim()).filter(Boolean),
  channel: p.brief.channel || "email", max_words: +p.brief.max_words || 160,
});

function dossierPayload(p) {
  const d = p.research.dossier, r = p.review;
  const kept = r.items.filter((i) => i.included);
  return {
    name: d.name || "", headline: d.headline || "", summary: r.summary.text,
    facts: kept.filter((i) => i.kind === "fact").map((i) => ({ fact: i.text, source: i.source || "", ...(i.corrected ? { corrected: true } : {}) })),
    recent_work: kept.filter((i) => i.kind === "work").map((i) => ({ title: i.title, detail: i.text + (i.corrected ? " [corrected by sender]" : ""), source: i.source || "" })),
    hooks: r.hooks.filter((h) => h.selected).map((h) => h.text),
    cautions: r.cautions.map((c) => c.text),
    sources: d.sources || [], notes: r.notes || "", reviewed: true, contact: d.contact || {},
  };
}

function titleMap(events) {
  const m = new Map();
  for (const e of events || []) {
    if (e.kind === "found") for (const r of e.results || []) if (r.title && !m.has(normUrl(r.url))) m.set(normUrl(r.url), r.title);
    if (e.kind === "read" && e.title) m.set(normUrl(e.url), e.title);
  }
  return m;
}
function sourceIndex(p) {
  const list = [], idx = new Map();
  const add = (u) => {
    if (!u) return;
    const k = isUrl(u) ? normUrl(u) : u;
    if (!idx.has(k)) { idx.set(k, list.length + 1); list.push(u); }
  };
  (p.review?.items || []).forEach((i) => add(i.source));
  (p.research.dossier?.sources || []).forEach(add);
  const c = p.research.dossier?.contact;
  [...(c?.emails || []), ...(c?.phones || [])].forEach((x) => add(x.source));
  add(c?.best_way_source);
  const titles = titleMap(p.research.events);
  const key = (u) => (isUrl(u) ? normUrl(u) : u);
  return {
    list,
    num: (u) => idx.get(key(u)),
    title: (u) => titles.get(key(u)) || "",
    citedBy: (u) => (p.review?.items || []).filter((i) => i.source && key(i.source) === key(u)).length,
  };
}
const shortUrl = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : decodeURI(x.pathname)); } catch { return u; } };
const words = (s) => (String(s).trim().match(/\S+/g) || []).length;
const placeholders = (s) => [...new Set(String(s || "").match(PLACEHOLDER) || [])];
const currentVersion = (p) => p.draft.versions[p.draft.current] || null;

/* ───────── Server jobs ───────── */

// Account: the signed-in user's email and credit balance. Every API call carries the
// Supabase access token; a 401 means the session has ended, so the sign-in screen returns.
const account = { email: "", credits: null };

async function request(method, path, body, { raw = null, contentType = null, retried = false } = {}) {
  const headers = {};
  const token = await accessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { payload = raw; headers["Content-Type"] = contentType || "application/octet-stream"; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const res = await fetch(path, { method, headers, body: payload });
  let data;
  try { data = await res.json(); } catch { data = { error: `The server answered with an error (${res.status}).` }; }
  if (res.status === 401) {
    if (!retried && token && (await refreshSession())) return request(method, path, body, { raw, contentType, retried: true });
    showSignIn({ message: "Your session ended. Sign in again to continue." });
  }
  if (typeof data?.credits === "number") setCredits(data.credits);
  return { http: res.status, data };
}
const api = (path, body) => request(body === undefined ? "GET" : "POST", path, body);

// The user's saved profile: background, default format, writing samples, resume text.
let profile = null;
async function loadProfile() {
  const { http, data } = await request("GET", "/api/profile");
  if (http !== 200) throw new Error(data?.error || "Couldn't load your profile.");
  profile = data;
}

async function saveBriefToProfile(b) {
  const channel = CHANNELS.some(([v]) => v === b.channel) ? b.channel : undefined;
  const words = Math.min(600, Math.max(40, Math.round(+b.max_words || 160)));
  const r1 = await request("PUT", "/api/profile", { background: b.background, default_channel: channel, default_max_words: words });
  const r2 = r1.http === 200 ? await request("PUT", "/api/profile/samples", { samples: b.samples }) : r1;
  if (r2.http === 200) { profile = r2.data; flashSaved(true); return true; }
  toast(r2.data?.error || "Couldn't save to your profile. Try again.");
  return false;
}

const creditLabel = (n) => (n === null ? "…" : `${n} credit${n === 1 ? "" : "s"}`);
const creditNote = () => account.credits === 0
  ? 'You\'re out of credits. <a class="link-btn" href="#/pricing">Get more credits</a>'
  : `Uses 1 credit, which includes up to 3 drafts${account.credits === null ? "" : `. You have ${creditLabel(account.credits)}`}. Sociai never sends anything for you.`;

function setCredits(n) {
  const changed = account.credits !== null && account.credits !== n;
  account.credits = n;
  const el = $("#credits-n");
  if (el) {
    el.textContent = creditLabel(n);
    if (changed) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  }
  const note = $("#credit-note");
  if (note) note.innerHTML = creditNote();
}

// The credit balance links to Pricing; the round initial next to it opens the account menu.
const accountButton = () => `<a class="credits-btn" href="#/pricing" title="Get more credits" aria-label="${creditLabel(account.credits)}. Get more credits">
    <span class="credits-dot" aria-hidden="true"></span><span id="credits-n">${creditLabel(account.credits)}</span></a>
  <div class="account"><button type="button" class="avatar-btn" data-act="account" aria-haspopup="true" aria-expanded="false"
    aria-label="Your account: profile, billing and sign out" title="${esc(account.email || "Your account")}">${esc((account.email || "?").trim()[0] || "?")}</button></div>`;

function toggleAccountMenu(btn) {
  if ($(".account .menu")) return closeMenus();
  closeMenus();
  btn.setAttribute("aria-expanded", "true");
  btn.insertAdjacentHTML("afterend", `<div class="menu menu-down" role="menu">
    <p class="menu-head"><span class="label">Signed in as</span><span class="menu-email">${esc(account.email)}</span></p>
    <p class="menu-note">${creditLabel(account.credits)} left. One credit covers a research run plus up to 3 drafts or revisions for that person.</p>
    <hr><a class="mi" role="menuitem" href="#/tracker">Outreach tracker</a>
    <a class="mi" role="menuitem" href="#/profile">Your profile</a>
    <a class="mi" role="menuitem" href="#/account">Account and billing</a>
    <a class="mi" role="menuitem" href="#/pricing">Buy credits</a>
    <hr><button type="button" class="mi" role="menuitem" data-act="sign-out">Sign out</button></div>`);
  $(".account .mi").focus();
}

// Sign-in screens: shown before the Desk, and again whenever the session ends. Sign in, create
// an account, confirm the email, forgot password, and set a new one from a reset link.
let signInEl = null;
const MIN_PASSWORD = 10;
// Bump when the Terms or Privacy Policy change enough that people should agree again.
const TERMS_VERSION = "2026-11-01";
const termsAccepted = (user) => user?.user_metadata?.terms_version === TERMS_VERSION;
const termsRecord = () => ({ terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() });
const LEGAL_LINKS = '<a class="link-btn" href="/terms" target="_blank" rel="noopener">Terms</a> and <a class="link-btn" href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>';
const agreeBox = (id) => `<label class="agree" for="${id}"><input type="checkbox" id="${id}"><span>I agree to the ${LEGAL_LINKS}</span></label>`;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function showSignIn({ message = "", email = "", screen = "signin", notice = "" } = {}) {
  if (signInEl && screen === "signin" && !notice && $("#signin-password", signInEl)) { if (message) showSignInError(message); return; }
  if (!signInEl) {
    closeMenus(); closeDrawer(); closePop();
    signInEl = document.createElement("div");
    signInEl.className = "gate";
    signInEl.setAttribute("role", "dialog");
    signInEl.setAttribute("aria-modal", "true");
    signInEl.setAttribute("aria-labelledby", "signin-title");
    for (const id of ["bar", "main"]) document.getElementById(id).inert = true;
    document.body.appendChild(signInEl);
  }
  ({ signin: drawSignIn, signup: drawSignUp, forgot: drawForgot, "new-password": drawNewPassword, terms: drawTerms })[screen](email, message, notice);
}

function hideSignIn() {
  signInEl?.remove();
  signInEl = null;
  for (const id of ["bar", "main"]) document.getElementById(id).inert = false;
}

function showSignInError(message) {
  const el = $("#signin-err", signInEl);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

// A rough guide only. Supabase enforces the real rule (at least 10 characters).
function passwordStrength(pw) {
  if (!pw) return { level: 0, text: `At least ${MIN_PASSWORD} characters.` };
  if (pw.length < MIN_PASSWORD) return { level: 1, text: `Too short: ${plural(MIN_PASSWORD - pw.length, "more character")} needed.` };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const guessable = /^(.)\1+$|^0?1234567890?$|password|qwerty|letmein|iloveyou|sociai/i.test(pw);
  const score = guessable ? 0 : (pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0) + Math.max(0, kinds - 1);
  if (score <= 1) return { level: 2, text: "Weak: easy to guess. Make it longer, or mix in numbers and symbols." };
  if (score <= 2) return { level: 3, text: "Fair. A few more characters would make it strong." };
  return { level: 4, text: "Strong." };
}

const passwordField = (id, label, { autocomplete, meter = false } = {}) => `<div class="gate-field">
    <label class="label" for="${id}">${label}</label>
    <div class="pw-field"><input class="input" id="${id}" type="password" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off"${meter ? ` data-meter aria-describedby="${id}-hint"` : ""}>
      <button type="button" class="pw-toggle" data-act="pw-toggle" aria-pressed="false" aria-controls="${id}" aria-label="Show password">Show</button></div>
    ${meter ? `<div class="pw-meter" data-level="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p class="field-hint" id="${id}-hint" aria-live="polite">${passwordStrength("").text}</p>` : ""}
  </div>`;

const emailField = (email) => `<div class="gate-field"><label class="label" for="signin-email">Email address</label>
    <input class="input" id="signin-email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="you@example.com" value="${esc(email)}"></div>`;

const gateLink = (screen, text) => `<button type="button" class="link-btn" data-screen="${screen}">${text}</button>`;

function gateCard({ label, title, intro = "", notice = "", body, submit, foot = "", email = "" }) {
  signInEl.innerHTML = `<form class="gate-card" novalidate>
    ${MARK}
    <p class="label">${label}</p>
    <h1 class="h2" id="signin-title">${title}</h1>
    ${notice ? `<p class="gate-notice" role="status">${notice}</p>` : ""}
    ${intro ? `<p class="muted">${intro}</p>` : ""}
    ${body}
    <p class="field-error" id="signin-err" role="alert" hidden></p>
    <button type="submit" class="btn btn-primary">${submit} <span class="arrow">${I.arrow}</span></button>
    ${foot ? `<div class="gate-foot">${foot}</div>` : ""}
    <p class="gate-legal"><a href="/terms" target="_blank" rel="noopener">Terms</a><span aria-hidden="true">·</span><a href="/privacy" target="_blank" rel="noopener">Privacy</a></p>
  </form>`;
  const form = $("form", signInEl);
  form.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-act='pw-toggle']");
    if (toggle) {
      const input = $(`#${toggle.getAttribute("aria-controls")}`, form), show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
      return;
    }
    const link = e.target.closest("[data-screen]");
    if (link) showSignIn({ screen: link.dataset.screen, email: $("#signin-email", form)?.value.trim() || email });
  });
  form.addEventListener("input", (e) => {
    if (e.target.hasAttribute("data-meter")) {
      const s = passwordStrength(e.target.value);
      $(".pw-meter", form).dataset.level = s.level;
      $(`#${e.target.id}-hint`, form).textContent = s.text;
    }
    showSignInError("");
  });
  return form;
}

// Runs a submit handler with the button disabled. Anything thrown shows as a connection problem.
function onGateSubmit(form, fn) {
  const btn = $("button[type=submit]", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); }
    catch { showSignInError("Couldn't reach the sign-in service. Check your connection, then try again."); }
    finally { if (btn.isConnected) btn.disabled = false; }
  });
}

const tooMany = (error) => error?.status === 429 || /rate_limit/.test(error?.code || "");

function drawSignIn(email = "", message = "", notice = "") {
  const form = gateCard({
    label: "Sociai", title: "Sign in to Sociai", notice, email,
    body: emailField(email) + passwordField("signin-password", "Password", { autocomplete: "current-password" })
      + `<p class="gate-aside">${gateLink("forgot", "Forgot your password?")}</p>`,
    submit: "Sign in",
    foot: `<span class="muted">New to Sociai?</span> ${gateLink("signup", "Create an account")}`,
  });
  if (message) showSignInError(message);
  (email ? $("#signin-password", form) : $("#signin-email", form)).focus();
  onGateSubmit(form, async () => {
    const addr = $("#signin-email", form).value.trim(), password = $("#signin-password", form).value;
    if (!EMAIL_RE.test(addr)) return showSignInError("Enter your full email address.");
    if (!password) return showSignInError("Enter your password.");
    const { data, error } = await signIn(addr, password);
    if (!error) return startSession(data.session);
    // Supabase only says "not confirmed" after the password matched, so this doesn't leak
    // whether an address has an account.
    if (error.code === "email_not_confirmed") return drawCheckInbox(addr, "unconfirmed");
    if (tooMany(error)) return showSignInError("Too many attempts. Wait a few minutes, then try again.");
    if (error.status === 400) return showSignInError("That email and password don't match. Try again, or reset your password.");
    throw error;
  });
}

function drawSignUp(email = "") {
  const form = gateCard({
    label: "Sociai", title: "Create your account", email,
    intro: "New accounts start with 2 free credits. Each credit covers a research run and up to 3 drafts.",
    body: emailField(email) + passwordField("signup-password", "Password", { autocomplete: "new-password", meter: true })
      + passwordField("signup-confirm", "Confirm password", { autocomplete: "new-password" }) + agreeBox("signup-agree"),
    submit: "Create account",
    foot: `<span class="muted">Already have an account?</span> ${gateLink("signin", "Sign in")}`,
  });
  $("#signin-email", form).focus();
  const exists = `An account with this email already exists. ${gateLink("signin", "Sign in")} or ${gateLink("forgot", "reset your password")}.`;
  const showExists = () => { showSignInError(""); $("#signin-err", form).innerHTML = exists; $("#signin-err", form).hidden = false; };
  onGateSubmit(form, async () => {
    const addr = $("#signin-email", form).value.trim();
    const password = $("#signup-password", form).value, confirm = $("#signup-confirm", form).value;
    if (!EMAIL_RE.test(addr)) return showSignInError("Enter your full email address.");
    if (password.length < MIN_PASSWORD) return showSignInError(`Use at least ${MIN_PASSWORD} characters for your password.`);
    if (password !== confirm) return showSignInError("The two passwords don't match.");
    if (!$("#signup-agree", form).checked) return showSignInError("To create an account, agree to the Terms and Privacy Policy.");
    const check = await fetch("/api/check-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: addr }) });
    if (!check.ok) {
      const d = await check.json().catch(() => ({}));
      return showSignInError(d.error || "That email address can't be used.");
    }
    const { data, error } = await signUp(addr, password, termsRecord());
    if (error) {
      if (["user_already_exists", "email_exists"].includes(error.code)) return showExists();
      if (error.code === "weak_password") return showSignInError(`That password is too easy to guess. Use at least ${MIN_PASSWORD} characters and mix in numbers or symbols.`);
      if (error.code === "signup_disabled") return showSignInError("New sign-ups are closed right now.");
      if (error.code === "email_address_invalid") return showSignInError("That email address can't be used. Try another one.");
      if (tooMany(error)) return showSignInError("Too many sign-up emails were sent. Wait a few minutes, then try again.");
      throw error;
    }
    // With email confirmation on, Supabase answers an address that already has an account with
    // a user that has no identities (and sends no email) instead of an error.
    if (data.user && Array.isArray(data.user.identities) && !data.user.identities.length) return showExists();
    if (data.session) return startSession(data.session); // the project has email confirmation off
    drawCheckInbox(addr, "confirm");
  });
}

function drawForgot(email = "", message = "") {
  const form = gateCard({
    label: "Forgot password", title: "Reset your password", email,
    intro: "Enter the email you signed up with and we'll send you a link to set a new password.",
    body: emailField(email), submit: "Send reset link",
    foot: gateLink("signin", "Back to sign in"),
  });
  if (message) showSignInError(message);
  $("#signin-email", form).focus();
  onGateSubmit(form, async () => {
    const addr = $("#signin-email", form).value.trim();
    if (!EMAIL_RE.test(addr)) return showSignInError("Enter your full email address.");
    const { error } = await sendPasswordReset(addr);
    if (tooMany(error)) return showSignInError("Too many emails were requested. Wait a few minutes, then try again.");
    if (error) throw error;
    drawCheckInbox(addr, "reset");
  });
}

function drawNewPassword() {
  const form = gateCard({
    label: "Reset password", title: "Set a new password",
    intro: account.email ? `For <b>${esc(account.email)}</b>.` : "",
    body: passwordField("signup-password", "New password", { autocomplete: "new-password", meter: true })
      + passwordField("signup-confirm", "Confirm new password", { autocomplete: "new-password" }),
    submit: "Save password and continue",
  });
  $("#signup-password", form).focus();
  onGateSubmit(form, async () => {
    const password = $("#signup-password", form).value, confirm = $("#signup-confirm", form).value;
    if (password.length < MIN_PASSWORD) return showSignInError(`Use at least ${MIN_PASSWORD} characters for your password.`);
    if (password !== confirm) return showSignInError("The two passwords don't match.");
    const { data, error } = await setPassword(password);
    if (error?.code === "same_password") return showSignInError("That's your current password. Choose a new one.");
    if (error?.code === "weak_password") return showSignInError(`That password is too easy to guess. Use at least ${MIN_PASSWORD} characters and mix in numbers or symbols.`);
    if (error && (error.status === 401 || error.name === "AuthSessionMissingError")) {
      return showSignIn({ screen: "forgot", message: "That reset link has expired. Send yourself a new one." });
    }
    if (error) throw error;
    resettingPassword = false;
    toast("Password changed. You're signed in.");
    startSession(await currentSession());
  });
}

// Accounts that haven't agreed to the current Terms (e.g. made before they existed) agree once
// before anything else; the answer is kept on the Supabase user.
let termsSession = null;
function drawTerms() {
  const form = gateCard({
    label: "Before you continue", title: "Agree to the Terms",
    intro: `Sociai has ${LEGAL_LINKS.replace("Terms", "Terms of Service")}. They explain what's stored, how to delete it, and how credits and refunds work.`,
    body: agreeBox("terms-agree"), submit: "Continue",
    foot: `<span class="muted">Signed in as ${esc(termsSession?.user?.email || "")}.</span> <button type="button" class="link-btn" data-act="terms-sign-out">Sign out</button>`,
  });
  $("#terms-agree", form).focus();
  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-act='terms-sign-out']")) signOut().finally(() => location.reload());
  });
  onGateSubmit(form, async () => {
    if (!$("#terms-agree", form).checked) return showSignInError("Tick the box to agree, or sign out.");
    const { data, error } = await updateUserData(termsRecord());
    if (error) throw error;
    const session = { ...termsSession, user: data.user };
    termsSession = null;
    startSession(session);
  });
}

// kind: "confirm" (just signed up), "unconfirmed" (signed in before confirming), "reset".
function drawCheckInbox(addr, kind) {
  const reset = kind === "reset";
  const title = reset ? "Check your email for a reset link" : "Check your email to confirm your account";
  const text = reset
    ? `If there's a Sociai account for <b>${esc(addr)}</b>, we've sent it a link to set a new password. Open it in this browser. It can take a minute, and sometimes lands in spam.`
    : `${kind === "unconfirmed" ? "Confirm your email address before you sign in. " : ""}We sent a confirmation link to <b>${esc(addr)}</b>. Open it to activate your account. It can take a minute, and sometimes lands in spam.`;
  signInEl.innerHTML = `<div class="gate-card" role="status">
    ${MARK}
    <p class="label">Check your email</p>
    <h1 class="h2" id="signin-title">${title}</h1>
    <p class="muted">${text}</p>
    <div class="gate-actions"><button type="button" class="btn btn-line btn-sm" id="resend" disabled>Resend email</button>
      <button type="button" class="link-btn" id="back-signin">Back to sign in</button></div>
  </div>`;
  const resend = $("#resend", signInEl);
  let left = kind === "unconfirmed" ? 0 : 60;
  const tick = () => {
    if (!resend.isConnected) return;
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Resend email (${left}s)` : "Resend email";
    if (left-- > 0) setTimeout(tick, 1000);
  };
  tick();
  resend.onclick = async () => {
    resend.disabled = true;
    const { error } = await (reset ? sendPasswordReset(addr) : resendConfirmation(addr)).catch((e) => ({ error: e }));
    if (error) {
      resend.disabled = false;
      return toast(tooMany(error) ? "Too many emails were sent. Wait a few minutes, then try again." : "Couldn't resend yet. Wait a little and try again.");
    }
    left = 60; tick();
    toast("Sent another email.");
  };
  $("#back-signin", signInEl).onclick = () => showSignIn({ screen: "signin", email: addr });
}

function showFatal(title, text) {
  hideSignIn();
  signInEl = document.createElement("div");
  signInEl.className = "gate";
  signInEl.innerHTML = `<div class="gate-card" role="alert">${MARK}<h1 class="h2">${esc(title)}</h1><p class="muted">${esc(text)}</p></div>`;
  for (const id of ["bar", "main"]) document.getElementById(id).inert = true;
  document.body.appendChild(signInEl);
}

const polling = new Map();
const revealNext = new Set();

function poll(id, kind) {
  const key = id + ":" + kind;
  if (polling.has(key)) return;
  let misses = 0;
  const tick = async () => {
    const p = store.get(id);
    const st = p && (kind === "research" ? p.research : p.draft);
    if (!st || st.status !== "running" || !st.job) return polling.delete(key);
    let res;
    try {
      res = await api(`/api/jobs/${st.job}?after=${kind === "research" ? st.events.length : 0}`);
      misses = 0;
    } catch {
      if (++misses >= 10) { polling.delete(key); return failJob(id, kind, "Lost the connection to the Sociai server. Is it still running?"); }
      return polling.set(key, setTimeout(tick, 1500));
    }
    if (res.http === 401) return polling.set(key, setTimeout(tick, 2000)); // waits for the user to sign in again, then carries on
    if (res.http >= 400) { polling.delete(key); return failJob(id, kind, res.data.error || "This job is no longer running."); }
    const d = res.data;
    if (kind === "research" && d.events?.length) store.update(id, (p) => { p.research.events.push(...d.events); }, "research-events");
    if (d.status === "done") { polling.delete(key); return kind === "research" ? finishResearch(id, d.result) : finishDraft(id, d.result); }
    if (d.status === "error") { polling.delete(key); return failJob(id, kind, d.error); }
    polling.set(key, setTimeout(tick, 900));
  };
  polling.set(key, setTimeout(tick, 250));
}

function failJob(id, kind, message, action = null) {
  store.update(id, (p) => {
    const st = kind === "research" ? p.research : p.draft;
    Object.assign(st, { status: "error", error: message, errorAction: action, job: null });
    if (kind === "draft") st.pending = null;
  }, kind);
}

async function startResearch(id) {
  store.update(id, (p) => {
    // Keep the previous dossier and review until the new research succeeds.
    Object.assign(p.research, {
      status: "running", job: null, error: null, startedAt: Date.now(), finishedAt: null, events: [],
      brief: { target: p.brief.target, goal: p.brief.goal, background: p.brief.background },
    });
  }, "research");
  try {
    const { data } = await api("/api/research", { request: requestOf(store.get(id)), project_id: id });
    if (data.error || !data.job) throw Object.assign(new Error(data.error || "The server didn't start the research."), { action: data.action });
    store.update(id, (p) => { p.research.job = data.job; }, "edit");
    poll(id, "research");
  } catch (e) {
    failJob(id, "research", e instanceof TypeError ? "Couldn't reach the Sociai server. Is it running?" : String(e.message || e), e.action);
  }
}

function finishResearch(id, dossier) {
  store.update(id, (p) => {
    Object.assign(p.research, { status: "done", finishedAt: Date.now(), dossier, job: null });
    p.draftsLeft = (p.draftsLeft || 0) + 3; // each research run includes 3 drafts; the server has the final say
    p.review = buildReview(dossier, p.review);
  }, "research");
}

async function startDraft(id, { instruction = null, label = "First draft" } = {}) {
  const p = store.get(id);
  const cur = currentVersion(p);
  const body = { request: requestOf(p), dossier: dossierPayload(p), project_id: id };
  if (instruction && cur) body.revise = { subject: cur.subject, body: cur.body, instruction };
  const threads = instruction && cur ? cur.threads : p.review.hooks.filter((h) => h.selected).map((h) => ({ id: h.id, text: h.text }));
  store.update(id, (p) => { Object.assign(p.draft, { status: "running", error: null, job: null, pending: { label, threads, revise: !!body.revise } }); }, "draft");
  try {
    const { data } = await api("/api/draft", body);
    if (data.error || !data.job) throw Object.assign(new Error(data.error || "The server didn't start the draft."), { action: data.action });
    store.update(id, (p) => {
      p.draft.job = data.job;
      if (typeof data.drafts_left === "number") p.draftsLeft = data.drafts_left;
    }, "edit");
    poll(id, "draft");
  } catch (e) {
    failJob(id, "draft", e instanceof TypeError ? "Couldn't reach the Sociai server. Is it running?" : String(e.message || e), e.action);
  }
}

function finishDraft(id, r) {
  revealNext.add(id);
  store.update(id, (p) => {
    const pend = p.draft.pending || {};
    p.draft.versions.push({
      id: uid(), at: Date.now(), label: pend.label || "Draft", subject: r.subject || "", body: r.body || "", edited: false,
      threads: pend.threads || [],
      notes: { personal: r.personalization_notes || [], voice: r.voice_notes || "", questions: r.open_questions || [] },
    });
    Object.assign(p.draft, { current: p.draft.versions.length - 1, status: "idle", pending: null, job: null });
  }, "draft");
}

/* ───────── Router & transitions ───────── */

let view = null; // { route, cleanup }

function parseRoute() {
  for (const page of ["profile", "pricing", "account", "tracker"]) if (location.hash.startsWith(`#/${page}`)) return { view: page };
  const m = location.hash.match(/^#\/p\/([\w-]+)(?:\/(\w+))?/);
  return m ? { view: "project", id: m[1], stage: m[2] } : { view: "desk" };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const stageHash = (p, stage) => `#/p/${p.id}/${stage}`;

function direction(a, b) {
  if (!a) return "same";
  if (a.view === "desk") return b.view === "project" ? "forward" : "same";
  if (b.view === "desk") return "back";
  if (a.id !== b.id) return "same";
  const d = STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage);
  return d > 0 ? "forward" : d < 0 ? "back" : "same";
}

// Set once the account's projects and profile have loaded. Until then nothing renders, so a
// hashchange during sign-in can't show a half-loaded desk.
let ready = false;

function render({ instant = false } = {}) {
  if (!ready) return;
  const route = profile.onboarded_at ? parseRoute() : { view: "welcome" };
  let p = null;
  if (route.view === "project") {
    p = store.get(route.id);
    if (!p && store.summary(route.id)) return openSaved(route);
    if (!p) { history.replaceState(null, "", "#/"); return render({ instant }); }
    if (!route.stage || !available(p).includes(route.stage)) {
      route.stage = resumeStage(p);
      history.replaceState(null, "", stageHash(p, route.stage));
    }
  }
  const from = view?.route;
  const swap = () => {
    view?.cleanup?.();
    closePop(); closeDrawer(); closeMenus();
    document.body.classList.remove("focus-on");
    renderBar(route, p);
    resetMain();
    const fn = PAGES[route.view] || VIEWS[route.stage];
    view = { route, cleanup: fn(p, from) };
    if (!instant) { window.scrollTo(0, 0); focusMain(route); }
  };
  const same = from && from.view === route.view && from.id === route.id && from.stage === route.stage;
  if (instant || same || !from || !document.startViewTransition || reduced.matches) return swap();
  document.documentElement.dataset.dir = direction(from, route);
  const t = document.startViewTransition(swap);
  t.ready.catch(() => {}); // a newer navigation can skip this one; that's fine
  t.finished.finally(() => {
    delete document.documentElement.dataset.dir;
    $$("[data-vt]").forEach((el) => { el.style.viewTransitionName = ""; el.removeAttribute("data-vt"); });
  });
}

// A project saved in the account but not opened yet in this session: fetch it, then show it.
function openSaved(route) {
  view?.cleanup?.();
  view = { route: { view: "loading" }, cleanup: null };
  closePop(); closeDrawer(); closeMenus();
  resetMain();
  renderBar({ view: "loading" }, null);
  $("#main").innerHTML = `<div class="page"><p class="opening" role="status">Opening ${esc(store.summary(route.id)?.name || "your project")}…</p></div>`;
  store.load(route.id).then(
    () => { if (parseRoute().id === route.id) render({ instant: true }); },
    () => { toast("Couldn't open that project. It may have been deleted."); go("#/"); },
  );
}

// Each view adds its own listeners to #main. A fresh element per view drops the previous
// view's listeners, so they never pile up as the user moves around.
function resetMain() {
  const old = $("#main");
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
}

function focusMain(route) {
  if (route.view === "desk") {
    if (finePointer.matches) $("#f-target")?.focus({ preventScroll: true });
    return;
  }
  const h = $("#main [data-focus-on-enter]");
  if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
}

addEventListener("hashchange", () => {
  render();
  window.fbq?.("track", "PageView"); // screens change without a page load; count each one for the Meta Pixel
});

/* ───────── Bar ───────── */

function threadNav(p, stage) {
  const av = available(p);
  const busy = { research: p.research.status === "running", draft: p.draft.status === "running" };
  return `<nav class="threadnav" aria-label="Workflow"><ol>${STAGES.map((s) => {
    const reached = av.includes(s);
    const cls = `knot${reached ? " is-reached" : ""}${busy[s] ? " is-busy" : ""}`;
    const inner = `<span class="k" aria-hidden="true"></span><span class="t">${STAGE_LABEL[s]}</span>`;
    const tag = reached
      ? `<a class="${cls}" href="${stageHash(p, s)}"${s === stage ? ' aria-current="step"' : ""}>${inner}${busy[s] ? '<span class="vh"> (in progress)</span>' : ""}</a>`
      : `<span class="${cls}" aria-disabled="true">${inner}<span class="vh"> (not yet)</span></span>`;
    return `<li class="${reached ? "is-reached" : ""}">${tag}</li>`;
  }).join("")}</ol></nav>`;
}

const THEMES = ["system", "light", "dark"];
function theme() { try { return localStorage.getItem("sociai.theme") || "system"; } catch { return "system"; } }
function themeButton() {
  const t = theme();
  const label = { system: "Theme: matches your system", light: "Theme: light", dark: "Theme: dark" }[t];
  return `<button class="icon-btn" data-act="theme" aria-label="${label}. Change theme" title="${label}">${{ system: I.auto, light: I.sun, dark: I.moon }[t]}</button>`;
}

function renderBar(route, p) {
  $("#bar").innerHTML = `<div class="page bar-inner">
    <a class="brand" href="#/" aria-label="Sociai: your desk">${MARK}${WORDMARK}</a>
    ${p ? `<div class="crumb"><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-who" id="crumb-who">${esc(nameOf(p))}</span><span class="crumb-goal" id="crumb-goal">${esc(p.brief.goal)}</span></div>
      <div id="nav-slot">${threadNav(p, route.stage)}</div>`
      : PAGE_TITLES[route.view] ? `<div class="crumb"><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-who">${PAGE_TITLES[route.view]}</span></div>`
      : '<div class="crumb"></div>'}
    <div class="bar-end">${p ? "" : `<a class="bar-link" href="#/tracker"${route.view === "tracker" ? ' aria-current="page"' : ""}>${I.track}<span>Tracker</span></a>`}${p || route.view === "profile" ? '<span class="saved" id="saved" title="Saved to your account"><span>Saved</span></span>' : ""}${accountButton()}${themeButton()}</div>
  </div>`;
}

function flashSaved(ok) {
  const el = $("#saved");
  if (!el) return;
  el.classList.toggle("is-failed", !ok);
  el.querySelector("span").textContent = ok ? "Saved" : "Not saved";
  if (ok) { el.classList.remove("is-fresh"); void el.offsetWidth; el.classList.add("is-fresh"); }
}
store.onSaved(flashSaved);

store.on((id, part) => {
  if (part === "external") return isTyping(document.activeElement) ? null : render({ instant: true });
  const r = view?.route;
  if (!r || r.view !== "project" || r.id !== id || part === "edit" || part === "research-events") return;
  const p = store.get(id);
  if (!p) return render({ instant: true });
  const slot = $("#nav-slot");
  if (slot) slot.innerHTML = threadNav(p, r.stage);
});

/* ───────── Shared UI ───────── */

function dock(contextHTML, actionsHTML) {
  return `<div class="dock" id="dock"><div class="page dock-inner"><div class="dock-context" id="dock-context">${contextHTML}</div><div class="dock-actions" id="dock-actions">${actionsHTML}</div></div></div>`;
}
const primary = (label, act, { disabled = false, kbd = true, attrs = "" } = {}) =>
  `<button type="button" class="btn btn-primary" data-act="${act}" data-primary ${disabled ? "disabled" : ""} ${attrs}>${label} <span class="arrow">${I.arrow}</span></button>${kbd ? `<span class="kbd" aria-hidden="true">${kbdMod} ↵</span>` : ""}`;

function toast(message, { action, ms = 5000 } = {}) {
  const host = $("#toasts");
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
  host.appendChild(t);
  const close = () => { t.classList.add("is-out"); setTimeout(() => t.remove(), 240); };
  if (action) t.querySelector("button").onclick = () => { action.fn(); close(); };
  setTimeout(close, ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

// Citation card
let popAnchor = null;
function openPop(anchor, p) {
  if (popAnchor === anchor) return closePop();
  closePop();
  const url = anchor.dataset.src, src = sourceIndex(p);
  const n = src.num(url), title = src.title(url), cited = src.citedBy(url), link = isUrl(url);
  const pop = $("#pop");
  pop.innerHTML = `<span class="num">SOURCE ${n || ""}</span>
    <h4>${esc(title || (link ? domain(url) : url))}</h4>
    ${link ? `<p class="url">${esc(shortUrl(url))}</p>` : `<p class="url">Sociai gave this as text, not a link. Check it yourself before you rely on it.</p>`}
    ${cited > 1 ? `<p class="cited">Supports ${cited} items in this research.</p>` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${link ? `<a class="btn btn-line btn-sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open page ${I.ext}</a>` : ""}
      ${$("#sources") ? `<button class="btn btn-ghost btn-sm" data-act="jump-source" data-n="${n}">See in sources</button>` : ""}
    </div>`;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(16, Math.min(r.left + window.scrollX - 12, window.scrollX + document.documentElement.clientWidth - w - 16));
  const below = r.bottom + h + 12 < window.innerHeight - 70;
  pop.style.left = left + "px";
  pop.style.top = (below ? r.bottom + 8 : r.top - h - 8) + window.scrollY + "px";
  anchor.setAttribute("aria-expanded", "true");
  popAnchor = anchor;
}
function closePop() {
  if (!popAnchor) return;
  popAnchor.setAttribute("aria-expanded", "false");
  popAnchor = null;
  $("#pop").hidden = true;
}

// Research drawer
let drawerReturn = null;
function openDrawer(p) {
  closeDrawer();
  drawerReturn = document.activeElement;
  const src = sourceIndex(p);
  const items = p.review.items.filter((i) => i.included);
  const wrap = document.createElement("div");
  wrap.id = "drawer-root";
  wrap.innerHTML = `<div class="drawer-scrim" data-act="close-drawer"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div class="drawer-head"><p class="label" id="drawer-title">Research on ${esc(nameOf(p))}</p>
        <button class="icon-btn" data-act="close-drawer" aria-label="Close research">${I.x}</button></div>
      ${p.research.dossier.headline ? `<p class="overview-headline">${esc(p.research.dossier.headline)}</p>` : ""}
      <p class="read" style="font-size:16px;margin:8px 0 24px">${esc(p.review.summary.text)}</p>
      ${p.research.dossier.contact ? `<p class="label" style="margin-bottom:8px">How to reach them</p>${reachHTML(p.research.dossier.contact, src)}<div style="height:24px"></div>` : ""}
      <p class="label" style="margin-bottom:8px">What the draft may use</p>
      <ol class="items">${items.map((i) => `<li class="item ${i.corrected ? "is-corrected" : ""}"><div><p class="item-text">${i.kind === "work" ? `<span class="item-title">${esc(i.title)}</span>: ` : ""}${esc(i.text)}${citeHTML(i.source, src)}</p>${i.corrected ? '<span class="prov you">Corrected by you</span>' : ""}</div></li>`).join("") || '<li class="muted">Nothing included.</li>'}</ol>
      <div style="margin-top:24px;display:flex;gap:8px"><a class="btn btn-line btn-sm" href="${stageHash(p, "review")}">Edit in review</a></div>
    </aside>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e) => {
    const c = e.target.closest("[data-act='cite']");
    if (c) openPop(c, p);
  });
  $(".drawer [data-act='close-drawer']", wrap).focus();
}
function closeDrawer() {
  const root = $("#drawer-root");
  if (!root) return;
  root.remove();
  closePop();
  drawerReturn?.focus?.();
  drawerReturn = null;
}
function closeMenus() { $$(".menu").forEach((m) => m.remove()); $$("[data-act='refine-menu'], [data-act='account']").forEach((b) => b.setAttribute("aria-expanded", "false")); }

function citeHTML(source, src) {
  if (!source) return ` <span class="cite nolink" title="No source given">?</span>`;
  const n = src.num(source);
  const label = src.title(source) || (isUrl(source) ? domain(source) : source);
  return `<button type="button" class="cite${isUrl(source) ? "" : " nolink"}" data-act="cite" data-src="${esc(source)}" aria-expanded="false" aria-label="Source ${n}: ${esc(label)}">${n}</button>`;
}

// How to reach them: published emails and work phones, a likely email (marked as Sociai's
// inference), and how they ask to be contacted. Every entry cites the page it came from.
function reachHTML(contact, src) {
  const c = { emails: [], phones: [], best_way: "", ...contact };
  const copy = (v, what) => `<button type="button" class="icon-btn" data-act="copy-contact" data-v="${esc(v)}" aria-label="Copy ${what} ${esc(v)}" title="Copy ${what}">${I.copy}</button>`;
  const rows = [
    ...c.emails.map((e) => `<li class="reach-row"><span class="reach-k">Email</span>
      <span class="reach-v"><a class="${e.kind === "likely" ? "inferred" : ""}" href="mailto:${esc(e.address)}">${esc(e.address)}</a>${citeHTML(e.source, src)}
        ${e.kind === "likely" ? `<span class="prov">Likely, not published</span>${e.note ? `<span class="reach-note">${esc(e.note)}</span>` : ""}` : ""}</span>
      ${copy(e.address, "email")}</li>`),
    ...c.phones.map((ph) => `<li class="reach-row"><span class="reach-k">${ph.label ? esc(ph.label) : "Phone"}</span>
      <span class="reach-v"><a href="tel:${esc(ph.number.replace(/[^\d+]/g, ""))}">${esc(ph.number)}</a>${citeHTML(ph.source, src)}</span>${copy(ph.number, "number")}</li>`),
    c.best_way ? `<li class="reach-row"><span class="reach-k">Best way</span><span class="reach-v reach-best">${esc(c.best_way)}${c.best_way_source ? citeHTML(c.best_way_source, src) : ""}</span></li>` : "",
  ].join("");
  return `<ul class="reach">${rows}</ul>${c.emails.length || c.phones.length ? ""
    : `<p class="reach-none">Sociai didn't find a published email or work phone on the pages it read. Their department or company directory is the next place to look.</p>`}`;
}

/* ───────── Composer (desk + Recipient stage) ───────── */

function composerHTML(b, mode) {
  const isNew = mode === "new";
  const pur = PURPOSES.find((x) => x.id === b.category) || PURPOSES[0];
  const lbl = (n, text, forId) => forId
    ? `<label class="label" for="${forId}"><span class="n">${n}</span>&nbsp; ${text}</label>`
    : `<p class="label"><span class="n">${n}</span>&nbsp; ${text}</p>`;
  return `
  <div class="row lead">
    <div class="margin">${lbl("01", "Recipient")}</div>
    <div class="col">
      ${isNew ? `<h1 class="display" id="ask">Who would you like to <em>reach out</em> to?</h1>` : `<h1 class="h2" id="ask" data-focus-on-enter>The brief</h1>`}
      <input class="who-input" id="f-target" name="target" aria-labelledby="ask" aria-describedby="who-hint" autocomplete="off" spellcheck="false"
        placeholder="A name with context, or a link to their page" value="${esc(b.target)}">
      <p class="field-hint" id="who-hint">For example <button type="button" class="link-btn" data-act="example">${esc(pur.who)}</button>. Official pages work best.</p>
      <p class="field-error" id="err-target" hidden>Tell Sociai who this is for: a name with some context, or a link.</p>
    </div>
  </div>
  <div class="row">
    <div class="margin">${lbl("02", "Purpose")}</div>
    <div class="col"><div class="choices" role="radiogroup" aria-label="Purpose">${PURPOSES.map((x) => {
      const on = b.category === x.id;
      return `<button type="button" class="choice" role="radio" aria-checked="${on}" tabindex="${on || (!b.category && x === PURPOSES[0]) ? 0 : -1}" data-act="purpose" data-id="${x.id}"><span class="k" aria-hidden="true"></span>${x.label}</button>`;
    }).join("")}</div></div>
  </div>
  <div class="unfold" id="unfold"><div>
    <div class="row">
      <div class="margin">${lbl("03", "Your ask", "f-goal")}<p class="margin-note">What do you want this message to lead to?</p></div>
      <div class="col">
        <textarea class="textarea serif" id="f-goal" name="goal" rows="3" placeholder="e.g. A 15-minute call about…">${esc(b.goal)}</textarea>
        ${isNew && profile?.main_goal_note && b.goal === profile.main_goal_note ? '<p class="profile-note">Your main goal, from your profile</p>' : ""}
        <div class="suggest" id="suggest" hidden></div>
        <p class="field-error" id="err-goal" hidden>Say what you're hoping for. One sentence is plenty.</p>
      </div>
    </div>
    <div class="row">
      <div class="margin">${lbl("04", "About you", "f-bg")}<p class="margin-note">Optional. Helps Sociai find real common ground. <a class="link-btn" href="#/profile">Edit your profile</a></p></div>
      <div class="col">
        <textarea class="textarea" id="f-bg" name="background" rows="3" placeholder="${esc(pur.about)}">${esc(b.background)}</textarea>
        ${isNew && profile && b.background && b.background === profile.background ? '<p class="profile-note">From your profile</p>' : ""}
      </div>
    </div>
    <div class="row">
      <div class="margin">${lbl("05", "Your voice")}<p class="margin-note">Optional. A few things you've written, so the draft sounds like you.</p></div>
      <div class="col"><div class="samples" id="samples"></div>
        <button type="button" class="link-btn" data-act="add-sample" id="add-sample" style="margin-top:10px">Add a writing sample</button></div>
    </div>
    <div class="row">
      <div class="margin">${lbl("06", "Format")}</div>
      <div class="col format">
        <div><span class="label">Channel</span><div class="choices" role="radiogroup" aria-label="Channel">${CHANNELS.map(([v, l]) =>
          `<button type="button" class="choice choice-sm" role="radio" aria-checked="${b.channel === v}" data-act="channel" data-v="${v}">${l}</button>`).join("")}</div></div>
        <div><label class="label" for="f-words">Length · words</label><div class="length">${LENGTHS.map(([v, l]) =>
          `<button type="button" class="choice choice-sm" aria-pressed="${+b.max_words === v}" data-act="length" data-v="${v}">${l}</button>`).join("")}
          <input class="input num-input" id="f-words" type="number" min="40" max="600" step="10" value="${esc(b.max_words)}"></div></div>
      </div>
    </div>
    <div class="row" id="save-profile-row" hidden><div class="margin"></div><div class="col save-profile">
      <button type="button" class="link-btn" data-act="save-profile">Save these details to your profile</button>
      <span class="muted">Your background, writing samples and format become the starting point for new outreach.</span>
    </div></div>
  </div></div>
  ${isNew ? `<div class="row"><div class="margin"></div><div class="col composer-actions">
      ${primary("Begin research", "begin")}
      <span class="muted" id="credit-note" style="font-size:13.5px">${creditNote()}</span>
    </div></div>` : ""}`;
}

function mountComposer(root, { brief, mode, onChange, onSubmit }) {
  const b = brief;
  // Format defaults from the profile win over a purpose's suggestions.
  const touched = new Set(mode === "edit" || profile ? ["channel", "words"] : []);
  const f = { target: $("#f-target", root), goal: $("#f-goal", root), bg: $("#f-bg", root), words: $("#f-words", root) };
  const unfold = $("#unfold", root);
  const open = (instant) => {
    if (unfold.classList.contains("is-open")) return;
    if (instant) unfold.style.transition = "none";
    unfold.classList.add("is-open");
    if (instant) requestAnimationFrame(() => (unfold.style.transition = ""));
  };
  if (mode === "edit" || b.target || b.category) open(true);
  const sameSamples = (list) => JSON.stringify(list.map((x) => x.trim()).filter(Boolean));
  const differsFromProfile = () => profile && (b.background.trim() !== profile.background.trim()
    || b.channel !== profile.default_channel || +b.max_words !== profile.default_max_words
    || sameSamples(b.samples) !== sameSamples(profile.samples.map((x) => x.body)));
  const showSaveProfile = () => { $("#save-profile-row", root).hidden = !differsFromProfile(); };
  const changed = () => { onChange?.(b); showSaveProfile(); };

  const renderSamples = () => {
    const host = $("#samples", root);
    host.innerHTML = b.samples.map((s, i) => `<div class="sample">
      <label class="vh" for="sample-${i}">Writing sample ${i + 1}</label>
      <textarea class="textarea" id="sample-${i}" data-sample="${i}" placeholder="Paste an email, post or message you wrote">${esc(s)}</textarea>
      <button type="button" class="icon-btn" data-act="remove-sample" data-i="${i}" aria-label="Remove sample ${i + 1}">${I.x}</button></div>`).join("");
    $("#add-sample", root).hidden = b.samples.length >= 10;
    $("#add-sample", root).textContent = b.samples.length ? "Add another sample" : "Add a writing sample";
  };
  renderSamples();

  const setRadio = (act, value) => $$(`[data-act='${act}']`, root).forEach((el) => el.setAttribute("aria-checked", String(el.dataset.v === value)));
  const setWords = (v) => {
    b.max_words = v;
    f.words.value = v;
    $$("[data-act='length']", root).forEach((el) => el.setAttribute("aria-pressed", String(+el.dataset.v === +v)));
  };

  function choosePurpose(id, focus) {
    const prev = PURPOSES.find((x) => x.id === b.category);
    const next = PURPOSES.find((x) => x.id === id);
    b.category = id;
    $$("[data-act='purpose']", root).forEach((el) => {
      const on = el.dataset.id === id;
      el.setAttribute("aria-checked", String(on));
      el.tabIndex = on ? 0 : -1;
      if (on && focus) el.focus();
    });
    // Never overwrite an ask the user wrote; offer the suggestion instead.
    const goal = b.goal.trim();
    const untouched = !goal || (prev && goal === prev.goal);
    const sug = $("#suggest", root);
    if (untouched) {
      b.goal = next.goal;
      f.goal.value = next.goal;
      f.goal.classList.remove("crossfade"); void f.goal.offsetWidth; f.goal.classList.add("crossfade");
      sug.hidden = true;
    } else if (next.goal && goal !== next.goal) {
      sug.innerHTML = `<span>Suggested for ${esc(next.label.toLowerCase())}: “${esc(next.goal)}”</span><button type="button" class="link-btn" data-act="use-suggestion">Use this instead</button>`;
      sug.dataset.goal = next.goal;
      sug.hidden = false;
    } else sug.hidden = true;
    if (!touched.has("channel") && next.channel) { b.channel = next.channel; setRadio("channel", next.channel); }
    if (!touched.has("words") && next.words) setWords(next.words);
    f.bg.placeholder = next.about;
    $("[data-act='example']", root).textContent = next.who;
    open();
    changed();
  }

  function validate() {
    const errT = !b.target.trim(), errG = !b.goal.trim();
    $("#err-target", root).hidden = !errT;
    $("#err-goal", root).hidden = !errG;
    f.target.setAttribute("aria-invalid", String(errT));
    f.goal.setAttribute("aria-invalid", String(errG));
    if (errG) open(true);
    if (errT) f.target.focus(); else if (errG) f.goal.focus();
    return !errT && !errG;
  }

  root.addEventListener("submit", (e) => e.preventDefault());
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t === f.target) { b.target = t.value; if (t.value.trim()) { open(); $("#err-target", root).hidden = true; } }
    else if (t === f.goal) { b.goal = t.value; if (t.value.trim()) $("#err-goal", root).hidden = true; }
    else if (t === f.bg) b.background = t.value;
    else if (t === f.words) { touched.add("words"); const v = parseInt(t.value, 10); if (v > 0) setWords(v); }
    else if (t.dataset.sample !== undefined) b.samples[+t.dataset.sample] = t.value;
    else return;
    changed();
  });
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a || !root.contains(a)) return;
    const act = a.dataset.act;
    if (act === "purpose") choosePurpose(a.dataset.id);
    else if (act === "channel") { touched.add("channel"); b.channel = a.dataset.v; setRadio("channel", a.dataset.v); changed(); }
    else if (act === "length") { touched.add("words"); setWords(+a.dataset.v); changed(); }
    else if (act === "use-suggestion") { const s = $("#suggest", root); b.goal = s.dataset.goal; f.goal.value = b.goal; s.hidden = true; f.goal.focus(); changed(); }
    else if (act === "add-sample") { b.samples.push(""); renderSamples(); $(`#sample-${b.samples.length - 1}`, root).focus(); changed(); }
    else if (act === "remove-sample") { b.samples.splice(+a.dataset.i, 1); renderSamples(); changed(); }
    else if (act === "example") {
      const pur = PURPOSES.find((x) => x.id === b.category) || PURPOSES[0];
      if (pur.id === "other" || /^(a|an|someone)\b/i.test(pur.who)) { f.target.focus(); return; }
      b.target = pur.who; f.target.value = pur.who; f.target.focus(); open(); changed();
    } else if (act === "begin") { if (validate()) onSubmit(b); }
    else if (act === "save-profile") {
      a.disabled = true;
      saveBriefToProfile(b).then((ok) => { a.disabled = false; if (ok) { showSaveProfile(); toast("Saved to your profile."); } });
    }
  });
  root.addEventListener("keydown", (e) => {
    const radio = e.target.closest("[data-act='purpose']");
    if (radio && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const i = PURPOSES.findIndex((x) => x.id === radio.dataset.id);
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      choosePurpose(PURPOSES[(i + d + PURPOSES.length) % PURPOSES.length].id, true);
    }
    if (e.target === f.target && e.key === "Enter") {
      e.preventDefault();
      if (!b.target.trim()) return validate();
      open();
      if (mode === "new" && b.goal.trim()) onSubmit(b); else f.goal.focus();
    }
  });
  showSaveProfile();
  return { validate, brief: b };
}

/* ───────── Desk ───────── */

const deskState = { filter: "all", query: "" };
const FILTERS = [["all", "All"], ["research", "Researching"], ["review", "To review"], ["draft", "Drafting"], ["copied", "Copied"]];

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 50) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 6 * 86400) return Math.round(s / 86400) + "d ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let importHidden = false;

function importBannerHTML() {
  if (importHidden || store.importDismissed) return "";
  const n = store.localProjects().length, prof = store.localProfile();
  if (!n && !prof) return "";
  const what = n ? plural(n, "project") : "Your saved background and writing samples";
  return `<div class="row import-row"><div class="margin"><p class="label">From this browser</p></div><div class="col">
    <div class="import-banner" role="region" aria-label="Import from this browser">
    <p><b>${what}</b> from before accounts ${n === 1 ? "is" : "are"} still saved in this browser only. Add ${n === 1 ? "it" : "them"} to your account so ${n === 1 ? "it's" : "they're"} available wherever you sign in.</p>
    <div class="gate-actions"><button type="button" class="btn btn-primary btn-sm" data-act="import-local">Import ${n ? plural(n, "project") : "them"}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="import-later">Not now</button>
      <button type="button" class="link-btn" data-act="import-never">Don't ask again</button></div></div></div></div>`;
}

async function importLocal() {
  const projects = store.localProjects(), prof = store.localProfile();
  store.importProjects(projects);
  if (prof && !profile.background && !profile.samples.length) {
    await saveBriefToProfile({ background: prof.background || "", samples: prof.samples || [], channel: profile.default_channel, max_words: profile.default_max_words });
  }
  store.forgetLocal();
  toast(projects.length ? `Imported ${plural(projects.length, "project")} into your account.` : "Imported your saved details into your profile.");
  render({ instant: true });
}

const summarize = (p) => ({
  name: nameOf(p), target: p.brief.target || "", goal: p.brief.goal || "", category: p.brief.category || "",
  headline: p.research.dossier?.headline || "", state: stateOf(p), stages: available(p), resume: resumeStage(p),
  running: p.research.status === "running" || p.draft.status === "running",
});

// A new outreach starts from the profile: the main goal (as the purpose and the ask),
// background, writing samples and format. The resume text is added on the server.
function newBrief() {
  const purpose = MAIN_GOALS.find(([v]) => v === profile.main_goal)?.[2] || "";
  const goal = profile.main_goal_note || PURPOSES.find((x) => x.id === purpose)?.goal || "";
  return {
    target: "", category: purpose, goal, background: profile.background || "", samples: profile.samples.map((x) => x.body),
    channel: profile.default_channel || "email", max_words: profile.default_max_words || 160,
  };
}

function deskView(_, from) {
  const all = store.list();
  const brief = store.pending || newBrief();
  $("#main").innerHTML = `<div class="ruled"><div class="page">
    ${importBannerHTML()}
    ${setupNudgeHTML()}
    <form class="composer" id="composer" novalidate>${composerHTML(brief, "new")}</form>
    ${all.length ? `<section class="ledger" aria-labelledby="ledger-title">
      <div class="row"><div class="margin"><h2 class="label" id="ledger-title">Correspondence</h2><p class="margin-note">Everything you've started, newest first. Saved to your account.</p></div>
        <div class="col" style="max-width:none">
          <div class="ledger-tools">
            <label class="search"><span class="vh">Search outreach</span>${I.search}<input class="input" type="search" id="ledger-q" placeholder="Search people and goals" value="${esc(deskState.query)}"><span class="kbd" aria-hidden="true">/</span></label>
            <div class="filters" id="filters" role="group" aria-label="Filter by stage"></div>
          </div>
          <ol class="rows" id="rows"></ol>
        </div></div>
    </section>` : `<section class="primer" aria-label="How Sociai works"><div class="row"><div class="margin"><p class="label">How it works</p></div><div class="col" style="max-width:none"><ol>
      <li><h3>Research</h3><p>Sociai reads their official pages first and cites a source for every fact it reports.</p></li>
      <li><h3>Review</h3><p>You check the facts, fix what's wrong, and pick the threads worth writing about.</p></li>
      <li><h3>Draft</h3><p>A message in your own voice. Anything unknown stays a [PLACEHOLDER]. Sending is up to you.</p></li>
    </ol></div></div></section>`}
  </div></div>`;

  mountComposer($("#composer"), {
    brief, mode: "new",
    onChange: (b) => store.setPending(b),
    onSubmit: (b) => {
      if (account.credits === 0) {
        $("#credit-note").classList.add("is-warn");
        return toast("You're out of credits, so a new research run can't start.", { action: { label: "Get credits", fn: () => go("#/pricing") } });
      }
      const clean = { ...b, samples: b.samples.filter((s) => s.trim()) };
      const p = store.create(clean);
      store.setPending(null);
      startResearch(p.id);
      go(stageHash(p, "research"));
    },
  });

  $("#main").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='setup-later']")) { setupNudgeHidden = true; $(".setup-row")?.remove(); return; }
    const a = e.target.closest("[data-act^='import-']");
    if (!a) return;
    if (a.dataset.act === "import-local") { a.disabled = true; importLocal(); }
    else {
      if (a.dataset.act === "import-never") store.dismissImport();
      importHidden = true;
      $(".import-row")?.remove();
    }
  });

  if (!all.length) return () => {};
  const rows = $("#rows"), filters = $("#filters");
  const drawRows = () => {
    const list = store.list();
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, 0]));
    list.forEach((p) => { counts.all++; counts[p.state.key] = (counts[p.state.key] || 0) + 1; });
    filters.innerHTML = FILTERS.filter(([k]) => k === "all" || counts[k]).map(([k, l]) =>
      `<button type="button" class="filter" data-act="filter" data-k="${k}" aria-pressed="${deskState.filter === k}">${l} <span class="n">${counts[k]}</span></button>`).join("");
    const q = deskState.query.trim().toLowerCase();
    const shown = list.filter((p) => (deskState.filter === "all" || p.state.key === deskState.filter)
      && (!q || [p.name, p.target, p.goal, p.headline].join(" ").toLowerCase().includes(q)));
    rows.innerHTML = shown.map((p) => {
      const st = p.state, av = p.stages || [], cur = p.resume || "recipient";
      const pur = PURPOSES.find((x) => x.id === p.category);
      return `<li class="entry" data-id="${p.id}">
        <a class="entry-link" href="#/p/${p.id}" data-act="open" data-id="${p.id}">
          <span class="mini" aria-hidden="true">${STAGES.map((s) => `<i class="${s === cur ? "cur" : av.includes(s) ? "on" : ""}"></i>`).join("")}</span>
          <span class="who"><span class="entry-name">${esc(p.name)}</span>
            <span class="entry-role">${esc(p.headline || (p.running ? "Researching…" : "Not researched yet"))}</span></span>
          <span class="entry-goal">${pur ? `<span class="tag">${esc(pur.label)}</span>` : ""}${esc(p.goal)}</span>
          <span class="entry-state ${st.cls || ""}">${st.text}</span>
          <time class="entry-time" datetime="${new Date(p.updatedAt).toISOString()}">${ago(p.updatedAt)}</time>
          <span class="entry-go" aria-hidden="true">${I.arrow}</span>
          <span class="vh">, open at ${STAGE_LABEL[cur]}</span>
        </a>
        <button type="button" class="icon-btn entry-del" data-act="delete" data-id="${p.id}" aria-label="Delete outreach to ${esc(p.name)}">${I.trash}</button>
      </li>`;
    }).join("") || `<li class="empty">${q ? `Nothing matches “${esc(deskState.query)}”.` : "Nothing at this stage."}</li>`;
  };
  drawRows();

  // Coming back from a project: its name settles back into its row.
  if (from?.view === "project") {
    const nm = $(`.entry[data-id="${from.id}"] .entry-name`);
    if (nm) { nm.style.viewTransitionName = "who"; nm.dataset.vt = "1"; }
  }

  const ledger = $(".ledger");
  ledger.addEventListener("input", (e) => { if (e.target.id === "ledger-q") { deskState.query = e.target.value; drawRows(); } });
  ledger.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "filter") { deskState.filter = a.dataset.k; drawRows(); }
    else if (a.dataset.act === "open") {
      const nm = $(".entry-name", a);
      nm.style.viewTransitionName = "who"; nm.dataset.vt = "1";
    } else if (a.dataset.act === "delete") {
      a.disabled = true;
      store.remove(a.dataset.id).then(
        (gone) => toast(`Deleted “${nameOf(gone)}”`, { action: { label: "Undo", fn: () => store.restore(gone) }, ms: 7000 }),
        () => { a.disabled = false; toast("Couldn't delete that project. Try again."); },
      );
    }
  });
  const off = store.on((id, part) => { if (part !== "edit" && part !== "research-events") drawRows(); });
  const clock = setInterval(drawRows, 60000);
  return () => { off(); clearInterval(clock); };
}

/* ───────── Stage: Recipient ───────── */

function recipientView(p) {
  const brief = { samples: [], ...structuredClone(p.brief) };
  $("#main").innerHTML = `<div class="ruled"><div class="page"><form class="composer" id="composer" novalidate>
    ${composerHTML(brief, "edit")}
    <div class="row"><div class="margin"></div><div class="col"><div class="brief-changed" id="changed" hidden></div></div></div>
  </form></div></div>${dock("", "")}`;

  const drawDock = () => {
    const q = store.get(p.id), r = q.research, changed = briefChanged(q);
    let ctx = "Changes save as you type.", acts = "";
    if (r.status === "idle" || (r.status === "error" && !r.dossier)) acts = primary("Begin research", "research");
    else if (r.status === "running") acts = `<a class="btn btn-primary" data-primary href="${stageHash(q, "research")}">See research in progress <span class="arrow">${I.arrow}</span></a>`;
    else if (changed) {
      ctx = "Your brief changed. Re-running replaces your fact checks and thread picks; drafts are kept.";
      acts = `<a class="btn btn-ghost" href="${stageHash(q, "review")}">Keep current research</a>${primary("Re-run research", "research")}`;
    } else acts = `<a class="btn btn-primary" data-primary href="${stageHash(q, "review")}">Continue to review <span class="arrow">${I.arrow}</span></a>`;
    $("#dock-context").innerHTML = ctx;
    $("#dock-actions").innerHTML = acts;
  };
  drawDock();

  const composer = mountComposer($("#composer"), {
    brief, mode: "edit",
    onChange: (b) => {
      store.update(p.id, (q) => { q.brief = { ...b, samples: [...b.samples] }; }, "edit");
      $("#crumb-who") && ($("#crumb-who").textContent = nameOf(store.get(p.id)));
      $("#crumb-goal") && ($("#crumb-goal").textContent = b.goal);
      drawDock();
    },
    onSubmit: () => {},
  });
  const onDock = (e) => {
    const a = e.target.closest("[data-act='research']");
    if (!a || !composer.validate()) return;
    store.update(p.id, (q) => { q.brief.samples = q.brief.samples.filter((s) => s.trim()); }, "edit");
    startResearch(p.id);
    go(stageHash(p, "research"));
  };
  $("#dock").addEventListener("click", onDock);
  const off = store.on((id, part) => { if (id === p.id && part !== "edit" && part !== "research-events") drawDock(); });
  return off;
}

/* ───────── Stage: Research ───────── */

function researchView(p) {
  const name = nameOf(p);
  $("#main").innerHTML = `<div class="page"><div class="research">
    <section class="loom-card" aria-labelledby="rs-title">
      <p class="label">Research · ${esc(name)}</p>
      <div class="loom-status"><h1 class="h2" id="rs-title" data-focus-on-enter></h1><span class="elapsed" id="elapsed"></span></div>
      <div class="loom-host" id="loom"></div>
      <div class="loom-legend" aria-hidden="true"><span><i class="lg-q"></i>Search</span><span><i class="lg-f"></i>Page found</span><span><i class="lg-r"></i>Page read</span></div>
      <div id="rs-extra"></div>
    </section>
    <aside class="fieldlog" aria-labelledby="log-title">
      <p class="label" id="log-title">Field log</p>
      <p class="loom-stats" id="stats"></p>
      <ol id="log"></ol>
    </aside>
  </div></div>${dock("", "")}`;

  const loom = new Loom($("#loom"), { initials: initials(name) });
  const log = $("#log");
  let seen = 0, settleTimer = null;
  const fetchRows = new Map();

  const titleFor = (q) => {
    const r = q.research;
    if (r.status === "done") return "Research complete";
    if (r.status === "error") return r.events.length ? "Research didn't finish" : "Research didn't start";
    const last = [...r.events].reverse().find((e) => e.kind !== "found") || r.events[r.events.length - 1];
    if (!last) return "Starting the search";
    return {
      search: () => `Searching for “${trunc(last.query, 48)}”`,
      found: () => `Looking through ${plural(last.results.length, "result")}`,
      fetch: () => `Reading ${domain(last.url)}`,
      read: () => `Read ${domain(last.url)}`,
      read_failed: () => `Couldn't open ${domain(last.url)}`,
      composing: () => "Connecting what it found",
    }[last.kind]?.() || "Researching";
  };

  const logRow = (e) => {
    const time = `<time>${mmss(e.t || 0)}</time>`;
    if (e.kind === "search") return `<li class="log">${time}<div><span class="verb">Searched</span><span class="what q">“${esc(e.query)}”</span></div></li>`;
    if (e.kind === "found") {
      const doms = [...new Set((e.results || []).map((r) => domain(r.url)))].slice(0, 3).join(" · ");
      return `<li class="log">${time}<div><span class="verb">Found</span><span class="what">${plural((e.results || []).length, "page")}<span class="dom">${esc(doms)}</span></span></div></li>`;
    }
    if (e.kind === "composing") return `<li class="log is-compose">${time}<div><span class="verb">Writing</span><span class="what">Organising what it read into a cited dossier</span></div></li>`;
    return "";
  };

  const applyEvents = (events, instant) => {
    for (const e of events) {
      if (e.kind === "fetch") {
        const li = document.createElement("li");
        li.className = "log is-reading";
        li.innerHTML = `<time>${mmss(e.t || 0)}</time><div><span class="verb">Reading</span><span class="what">${esc(domain(e.url))}<span class="dom">${esc(trunc(shortUrl(e.url), 60))}</span></span></div>`;
        log.appendChild(li);
        fetchRows.set(normUrl(e.url), li);
      } else if (e.kind === "read" || e.kind === "read_failed") {
        const li = fetchRows.get(normUrl(e.url)) || [...fetchRows.values()].reverse().find((x) => x.classList.contains("is-reading"));
        if (li) {
          li.className = "log" + (e.kind === "read_failed" ? " is-failed" : "");
          $(".verb", li).textContent = e.kind === "read" ? "Read" : "Couldn't open";
          if (e.kind === "read" && e.title) $(".what", li).firstChild.textContent = trunc(e.title, 80);
        }
      } else if (logRow(e)) log.insertAdjacentHTML("beforeend", logRow(e));
    }
    if (instant) $$(".log", log).forEach((li) => (li.style.animation = "none"));
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (nearBottom || instant) log.scrollTop = log.scrollHeight;
    loom.apply(events, { instant });
  };

  const draw = (instant) => {
    const q = store.get(p.id);
    if (!q) return;
    const r = q.research;
    if (r.events.length < seen) { // research restarted
      seen = 0; fetchRows.clear(); log.innerHTML = "";
      return researchViewRestart();
    }
    applyEvents(r.events.slice(seen), instant);
    seen = r.events.length;
    loom.setState(r.status === "done" ? "done" : r.status === "error" ? "error" : r.events.some((e) => e.kind === "composing") ? "composing" : "running");
    $("#rs-title").textContent = titleFor(q);
    $(".loom-card").classList.toggle("no-map", r.status === "error" && !r.events.length); // nothing to map; show the reason up top
    $("#stats").textContent = loom.stats().text;
    drawExtra(q);
    drawDock(q);
  };

  const drawExtra = (q) => {
    const r = q.research, extra = $("#rs-extra");
    const secs = ((r.finishedAt || Date.now()) - (r.startedAt || Date.now())) / 1000;
    $("#elapsed").textContent = r.status === "running" ? mmss(secs) : r.status === "done" ? `Took ${mmss(secs)}` : "";
    if (r.status === "error") {
      extra.innerHTML = `<div class="failure" role="alert"><p>${r.events.length ? "The research stopped before it finished." : "The research didn't start."} ${r.dossier ? "Your earlier research is still there." : "Nothing was lost from your brief."}</p><code>${esc(r.error)}</code>${r.errorAction === "pricing" ? `<div class="actions"><a class="btn btn-primary btn-sm" href="#/pricing">Get more credits</a></div>` : ""}</div>`;
    } else if (r.status === "running" && secs > 150) {
      extra.innerHTML = `<p class="notice">This is taking longer than usual. It's still working on the server.</p>`;
    } else if (r.status === "running" && secs > 40) {
      extra.innerHTML = `<p class="notice">Careful research usually takes one to three minutes. It keeps going if you leave this page, so you can return to the desk.</p>`;
    } else extra.innerHTML = "";
  };

  const drawDock = (q) => {
    const r = q.research;
    let ctx = "", acts = "";
    if (r.status === "running") {
      ctx = `Reading public pages about <b>${esc(nameOf(q))}</b>. Every fact will carry its source.`;
      acts = (r.dossier ? `<a class="btn btn-ghost" href="${stageHash(q, "review")}">Back to earlier research</a>` : "") + `<a class="btn btn-line" href="#/">Back to desk</a>`;
    } else if (r.status === "error") {
      ctx = "Check the brief, then try again.";
      acts = `<a class="btn btn-ghost" href="${stageHash(q, "recipient")}">Edit the brief</a>${primary("Try again", "retry")}`;
    } else {
      ctx = `Read <b>${loom.stats().read}</b> pages. Next, check what it found.`;
      acts = `<button class="btn btn-ghost" data-act="retry">${I.redo} Re-run</button><a class="btn btn-primary" data-primary href="${stageHash(q, "review")}">Review the research <span class="arrow">${I.arrow}</span></a>`;
    }
    $("#dock-context").innerHTML = ctx;
    $("#dock-actions").innerHTML = acts;
  };

  const researchViewRestart = () => render({ instant: true });
  draw(true);

  $("#dock").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='retry']")) startResearch(p.id);
  });
  const off = store.on((id, part) => {
    if (id !== p.id || part === "edit") return;
    const q = store.get(id);
    draw(false);
    if (part === "research" && q?.research.status === "done" && !settleTimer) {
      // Let the threads finish connecting, then move on to review.
      settleTimer = setTimeout(() => {
        const r = view?.route;
        if (r?.view === "project" && r.id === p.id && r.stage === "research") go(stageHash(q, "review"));
      }, reduced.matches ? 300 : 1400);
    }
  });
  const clock = setInterval(() => { const q = store.get(p.id); if (q?.research.status === "running") drawExtra(q); }, 1000);
  return () => { off(); clearInterval(clock); clearTimeout(settleTimer); loom.destroy(); };
}

/* ───────── Stage: Review ───────── */

function reviewView(p) {
  const id = p.id;
  const editing = new Set();
  const get = () => store.get(id);
  const d = p.research.dossier;
  const name = nameOf(p);

  const itemHTML = (it, src) => {
    const isEditing = editing.has(it.id);
    const text = (it.kind === "work" ? `<span class="item-title">${esc(it.title)}</span>: ` : "") + esc(it.text);
    const body = isEditing
      ? `<div class="edit-box"><label class="vh" for="edit-${it.id}">Correct this ${it.kind === "work" ? "description" : "fact"}</label>
          ${it.kind === "work" ? `<span class="item-title read" style="font-size:16px">${esc(it.title)}</span>` : ""}
          <textarea class="textarea serif" id="edit-${it.id}" data-edit="${it.id}" rows="2">${esc(it.text)}</textarea>
          <div class="actions"><button type="button" class="btn btn-primary btn-sm" data-act="save-edit" data-id="${it.id}">Save correction</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-edit" data-id="${it.id}">Cancel</button><span class="kbd" aria-hidden="true">↵ save · esc</span></div></div>`
      : `<p class="item-text">${text}${citeHTML(it.source, src)}</p>
         ${it.corrected ? `<div class="prov-row"><span class="prov you">${I.pen.replace("<svg", '<svg width="12" height="12"')} Corrected by you</span><button type="button" class="link-btn" data-act="revert" data-id="${it.id}">Undo correction</button></div>
         <p class="item-original"><span class="vh">Originally: </span>${esc(it.original)}</p>` : ""}`;
    return `<li class="item${it.included ? "" : " is-out"}${it.corrected ? " is-corrected" : ""}" data-id="${it.id}">
      <button type="button" class="tick" role="checkbox" aria-checked="${it.included}" data-act="toggle" data-id="${it.id}" aria-label="Use this in the draft">${svg('<path d="m3.5 8.5 3 3 6-7"/>')}</button>
      <div class="item-body">${body}</div>
      <div class="item-actions">${isEditing ? "" : `<button type="button" class="icon-btn" data-act="edit" data-id="${it.id}" aria-label="Correct this" title="Correct this">${I.pen}</button>`}</div>
    </li>`;
  };
  const slipHTML = (h) => `<li class="slip-wrap${h.custom ? " custom" : ""}" data-id="${h.id}">
    <button type="button" class="slip" data-act="hook" data-id="${h.id}" aria-pressed="${h.selected}"${h.selected ? ` style="view-transition-name:t-${h.id};view-transition-class:thread"` : ""}>
      <span class="k" aria-hidden="true"></span><span>${esc(h.text)}${h.custom ? '<span class="prov you yours">Your thread</span>' : ""}</span></button>
    ${h.custom ? `<button type="button" class="icon-btn" data-act="remove-hook" data-id="${h.id}" aria-label="Remove this thread">${I.x}</button>` : ""}
  </li>`;
  const summaryHTML = (q) => {
    const s = q.review.summary;
    if (editing.has("summary")) return `<div class="edit-box" style="margin-top:16px"><label class="vh" for="edit-summary">Correct the overview</label>
      <textarea class="textarea serif" id="edit-summary" data-edit="summary" rows="5">${esc(s.text)}</textarea>
      <div class="actions"><button type="button" class="btn btn-primary btn-sm" data-act="save-edit" data-id="summary">Save correction</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-edit" data-id="summary">Cancel</button></div></div>`;
    return `<p class="summary read ${s.corrected ? "" : "inferred"}" style="${s.corrected ? "color:var(--pen)" : ""}">${esc(s.text)}</p>
      <div class="prov-row">${s.corrected ? `<span class="prov you">Corrected by you</span><button type="button" class="link-btn" data-act="revert" data-id="summary">Undo correction</button>`
        : `<span class="prov">Sociai's summary of the sources below</span><button type="button" class="link-btn" data-act="edit" data-id="summary">Correct it</button>`}</div>`;
  };

  const q0 = get();
  const src0 = sourceIndex(q0);
  const facts = q0.review.items.filter((i) => i.kind === "fact"), work = q0.review.items.filter((i) => i.kind === "work");
  const sec = (sid, label, note, body) => `<section class="sec row" id="${sid}" aria-labelledby="${sid}-l">
    <div class="margin"><h2 class="label" id="${sid}-l">${label}</h2>${note ? `<p class="margin-note">${note}</p>` : ""}</div><div class="col">${body}</div></section>`;

  $("#main").innerHTML = `<div class="ruled"><div class="page review">
    <section class="sec row" style="padding-top:48px" aria-labelledby="ov-name">
      <div class="margin"><p class="label">Overview</p><ul class="legend" aria-label="Key">
        <li><span class="sw sw-src"></span>From a cited page</li><li><span class="sw sw-you"></span>Your correction</li><li><span class="sw sw-inf"></span>Sociai's inference</li></ul></div>
      <div class="col">
        ${d.headline ? `<p class="overview-headline">${esc(d.headline)}</p>` : ""}
        <h1 class="overview-name" id="ov-name" data-focus-on-enter>${esc(name)}</h1>
        <div id="summary">${summaryHTML(q0)}</div>
      </div>
    </section>
    ${d.contact ? sec("reach", "How to reach them", "From their own and their institution's pages. Check before you send.", reachHTML(d.contact, src0)) : ""}
    ${q0.review.cautions.length ? sec("cautions", "Before you go on", "Things Sociai couldn't confirm. Read these first.",
      `<ul class="cautions" id="caution-list">${q0.review.cautions.map((c) => `<li class="caution${c.noted ? " is-noted" : ""}" data-id="${c.id}"><p>${esc(c.text)}</p>
        <button type="button" class="choice choice-sm" data-act="note" data-id="${c.id}" aria-pressed="${c.noted}">${c.noted ? "Noted" : "Mark as noted"}</button></li>`).join("")}</ul>`) : ""}
    ${sec("facts", `Facts · <span class="n" id="facts-n"></span>`, "Untick anything the draft shouldn't use. Use the pen to correct a fact.",
      facts.length ? `<ol class="items" id="fact-list">${facts.map((i) => itemHTML(i, src0)).join("")}</ol>` : `<p class="empty">Sociai didn't find any facts it could cite.</p>`)}
    ${work.length ? sec("work", "Recent work", "", `<ol class="items" id="work-list">${work.map((i) => itemHTML(i, src0)).join("")}</ol>`) : ""}
    ${sec("threads", "Threads", "Pick the connections worth writing about. The draft is built around them.",
      `<ul class="threads" id="hook-list">${q0.review.hooks.map(slipHTML).join("")}</ul>
       <form class="add-thread" id="add-thread"><label class="vh" for="new-thread">Add your own thread</label>
         <input class="input" id="new-thread" placeholder="Add a connection of your own, e.g. we both studied at…" autocomplete="off">
         <button class="btn btn-line" type="submit">Add</button></form>`)}
    ${sec("notes", "For the draft", "Optional.",
      `<label class="vh" for="review-notes">Notes for the draft</label><textarea class="textarea" id="review-notes" rows="2" placeholder="Anything to mention or avoid, e.g. “we met at NeurIPS last year”">${esc(q0.review.notes)}</textarea>`)}
    ${sec("sources", "Sources", "Every page cited above.", `<ol class="biblio" id="source-list"></ol>`)}
  </div></div>${dock("", "")}`;

  const drawSources = (q) => {
    const src = sourceIndex(q);
    $("#source-list").innerHTML = src.list.map((u, i) => `<li id="src-${i + 1}"><span class="n">[${i + 1}]</span>${isUrl(u)
      ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><span class="t">${esc(src.title(u) || domain(u))}</span><span class="u">${esc(shortUrl(u))}</span></a>`
      : `<span><span class="t">${esc(u)}</span><span class="u">Not a link. Verify it yourself.</span></span>`}</li>`).join("") || '<li class="muted">No sources listed.</li>';
  };
  drawSources(q0);

  let lastCount = null;
  const drawDock = () => {
    const q = get(), r = q.review;
    const k = r.hooks.filter((h) => h.selected).length;
    const fIn = r.items.filter((i) => i.kind === "fact" && i.included).length;
    const fAll = r.items.filter((i) => i.kind === "fact").length;
    $("#facts-n").textContent = `${fIn} of ${fAll} in use`;
    const needs = r.hooks.length > 0 && k === 0;
    const has = q.draft.versions.length > 0, busy = q.draft.status === "running";
    const bump = lastCount !== null && lastCount !== k ? " bump" : "";
    lastCount = k;
    $("#dock-context").innerHTML = needs
      ? `<span>Choose at least one thread to write about.</span>`
      : `<span><b class="count${bump}">${k}</b> ${k === 1 ? "thread" : "threads"} · <b>${fIn}</b> ${fIn === 1 ? "fact" : "facts"}${has ? " · your current draft stays in history" : ""}</span>`;
    $("#dock-actions").innerHTML = (has || busy ? `<a class="btn btn-ghost" href="${stageHash(q, "draft")}">${busy ? "Draft in progress" : "Current draft"}</a>` : "")
      + primary(has ? "Write a new draft" : "Write the draft", "draft", { disabled: needs || busy });
  };
  drawDock();

  const replaceItem = (itemId, extraClass) => {
    const q = get(), it = q.review.items.find((i) => i.id === itemId);
    const li = $(`.item[data-id="${itemId}"]`);
    if (!it || !li) return;
    li.outerHTML = itemHTML(it, sourceIndex(q));
    const fresh = $(`.item[data-id="${itemId}"]`);
    if (extraClass) fresh.classList.add(extraClass);
    return fresh;
  };
  const saveEdit = (eid) => {
    const ta = $(`[data-edit="${eid}"]`);
    const text = ta.value.trim();
    editing.delete(eid);
    if (eid === "summary") {
      store.update(id, (q) => { if (text) Object.assign(q.review.summary, { text, corrected: text !== q.review.summary.original }); }, "review");
      $("#summary").innerHTML = summaryHTML(get());
      return;
    }
    store.update(id, (q) => { const it = q.review.items.find((i) => i.id === eid); if (text) Object.assign(it, { text, corrected: text !== it.original }); }, "review");
    const li = replaceItem(eid, get().review.items.find((i) => i.id === eid).corrected ? "just-corrected" : "");
    $(".icon-btn", li)?.focus();
  };

  const root = $("#main");
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act, aid = a.dataset.id;
    if (act === "cite") return openPop(a, get());
    if (act === "toggle") {
      store.update(id, (q) => { const it = q.review.items.find((i) => i.id === aid); it.included = !it.included; }, "review");
      const it = get().review.items.find((i) => i.id === aid);
      a.setAttribute("aria-checked", String(it.included));
      a.closest(".item").classList.toggle("is-out", !it.included);
      drawDock();
    } else if (act === "edit") {
      editing.add(aid);
      if (aid === "summary") $("#summary").innerHTML = summaryHTML(get()); else replaceItem(aid);
      const ta = $(`[data-edit="${aid}"]`);
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    } else if (act === "save-edit") saveEdit(aid);
    else if (act === "cancel-edit") {
      editing.delete(aid);
      if (aid === "summary") $("#summary").innerHTML = summaryHTML(get()); else $(".icon-btn", replaceItem(aid))?.focus();
    } else if (act === "revert") {
      store.update(id, (q) => {
        const t = aid === "summary" ? q.review.summary : q.review.items.find((i) => i.id === aid);
        Object.assign(t, { text: t.original, corrected: false });
      }, "review");
      if (aid === "summary") $("#summary").innerHTML = summaryHTML(get()); else replaceItem(aid);
    } else if (act === "hook") {
      store.update(id, (q) => { const h = q.review.hooks.find((x) => x.id === aid); h.selected = !h.selected; }, "review");
      const on = get().review.hooks.find((x) => x.id === aid).selected;
      a.setAttribute("aria-pressed", String(on));
      a.style.viewTransitionName = on ? `t-${aid}` : "";
      a.style.viewTransitionClass = on ? "thread" : "";
      drawDock();
    } else if (act === "remove-hook") {
      store.update(id, (q) => { q.review.hooks = q.review.hooks.filter((x) => x.id !== aid); }, "review");
      a.closest(".slip-wrap").remove();
      drawDock();
    } else if (act === "note") {
      store.update(id, (q) => { const c = q.review.cautions.find((x) => x.id === aid); c.noted = !c.noted; }, "review");
      const on = get().review.cautions.find((x) => x.id === aid).noted;
      a.setAttribute("aria-pressed", String(on));
      a.textContent = on ? "Noted" : "Mark as noted";
      a.closest(".caution").classList.toggle("is-noted", on);
    } else if (act === "draft" && !a.disabled) {
      const has = get().draft.versions.length > 0;
      startDraft(id, { label: has ? "New draft from review" : "First draft" });
      go(stageHash(get(), "draft"));
    }
  });
  root.addEventListener("keydown", (e) => {
    const ta = e.target.closest("[data-edit]");
    if (!ta) return;
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); saveEdit(ta.dataset.edit); }
    if (e.key === "Escape") { e.stopPropagation(); $(`[data-act="cancel-edit"][data-id="${ta.dataset.edit}"]`).click(); }
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "review-notes") store.update(id, (q) => { q.review.notes = e.target.value; }, "edit");
  });
  $("#add-thread").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#new-thread"), text = input.value.trim();
    if (!text) return input.focus();
    const h = { id: uid(), text, selected: true, custom: true };
    store.update(id, (q) => { q.review.hooks.push(h); }, "review");
    $("#hook-list").insertAdjacentHTML("beforeend", slipHTML(h));
    input.value = "";
    drawDock();
  });
  const off = store.on((pid, part) => {
    if (pid !== id || (part !== "draft" && part !== "research")) return;
    if (get().research.dossier !== d) return render({ instant: true }); // a re-run finished: show the new research
    drawDock();
  });
  return off;
}

/* ───────── Stage: Draft ───────── */

function draftView(p) {
  const id = p.id;
  const get = () => store.get(id);
  const ui = { focus: false, confirmCopy: false };
  $("#main").innerHTML = `<div class="page"><div class="studio" id="studio">
    <svg class="studio-threads-svg" id="tsvg" aria-hidden="true"></svg>
    <aside class="studio-margin" id="smargin" aria-label="Threads and checks"></aside>
    <article class="sheet" id="sheet" aria-label="Your message"></article>
  </div></div>${dock("", "")}`;
  const sheet = $("#sheet"), margin = $("#smargin");

  const drawMargin = () => {
    const q = get(), v = currentVersion(q), busy = q.draft.status === "running";
    const threads = (busy && q.draft.pending?.threads) || v?.threads || [];
    const text = v ? `${v.subject}\n${v.body}` : "";
    const phs = placeholders(text);
    const qs = v?.notes.questions || [];
    margin.innerHTML = `
      <section><h2 class="label">Threads</h2>${threads.length ? `<ul class="pins">${threads.map((t) =>
        `<li class="pin" data-pin style="view-transition-name:t-${t.id};view-transition-class:thread">${esc(t.text)}</li>`).join("")}</ul>` : '<p class="margin-note">No threads chosen.</p>'}</section>
      ${v ? `<section aria-live="polite"><h2 class="label">Check before sending</h2>
        ${phs.length ? `<p class="margin-note" style="margin:0">${plural(phs.length, "placeholder")} left to fill:</p><div class="ph-list">${phs.map((ph) =>
          `<button type="button" class="ph-chip" data-act="ph" data-ph="${esc(ph)}" title="Jump to it">${esc(ph)}</button>`).join("")}</div>` : ""}
        ${qs.length ? `<ul class="checks" style="margin-top:12px">${qs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${!phs.length && !qs.length ? `<p class="all-clear">${I.check} Nothing left to fill in.</p>` : ""}</section>
      ${v.notes.personal.length ? `<section><h2 class="label">Why it's personal</h2><ul class="notes-list">${v.notes.personal.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
      ${v.notes.voice ? `<section><h2 class="label">Your voice</h2><p class="voice">${esc(v.notes.voice)}</p></section>` : ""}`
      : `<section><h2 class="label">Check before sending</h2><p class="margin-note">Shows up once the draft is written.</p></section>`}`;
  };

  const backdropHTML = (s) => esc(s).replace(/\[[^\[\]\n]{1,80}\]/g, (m) => `<mark>${m}</mark>`) + "\n";
  const autosize = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

  const drawSheet = (reveal) => {
    const q = get(), v = currentVersion(q), busy = q.draft.status === "running", err = q.draft.status === "error";
    const to = `<span class="sheet-to">To <b>${esc(nameOf(q))}</b> · ${esc(q.brief.channel || "email")}</span>`;
    const failure = err ? `<div class="failure" role="alert" style="margin:16px 0 0"><p>The draft didn't come through.${v ? " Your current draft is untouched." : ""}</p><code>${esc(q.draft.error)}</code>
      <div class="actions"><button class="btn btn-line btn-sm" data-act="retry-draft">Try again</button></div></div>` : "";
    if (!v) {
      const n = q.draft.pending?.threads?.length || 0;
      sheet.innerHTML = `${busy ? '<div class="busy-line" aria-hidden="true"></div>' : ""}<header class="sheet-head">${to}${busy ? '<span class="status">Writing</span>' : ""}</header>
        ${failure}
        ${busy ? `<div class="writing" role="status"><p>Writing in your voice${n ? `, around ${plural(n, "thread")}` : ""}…</p>
          ${Array.from({ length: 9 }, (_, i) => `<div class="line" style="animation-delay:${120 + i * 90}ms"></div>`).join("")}</div>` : ""}`;
      return;
    }
    const showSubject = (q.brief.channel || "email") === "email" || v.subject;
    const pend = q.draft.pending;
    sheet.innerHTML = `${busy ? '<div class="busy-line" aria-hidden="true"></div>' : ""}
      <header class="sheet-head">${to}
        <div class="sheet-tools">
          ${busy ? `<span class="status" role="status" style="align-self:center;margin-right:8px">${esc(pend?.revise ? pend.label.replace(/^Refined: /, "Rewriting: ") : "Writing a fresh draft")}…</span>` : ""}
          <button class="icon-btn" data-act="drawer" aria-label="Show research" title="Research">${I.book}</button>
          <button class="icon-btn" data-act="focus" aria-pressed="${ui.focus}" aria-label="Focus mode (${kbdMod} .)" title="Focus mode (${kbdMod} .)">${I.focus}</button>
        </div></header>
      ${failure}
      ${showSubject ? `<div class="subject-row"><label class="label" for="subject">Subject</label><input class="subject" id="subject" value="${esc(v.subject)}" ${busy ? "readonly" : ""} autocomplete="off">
        <button class="icon-btn" data-act="copy-subject" aria-label="Copy subject" title="Copy subject">${I.copy}</button></div>` : ""}
      <div class="body-wrap"><div class="backdrop" id="backdrop" aria-hidden="true">${backdropHTML(v.body)}</div>
        <label class="vh" for="body">Message</label><textarea class="body" id="body" spellcheck="true" ${busy ? "readonly" : ""}>${esc(v.body)}</textarea></div>
      <footer class="sheet-foot"><span id="wc"></span><span>v${q.draft.current + 1} · ${esc(v.label)}${v.edited ? " · edited by you" : ""}</span></footer>`;
    const ta = $("#body");
    autosize(ta);
    drawCount();
    if (reveal && !reduced.matches) { sheet.classList.remove("is-reveal"); void sheet.offsetWidth; sheet.classList.add("is-reveal"); }
  };

  const drawCount = () => {
    const q = get(), v = currentVersion(q);
    if (!v || !$("#wc")) return;
    const n = words(v.body), max = +q.brief.max_words || 160;
    $("#wc").innerHTML = `<span class="${n > max ? "over" : ""}">${n} / ${max} words</span>`;
  };

  // Threads from the margin run to the page's edge.
  const drawThreads = (animate) => {
    const svgEl = $("#tsvg");
    if (!svgEl) return;
    const studio = $("#studio"), pins = $$("[data-pin]", margin);
    if (getComputedStyle(svgEl).display === "none" || !pins.length) { svgEl.innerHTML = ""; return; }
    const base = studio.getBoundingClientRect(), s = sheet.getBoundingClientRect();
    const x2 = s.left - base.left, top = s.top - base.top + 120;
    svgEl.innerHTML = pins.map((pin, i) => {
      const r = pin.getBoundingClientRect();
      const x1 = r.right - base.left + 8, y1 = r.top - base.top + 11;
      const y2 = top + i * 30, mx = (x1 + x2) / 2;
      return `<path pathLength="1" d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" class="${animate && !reduced.matches ? "draw" : ""}" style="animation-delay:${300 + i * 120}ms"/>`;
    }).join("");
  };

  const drawDock = () => {
    const q = get(), v = currentVersion(q), busy = q.draft.status === "running";
    const n = q.draft.versions.length;
    const vers = n ? `<div class="versions" role="group" aria-label="Draft versions"><span class="label" style="margin-right:4px">Drafts</span><ol>${q.draft.versions.map((x, i) =>
      `<li><button type="button" class="ver" data-act="version" data-i="${i}" aria-current="${i === q.draft.current}" title="v${i + 1}: ${esc(x.label)}" aria-label="Version ${i + 1}: ${esc(x.label)}">${i + 1}</button></li>`).join("")}</ol></div>` : "";
    const phs = v ? placeholders(v.body) : [];
    const out = q.draftsLeft === 0;
    if (ui.confirmCopy && v) {
      $("#dock-context").innerHTML = `<span class="confirm-copy" role="alert">${plural(phs.length, "placeholder")} still in the message.</span>`;
      $("#dock-actions").innerHTML = `<button class="btn btn-ghost" data-act="show-ph">Show me</button><button class="btn btn-primary" data-act="copy" data-force="1" data-primary>Copy anyway</button>`;
      return;
    }
    const left = typeof q.draftsLeft === "number"
      ? `<span class="drafts-left">${plural(q.draftsLeft, "draft")} left with this research</span>` : "";
    $("#dock-context").innerHTML = (vers + left) || `<span>${busy ? "Writing your first draft. This usually takes under a minute." : "No draft yet."}</span>`;
    $("#dock-actions").innerHTML = v ? `
      <div class="refine-menu"><button class="btn btn-ghost" data-act="refine-menu" aria-haspopup="true" aria-expanded="false" ${busy || out ? "disabled" : ""} ${out ? `title="${OUT_OF_DRAFTS}"` : ""}>${I.sparkle}<span>Refine<span class="label-long"> tone &amp; length</span></span></button></div>
      <button class="btn btn-ghost" data-act="regenerate" ${busy || out ? "disabled" : ""} aria-label="Regenerate" title="${out ? OUT_OF_DRAFTS : "Write a fresh draft from your research. This one stays in history."}">${I.redo}<span class="label-long">Regenerate</span></button>
      <button class="btn btn-ghost" data-act="track" aria-label="Track this: add ${esc(nameOf(q))} to your outreach tracker" title="Add this person to your outreach tracker">${I.track}<span class="label-long">Track this</span></button>
      <button class="btn btn-primary copy-btn" data-act="copy" data-primary><span class="idle">${I.copy} Copy message</span><span class="ok">${svg('<path d="m3 8.5 3 3 7-7"/>')} Copied</span></button>`
      : (q.draft.status === "error" ? `<a class="btn btn-ghost" href="${stageHash(q, "review")}">Back to review</a>` : "");
  };

  const drawAll = (reveal) => { drawMargin(); drawSheet(reveal); drawDock(); requestAnimationFrame(() => drawThreads(reveal)); };
  drawAll(revealNext.delete(id));

  const openMenu = (btn) => {
    if ($(".menu")) return closeMenus();
    btn.setAttribute("aria-expanded", "true");
    btn.parentElement.insertAdjacentHTML("beforeend", `<div class="menu" role="menu">
      ${REFINES.map(([k, l]) => `<button type="button" class="mi" role="menuitem" data-act="refine" data-k="${k}">${l}</button>`).join("")}
      <hr><form id="custom-refine"><label class="label" for="custom-instr">Or say what to change</label>
      <input class="input input-sm" id="custom-instr" placeholder="e.g. mention I'm free on Fridays" autocomplete="off"></form></div>`);
    $(".menu .mi").focus();
    $("#custom-refine").addEventListener("submit", (e) => {
      e.preventDefault();
      const instr = $("#custom-instr").value.trim();
      if (!instr) return;
      closeMenus();
      startDraft(id, { instruction: instr, label: `Refined: ${trunc(instr, 40)}` });
    });
  };

  const doCopy = async (btn, force) => {
    const q = get(), v = currentVersion(q);
    if (!v) return;
    if (!force && placeholders(v.body).length) { ui.confirmCopy = true; drawDock(); $("#dock [data-act='copy']").focus(); return; }
    ui.confirmCopy = false;
    const ok = await copyText(v.body);
    store.update(id, (x) => { x.copiedAt = Date.now(); }, "copy");
    drawDock();
    const b = $("#dock .copy-btn");
    if (ok && b) { b.classList.add("is-done"); setTimeout(() => b.classList.remove("is-done"), 1800); }
    toast(ok ? "Message copied. Paste it wherever you'll send it." : "Couldn't reach the clipboard. Select the text and copy it yourself.");
  };

  const jumpTo = (ph) => {
    const subj = $("#subject"), ta = $("#body");
    const target = subj && subj.value.includes(ph) ? subj : ta;
    const i = target.value.indexOf(ph);
    if (i < 0) return;
    target.focus();
    target.setSelectionRange(i, i + ph.length);
    if (target === ta) {
      const line = ta.value.slice(0, i).split("\n").length;
      const y = ta.getBoundingClientRect().top + window.scrollY + line * 30 - window.innerHeight / 2;
      window.scrollTo({ top: Math.max(0, y), behavior: reduced.matches ? "auto" : "smooth" });
    }
  };

  const setFocus = (on) => {
    ui.focus = on;
    $("#studio").classList.toggle("is-focus", on);
    document.body.classList.toggle("focus-on", on);
    $("[data-act='focus']")?.setAttribute("aria-pressed", String(on));
    requestAnimationFrame(() => drawThreads(false));
  };

  const root = $("#main");
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "refine-menu") openMenu(a);
    else if (act === "refine") { closeMenus(); const [, l, instr] = REFINES.find((r) => r[0] === a.dataset.k); startDraft(id, { instruction: instr, label: `Refined: ${l.toLowerCase()}` }); }
    else if (act === "regenerate") startDraft(id, { label: "Regenerated" });
    else if (act === "retry-draft") { startDraft(id, { label: currentVersion(get()) ? "Regenerated" : "First draft" }); }
    else if (act === "copy") doCopy(a, a.dataset.force === "1");
    else if (act === "track") trackDraft(get());
    else if (act === "show-ph") { ui.confirmCopy = false; drawDock(); jumpTo(placeholders(currentVersion(get()).body)[0]); }
    else if (act === "copy-subject") copyText(currentVersion(get()).subject).then((ok) => toast(ok ? "Subject copied." : "Couldn't reach the clipboard."));
    else if (act === "version") {
      store.update(id, (q) => { q.draft.current = +a.dataset.i; }, "version");
      ui.confirmCopy = false;
      drawAll(false);
      $(`[data-act='version'][data-i='${a.dataset.i}']`)?.focus();
    } else if (act === "ph") jumpTo(a.dataset.ph);
    else if (act === "drawer") openDrawer(get());
    else if (act === "focus") setFocus(!ui.focus);
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id !== "body" && t.id !== "subject") return;
    store.update(id, (q) => { const v = currentVersion(q); v[t.id] = t.value; v.edited = true; }, "edit");
    if (t.id === "body") { $("#backdrop").innerHTML = backdropHTML(t.value); autosize(t); drawCount(); }
    if (ui.confirmCopy) { ui.confirmCopy = false; drawDock(); }
    clearTimeout(root._m);
    root._m = setTimeout(() => { drawMargin(); drawThreads(false); }, 300);
  });

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ".") { e.preventDefault(); setFocus(!ui.focus); }
    else if (e.key === "Escape" && ui.focus && !$("#drawer-root") && !$(".menu")) setFocus(false);
  };
  document.addEventListener("keydown", onKey);
  const onResize = () => drawThreads(false);
  addEventListener("resize", onResize);
  document.fonts?.ready.then(() => { const ta = $("#body"); if (ta) autosize(ta); drawThreads(false); });
  const off = store.on((pid, part) => {
    if (pid !== id || !["draft", "any"].includes(part)) return;
    const reveal = revealNext.delete(id);
    ui.confirmCopy = false;
    drawAll(reveal);
  });
  return () => { off(); document.removeEventListener("keydown", onKey); removeEventListener("resize", onResize); document.body.classList.remove("focus-on"); };
}

/* ───────── Profile ───────── */

const RESUME_TYPES = /\.(pdf|docx)$/i;
const MAX_RESUME = 5 * 1024 * 1024;

// Upload a resume; the server checks it, extracts the text and saves both to the profile.
async function uploadResume(file) {
  if (!RESUME_TYPES.test(file.name)) return { ok: false, error: "Upload your resume as a PDF or a Word (.docx) file." };
  if (file.size > MAX_RESUME) return { ok: false, error: "Resumes can be up to 5 MB." };
  const { http, data } = await request("POST", `/api/profile/resume?filename=${encodeURIComponent(file.name)}`, undefined,
    { raw: file, contentType: file.type || "application/octet-stream" });
  if (http !== 200) return { ok: false, error: data?.error || "Couldn't read that file." };
  profile = data;
  toast("Resume read. Check the text below.");
  return { ok: true };
}

function profileView() {
  const pr = profile;
  const samples = pr.samples.map((x) => x.body);
  $("#main").innerHTML = `<div class="ruled"><div class="page"><div class="composer profile-page">
    <div class="row lead"><div class="margin"><p class="label">Profile</p></div><div class="col">
      <h1 class="h2" data-focus-on-enter>Your profile</h1>
      <p class="field-hint">Sociai starts every new outreach from these. You can still change them for one message without touching your profile. Changes save as you type.</p>
    </div></div>
    <div class="row"><div class="margin"><p class="label"><span class="n">01</span>&nbsp; Main goal</p>
      <p class="margin-note">New outreach starts with this purpose and ask.</p></div>
      <div class="col"><div class="choices" role="radiogroup" aria-label="Main goal">${MAIN_GOALS.map(([v, l]) =>
        `<button type="button" class="choice choice-sm" role="radio" aria-checked="${pr.main_goal === v}" data-act="pf-goal" data-v="${v}">${l}</button>`).join("")}</div>
        <label class="label" for="pf-goal-note" style="display:block;margin-top:16px">In your own words</label>
        <textarea class="textarea serif" id="pf-goal-note" rows="2" maxlength="500" placeholder="e.g. Land a summer research position in NLP">${esc(pr.main_goal_note)}</textarea></div></div>
    <div class="row"><div class="margin"><label class="label" for="pf-bg"><span class="n">02</span>&nbsp; About you</label>
      <p class="margin-note">Who you are and what you've done, in your words. Sociai uses it to find real common ground.</p></div>
      <div class="col"><textarea class="textarea" id="pf-bg" rows="5" placeholder="e.g. CS junior at Stanford; built a small benchmark for LLM reasoning; interned at Plaid">${esc(pr.background)}</textarea></div></div>
    <div class="row"><div class="margin"><p class="label"><span class="n">03</span>&nbsp; Defaults</p><p class="margin-note">The format new outreach starts with.</p></div>
      <div class="col format">
        <div><span class="label">Channel</span><div class="choices" role="radiogroup" aria-label="Default channel">${CHANNELS.map(([v, l]) =>
          `<button type="button" class="choice choice-sm" role="radio" aria-checked="${pr.default_channel === v}" data-act="pf-channel" data-v="${v}">${l}</button>`).join("")}</div></div>
        <div><label class="label" for="pf-words">Length · words</label><div class="length">${LENGTHS.map(([v, l]) =>
          `<button type="button" class="choice choice-sm" aria-pressed="${pr.default_max_words === v}" data-act="pf-length" data-v="${v}">${l}</button>`).join("")}
          <input class="input num-input" id="pf-words" type="number" min="40" max="600" step="10" value="${pr.default_max_words}"></div></div>
      </div></div>
    <div class="row"><div class="margin"><p class="label"><span class="n">04</span>&nbsp; Writing samples</p>
      <p class="margin-note">Emails or posts you wrote yourself. At least 2 help drafts match your voice.</p></div>
      <div class="col"><div class="samples" id="pf-samples"></div>
        <div class="sample-foot"><button type="button" class="link-btn" data-act="pf-add-sample" id="pf-add-sample">Add a writing sample</button><span class="sample-meter" id="pf-meter"></span></div></div></div>
    <div class="row"><div class="margin"><p class="label"><span class="n">05</span>&nbsp; Resume</p>
      <p class="margin-note">PDF or Word (.docx), up to 5 MB. Sociai uses only the details that help a given message.</p></div>
      <div class="col">
        <div class="resume-file" id="pf-file"></div>
        <input type="file" id="pf-resume" class="vh" tabindex="-1" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
        <p class="field-error" id="pf-resume-err" hidden></p>
        <label class="label" for="pf-resume-text" style="display:block;margin-top:16px">Text Sociai uses</label>
        <textarea class="textarea" id="pf-resume-text" rows="10" placeholder="Upload a resume, or paste its text here.">${esc(pr.resume_text)}</textarea>
        <p class="field-hint">Check what came out of the file and fix anything that's wrong. Drafts use this text, never the file itself.</p>
      </div></div>
    <div class="row"><div class="margin"><p class="label"><span class="n">06</span>&nbsp; Privacy</p></div>
      <div class="col danger-zone">
        <p>Your profile, writing samples, resume and projects are stored in your Sociai account (on Supabase), so they're there wherever you sign in.</p>
        <button type="button" class="btn btn-danger" data-act="pf-delete">Delete my account and data</button>
        <div class="confirm-delete" id="pf-confirm" hidden>
          <p>This permanently deletes your profile, writing samples, resume and every project, and signs you out. Unused credits are lost. It can't be undone.</p>
          <label class="label" for="pf-confirm-input">Type DELETE to confirm</label>
          <input class="input" id="pf-confirm-input" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <div class="gate-actions"><button type="button" class="btn btn-danger is-solid" data-act="pf-confirm-delete" disabled>Delete everything</button>
            <button type="button" class="btn btn-ghost" data-act="pf-cancel-delete">Cancel</button></div>
        </div>
      </div></div>
  </div></div></div>`;

  const root = $("#main");
  const fields = () => ({
    background: $("#pf-bg").value, resume_text: $("#pf-resume-text").value,
    main_goal: $("[data-act='pf-goal'][aria-checked='true']")?.dataset.v ?? "", main_goal_note: $("#pf-goal-note").value,
    default_channel: $("[data-act='pf-channel'][aria-checked='true']")?.dataset.v,
    default_max_words: Math.min(600, Math.max(40, Math.round(+$("#pf-words").value || 160))),
  });
  const timers = {};
  const later = (name, fn, ms) => { clearTimeout(timers[name]); timers[name] = setTimeout(() => { delete timers[name]; fn(); }, ms); };
  const now = () => { for (const [name, t] of Object.entries(timers)) { clearTimeout(t); delete timers[name]; (name === "fields" ? saveFields : saveSamples)(); } };
  const saveFields = async () => {
    const { http, data } = await request("PUT", "/api/profile", fields());
    if (http === 200) profile = data; else toast(data?.error || "Couldn't save your profile.");
    flashSaved(http === 200);
  };
  const saveSamples = async () => {
    const { http, data } = await request("PUT", "/api/profile/samples", { samples });
    if (http === 200) profile = data; else toast(data?.error || "Couldn't save your writing samples.");
    flashSaved(http === 200);
  };

  const drawSamples = () => {
    $("#pf-samples").innerHTML = samples.map((x, i) => `<div class="sample">
      <label class="vh" for="pf-sample-${i}">Writing sample ${i + 1}</label>
      <textarea class="textarea" id="pf-sample-${i}" data-pf-sample="${i}" rows="5" placeholder="Paste an email, post or message you wrote">${esc(x)}</textarea>
      <button type="button" class="icon-btn" data-act="pf-remove-sample" data-i="${i}" aria-label="Delete sample ${i + 1}">${I.x}</button></div>`).join("");
    drawMeter();
  };
  const drawMeter = () => {
    const n = samples.filter((x) => x.trim()).length;
    $("#pf-meter").className = "sample-meter" + (n < 2 ? " is-low" : "");
    $("#pf-meter").textContent = n >= 2 ? `${plural(n, "sample")} saved` : `${n} of 2 recommended`;
    $("#pf-add-sample").hidden = samples.length >= 10;
    $("#pf-add-sample").textContent = samples.length ? "Add another sample" : "Add a writing sample";
  };
  const drawFile = () => {
    const pf = profile;
    $("#pf-file").innerHTML = pf.resume_filename
      ? `<span class="file-name">${esc(pf.resume_filename)}</span><span class="muted">uploaded ${ago(Date.parse(pf.resume_updated_at))}</span>
         <button type="button" class="btn btn-line btn-sm" data-act="pf-pick">Replace</button>
         <button type="button" class="btn btn-ghost btn-sm" data-act="pf-remove-resume">Remove</button>`
      : `<button type="button" class="btn btn-line btn-sm" data-act="pf-pick">Upload resume</button><span class="muted">PDF or .docx</span>`;
  };
  drawSamples();
  drawFile();

  const resumeError = (msg) => { const el = $("#pf-resume-err"); el.textContent = msg || ""; el.hidden = !msg; };
  $("#pf-resume").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    resumeError("");
    $("#pf-file").innerHTML = `<span class="muted" role="status">Reading ${esc(file.name)}…</span>`;
    const r = await uploadResume(file);
    if (r.ok) {
      $("#pf-resume-text").value = profile.resume_text;
      flashSaved(true);
    } else resumeError(r.error);
    drawFile();
  });

  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.pfSample !== undefined) { samples[+t.dataset.pfSample] = t.value; drawMeter(); later("samples", saveSamples, 800); }
    else if (t.id === "pf-bg" || t.id === "pf-resume-text" || t.id === "pf-goal-note") later("fields", saveFields, 600);
    else if (t.id === "pf-words") {
      $$("[data-act='pf-length']").forEach((el) => el.setAttribute("aria-pressed", String(+el.dataset.v === +t.value)));
      later("fields", saveFields, 600);
    } else if (t.id === "pf-confirm-input") $("[data-act='pf-confirm-delete']").disabled = t.value.trim() !== "DELETE";
  });
  root.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "pf-goal") {
      const on = a.getAttribute("aria-checked") !== "true"; // clicking the chosen goal clears it
      $$("[data-act='pf-goal']").forEach((el) => el.setAttribute("aria-checked", String(on && el === a)));
      later("fields", saveFields, 0);
    } else if (act === "pf-channel") {
      $$("[data-act='pf-channel']").forEach((el) => el.setAttribute("aria-checked", String(el === a)));
      later("fields", saveFields, 0);
    } else if (act === "pf-length") {
      $("#pf-words").value = a.dataset.v;
      $$("[data-act='pf-length']").forEach((el) => el.setAttribute("aria-pressed", String(el === a)));
      later("fields", saveFields, 0);
    } else if (act === "pf-add-sample") {
      samples.push(""); drawSamples(); $(`#pf-sample-${samples.length - 1}`).focus();
    } else if (act === "pf-remove-sample") {
      samples.splice(+a.dataset.i, 1); drawSamples(); later("samples", saveSamples, 0);
    } else if (act === "pf-pick") $("#pf-resume").click();
    else if (act === "pf-remove-resume") {
      const { http, data } = await request("DELETE", "/api/profile/resume");
      if (http === 200) { profile = data; $("#pf-resume-text").value = ""; drawFile(); toast("Resume removed."); }
      else toast(data?.error || "Couldn't remove your resume.");
    } else if (act === "pf-delete") {
      $("#pf-confirm").hidden = false; $("#pf-confirm-input").focus();
    } else if (act === "pf-cancel-delete") {
      $("#pf-confirm").hidden = true; $("#pf-confirm-input").value = ""; a.closest(".danger-zone").querySelector("[data-act='pf-delete']").focus();
    } else if (act === "pf-confirm-delete") {
      a.disabled = true;
      a.textContent = "Deleting…";
      const { http, data } = await request("DELETE", "/api/account", { confirm: "DELETE" });
      if (http !== 200) { a.disabled = false; a.textContent = "Delete everything"; return toast(data?.error || "Couldn't delete your account. Try again."); }
      store.clearBrowserData();
      try { sessionStorage.setItem("sociai.deleted", "1"); } catch {}
      await signOut("local").catch(() => {});
      location.replace(location.pathname);
    }
  });
  return now; // leaving the page saves anything still waiting
}

/* ───────── Onboarding ───────── */

// Shown once, after the first sign-in: main goal, background and resume, writing samples.
// Each step saves when you continue; any step can be skipped. It never comes back once it's
// finished or skipped, and everything stays editable on the Profile page.
const ONBOARD_STEPS = ["goal", "about", "samples"];
let onboardStep = null;

function firstOpenStep() {
  if (!profile.main_goal && !profile.main_goal_note) return 0;
  if (!profile.background && !profile.resume_text) return 1;
  return 2;
}

async function finishOnboarding() {
  const { http, data } = await request("POST", "/api/profile/onboarded", {});
  if (http !== 200) return toast(data?.error || "Couldn't save that. Try again.");
  profile = data;
  onboardStep = null;
  go("#/");
}

function onboardingView() {
  if (onboardStep === null) onboardStep = firstOpenStep();
  const step = ONBOARD_STEPS[onboardStep];
  const samples = profile.samples.map((x) => x.body);
  const shown = samples.slice(0, 3);
  if (!shown.length) shown.push("");
  const progress = `<ol class="onboard-steps" aria-label="Setup progress">${["Your goal", "About you", "Your voice"].map((t, i) =>
    `<li class="${i < onboardStep ? "is-done" : i === onboardStep ? "is-current" : ""}"${i === onboardStep ? ' aria-current="step"' : ""}><span class="k" aria-hidden="true"></span>${t}</li>`).join("")}</ol>`;
  const head = (title, text) => `<div class="row lead"><div class="margin"><p class="label">Step ${onboardStep + 1} of 3</p></div><div class="col">
      ${progress}
      <h1 class="h2" data-focus-on-enter>${title}</h1>
      <p class="field-hint">${text}</p></div></div>`;
  const body = {
    goal: `${head("What do you mainly want to use Sociai for?", "New outreach starts from this goal. You can change it for any message, and on your profile later.")}
      <div class="row"><div class="margin"><p class="label">Main goal</p></div><div class="col">
        <div class="choices" role="radiogroup" aria-label="Main goal">${MAIN_GOALS.map(([v, l]) =>
          `<button type="button" class="choice" role="radio" aria-checked="${profile.main_goal === v}" data-act="ob-goal" data-v="${v}"><span class="k" aria-hidden="true"></span>${l}</button>`).join("")}</div>
        <label class="label" for="ob-note" style="display:block;margin-top:var(--s5)">In your own words <span class="muted">(optional)</span></label>
        <textarea class="textarea serif" id="ob-note" rows="2" maxlength="500" placeholder="e.g. Land a summer research position in NLP">${esc(profile.main_goal_note)}</textarea>
        <p class="field-error" id="ob-err" hidden></p></div></div>`,
    about: `${head("Tell Sociai about you", "Sociai uses this to find real common ground with the people you write to. Upload a resume, write a few lines, or both.")}
      <div class="row"><div class="margin"><label class="label" for="ob-bg">About you</label></div><div class="col">
        <textarea class="textarea" id="ob-bg" rows="4" placeholder="e.g. CS junior at Stanford; built a small benchmark for LLM reasoning; interned at Plaid">${esc(profile.background)}</textarea></div></div>
      <div class="row"><div class="margin"><p class="label">Resume</p><p class="margin-note">PDF or Word (.docx), up to 5 MB.</p></div><div class="col">
        <div class="resume-file" id="ob-file"></div>
        <input type="file" id="ob-resume" class="vh" tabindex="-1" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
        <p class="field-error" id="ob-resume-err" hidden></p>
        <div id="ob-resume-box" ${profile.resume_text ? "" : "hidden"}>
          <label class="label" for="ob-resume-text" style="display:block;margin-top:var(--s4)">Text Sociai uses</label>
          <textarea class="textarea" id="ob-resume-text" rows="7">${esc(profile.resume_text)}</textarea>
          <p class="field-hint">Check what came out of the file and fix anything that's wrong.</p></div>
        <p class="field-error" id="ob-err" hidden></p></div></div>`,
    samples: `${head("Add a few things you've written", "Paste one to three emails, posts or messages you wrote yourself, so drafts sound like you.")}
      <div class="row"><div class="margin"><p class="label">Writing samples</p></div><div class="col">
        <div class="samples" id="ob-samples">${shown.map((x, i) => `<div class="sample">
          <label class="vh" for="ob-sample-${i}">Writing sample ${i + 1}</label>
          <textarea class="textarea" id="ob-sample-${i}" data-ob-sample rows="5" placeholder="Paste an email, post or message you wrote">${esc(x)}</textarea></div>`).join("")}</div>
        ${shown.length < 3 ? '<button type="button" class="link-btn" data-act="ob-add-sample" style="margin-top:10px">Add another sample</button>' : ""}
        <p class="field-error" id="ob-err" hidden></p></div></div>`,
  }[step];
  $("#main").innerHTML = `<div class="ruled"><div class="page"><form class="composer onboard" novalidate>
    ${body}
    <div class="row"><div class="margin"></div><div class="col composer-actions">
      ${primary(onboardStep === 2 ? "Finish" : "Continue", "ob-next")}
      <button type="button" class="btn btn-ghost" data-act="ob-skip">Skip this step</button>
      <button type="button" class="link-btn" data-act="ob-skip-all">Skip setup for now</button>
    </div></div>
  </form></div></div>`;

  const root = $("#main");
  const err = (msg) => { const el = $("#ob-err"); el.textContent = msg || ""; el.hidden = !msg; };
  const next = () => { if (onboardStep >= 2) return finishOnboarding(); onboardStep++; render(); };
  const drawFile = () => {
    const el = $("#ob-file");
    if (el) el.innerHTML = profile.resume_filename
      ? `<span class="file-name">${esc(profile.resume_filename)}</span><button type="button" class="btn btn-line btn-sm" data-act="ob-pick">Replace</button>`
      : `<button type="button" class="btn btn-line btn-sm" data-act="ob-pick">Upload resume</button><span class="muted">PDF or .docx</span>`;
  };
  drawFile();

  const save = {
    async goal() {
      const goal = $("[data-act='ob-goal'][aria-checked='true']")?.dataset.v || "";
      const note = $("#ob-note").value.trim();
      if (!goal && !note) { err("Choose a goal or describe it, or skip this step."); return false; }
      return request("PUT", "/api/profile", { main_goal: goal || "other", main_goal_note: note });
    },
    async about() {
      const background = $("#ob-bg").value, resumeText = $("#ob-resume-text").value;
      if (!background.trim() && !resumeText.trim()) { err("Write a few lines or upload a resume, or skip this step."); return false; }
      return request("PUT", "/api/profile", { background, resume_text: resumeText });
    },
    async samples() {
      const edited = $$("[data-ob-sample]").map((t) => t.value.trim()).filter(Boolean);
      if (!edited.length) { err("Paste at least one sample, or skip this step."); return false; }
      return request("PUT", "/api/profile/samples", { samples: [...edited, ...samples.slice(3)] });
    },
  };

  $("#ob-resume")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const box = $("#ob-resume-err");
    box.hidden = true;
    $("#ob-file").innerHTML = `<span class="muted" role="status">Reading ${esc(file.name)}…</span>`;
    const r = await uploadResume(file);
    if (r.ok) {
      $("#ob-resume-text").value = profile.resume_text;
      $("#ob-resume-box").hidden = false;
      err("");
    } else { box.textContent = r.error; box.hidden = false; }
    drawFile();
  });
  root.addEventListener("input", () => err(""));
  root.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act;
    if (act === "ob-goal") { $$("[data-act='ob-goal']").forEach((el) => el.setAttribute("aria-checked", String(el === a))); err(""); }
    else if (act === "ob-pick") $("#ob-resume").click();
    else if (act === "ob-add-sample") {
      const n = $$("[data-ob-sample]").length;
      $("#ob-samples").insertAdjacentHTML("beforeend", `<div class="sample"><label class="vh" for="ob-sample-${n}">Writing sample ${n + 1}</label>
        <textarea class="textarea" id="ob-sample-${n}" data-ob-sample rows="5" placeholder="Paste an email, post or message you wrote"></textarea></div>`);
      if (n + 1 >= 3) a.remove();
      $(`#ob-sample-${n}`).focus();
    } else if (act === "ob-skip") next();
    else if (act === "ob-skip-all") { a.disabled = true; finishOnboarding(); }
    else if (act === "ob-next") {
      a.disabled = true;
      const r = await save[step]();
      a.disabled = false;
      if (!r) return;
      if (r.http !== 200) return err(r.data?.error || "Couldn't save that. Try again.");
      profile = r.data;
      next();
    }
  });
  return () => {};
}

// What's still missing from the profile, for the Desk's "finish setting up" note.
function missingSetup() {
  if (!profile?.onboarded_at) return [];
  return [
    !profile.main_goal && !profile.main_goal_note && "your main goal",
    !profile.background.trim() && !profile.resume_text.trim() && "your background or resume",
    !profile.samples.length && "writing samples",
  ].filter(Boolean);
}

let setupNudgeHidden = false;
function setupNudgeHTML() {
  const missing = missingSetup();
  if (setupNudgeHidden || !missing.length) return "";
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : missing[0];
  return `<div class="row setup-row"><div class="margin"><p class="label">Your profile</p></div><div class="col">
    <div class="import-banner" role="region" aria-label="Finish setting up your profile">
    <p><b>Finish setting up your profile.</b> Add ${list}. New outreach starts from your profile, so drafts need less fixing.</p>
    <div class="gate-actions"><a class="btn btn-primary btn-sm" href="#/profile">Finish setup</a>
      <button type="button" class="btn btn-ghost btn-sm" data-act="setup-later">Not now</button></div></div></div></div>`;
}

/* ───────── Pricing and account ───────── */

const REASONS = {
  signup_bonus: "Welcome credits", research: "Research run", refund: "Refund: research didn't finish",
  purchase_pack: "20-credit pack", subscription_credits: "Monthly plan", manual_grant: "Added by Sociai",
};
const PURCHASES = new Set(["purchase_pack", "subscription_credits"]);
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const money = (amount, currency) => amount == null ? "" : new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() })
  .format(ZERO_DECIMAL.has(currency) ? amount : amount / 100);
const longDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

async function openStripe(btn, path, body) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = path === "/api/checkout" ? "Opening checkout…" : "Opening Stripe…";
  const { http, data } = await request("POST", path, body);
  if (http === 200 && data.url) {
    if (path === "/api/checkout") { try { sessionStorage.setItem("sociai.checkoutAt", String(Date.now())); } catch {} }
    return location.assign(data.url);
  }
  btn.disabled = false;
  btn.innerHTML = label;
  toast(data?.error || "Couldn't open Stripe. Try again.");
}

function pricingView() {
  $("#main").innerHTML = `<div class="ruled"><div class="page stack">
    <div class="row lead"><div class="margin"><p class="label">Pricing</p></div><div class="col">
      <h1 class="h2" data-focus-on-enter>More credits</h1>
      <p class="field-hint">Each credit covers one research run plus up to 3 drafts or revisions for that person. You have <b>${creditLabel(account.credits)}</b>.</p>
    </div></div>
    <div class="row"><div class="margin"></div><div class="col" id="pr-plans"><p class="opening" role="status">Loading prices…</p></div></div>
  </div></div>`;
  let alive = true;
  request("GET", "/api/pricing").then(({ http, data }) => {
    if (!alive) return;
    const host = $("#pr-plans");
    if (http !== 200 || !data.enabled) {
      host.innerHTML = `<p class="empty">Buying credits isn't available yet.</p>`;
      return;
    }
    const { pack, monthly } = data.plans;
    host.innerHTML = `
      ${data.test_mode ? `<p class="test-note"><b>Test mode:</b> no real charges. Pay with card 4242 4242 4242 4242, any future expiry date and any CVC.</p>` : ""}
      <div class="plans">
        <section class="plan" aria-labelledby="plan-pack">
          <h2 class="label" id="plan-pack">Credit pack</h2>
          <p class="plan-credits"><span class="n">${pack.credits}</span> credits</p>
          <p class="plan-price">${money(pack.amount, pack.currency)} <span class="muted">one time</span></p>
          <p class="plan-note">For a burst of outreach. The credits stay in your account until you use them.</p>
          <button type="button" class="btn btn-primary" data-act="buy" data-plan="pack">Buy ${pack.credits} credits <span class="arrow">${I.arrow}</span></button>
        </section>
        <section class="plan" aria-labelledby="plan-monthly">
          <h2 class="label" id="plan-monthly">Monthly plan</h2>
          <p class="plan-credits"><span class="n">${monthly.credits}</span> credits a ${esc(monthly.interval || "month")}</p>
          <p class="plan-price">${money(monthly.amount, monthly.currency)} <span class="muted">per ${esc(monthly.interval || "month")}</span></p>
          <p class="plan-note">For steady outreach. Credits are added each time you're billed. Cancel anytime from your account.</p>
          <button type="button" class="btn btn-line" data-act="buy" data-plan="monthly">Start the monthly plan</button>
        </section>
      </div>
      <p class="field-hint">Payments are handled by Stripe; Sociai never sees your card details. By buying you agree to the ${LEGAL_LINKS}, including the refund policy for credits.</p>`;
  });
  $("#main").addEventListener("click", (e) => {
    const a = e.target.closest("[data-act='buy']");
    if (a) openStripe(a, "/api/checkout", { plan: a.dataset.plan });
  });
  return () => { alive = false; };
}

let refreshAccountPage = null;

function accountView() {
  $("#main").innerHTML = `<div class="ruled"><div class="page stack">
    <div class="row lead"><div class="margin"><p class="label">Account</p></div><div class="col">
      <h1 class="h2" data-focus-on-enter>Account and billing</h1>
      <p class="field-hint">Signed in as ${esc(account.email)}. Your background, samples and resume live on <a class="link-btn" href="#/profile">your profile</a>.</p>
    </div></div>
    <div id="acct"><div class="row"><div class="margin"></div><div class="col"><p class="opening" role="status">Loading…</p></div></div></div>
  </div></div>`;
  let alive = true;
  const row = (h) => `<tr><td>${longDate(h.created_at)}</td><td>${esc(REASONS[h.reason] || h.reason)}</td>
    <td class="num ${h.delta > 0 ? "plus" : "minus"}">${h.delta > 0 ? "+" : "−"}${Math.abs(h.delta)}</td></tr>`;
  const table = (rows) => `<table class="ledger-table"><thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col" class="num">Credits</th></tr></thead>
    <tbody>${rows.map(row).join("")}</tbody></table>`;
  const draw = async () => {
    const { http, data } = await request("GET", "/api/account");
    if (!alive) return;
    if (http !== 200) { $("#acct").innerHTML = `<div class="row"><div class="margin"></div><div class="col"><p class="empty">Couldn't load your account. Try again.</p></div></div>`; return; }
    setCredits(data.credits);
    const purchases = data.history.filter((h) => PURCHASES.has(h.reason));
    $("#acct").innerHTML = `
      <div class="row"><div class="margin"><p class="label">Balance</p></div><div class="col">
        <p class="balance"><span class="n">${data.credits}</span> ${data.credits === 1 ? "credit" : "credits"}</p>
        <div class="gate-actions">${data.payments ? `<a class="btn btn-primary btn-sm" href="#/pricing">Buy credits</a>` : ""}
          ${data.has_billing ? `<button type="button" class="btn btn-line btn-sm" data-act="portal">Manage subscription and invoices</button>` : ""}</div>
      </div></div>
      <div class="row"><div class="margin"><p class="label">Purchases</p></div><div class="col">
        ${purchases.length ? table(purchases) : `<p class="empty">No purchases yet.</p>`}
      </div></div>
      <div class="row"><div class="margin"><p class="label">Credit activity</p><p class="margin-note">The last 100 changes to your balance.</p></div><div class="col">
        ${table(data.history)}
      </div></div>`;
  };
  draw();
  $("#main").addEventListener("click", (e) => {
    const a = e.target.closest("[data-act='portal']");
    if (a) openStripe(a, "/api/billing-portal");
  });
  refreshAccountPage = draw;
  return () => { alive = false; refreshAccountPage = null; };
}

// Back from Stripe Checkout: credits arrive by webhook, so wait for the purchase to show up.
function handleCheckoutReturn() {
  const outcome = new URLSearchParams(location.search).get("checkout");
  if (!outcome) return;
  history.replaceState(null, "", location.pathname + location.hash);
  let startedAt = Date.now() - 10 * 60 * 1000;
  try { startedAt = +sessionStorage.getItem("sociai.checkoutAt") || startedAt; sessionStorage.removeItem("sociai.checkoutAt"); } catch {}
  if (outcome !== "success") return toast("Checkout cancelled. You weren't charged.");
  toast("Payment received. Adding your credits…", { ms: 4000 });
  let tries = 0;
  const look = async () => {
    const { http, data } = await request("GET", "/api/account");
    const arrived = http === 200 && data.history.some((h) => PURCHASES.has(h.reason) && Date.parse(h.created_at) >= startedAt - 5 * 60 * 1000);
    if (arrived) {
      setCredits(data.credits);
      refreshAccountPage?.();
      return toast(`Credits added. You now have ${creditLabel(data.credits)}.`);
    }
    if (++tries < 20) return setTimeout(look, 1500);
    toast("Your payment went through. Credits can take a minute to appear; refresh this page if they don't.", { ms: 12000 });
  };
  look();
}

const OUT_OF_DRAFTS = "No drafts left with this research. Re-running the research (1 credit) adds 3 more.";

// "Track this" under a draft: a new tracker contact from the person and the draft's subject.
const TRACKER_ROLES = { professor: "professor", recruiter: "recruiter" }; // other purposes become "other"
function trackDraft(q) {
  const v = currentVersion(q);
  const subject = ($("#subject")?.value ?? v?.subject ?? "").trim();
  const email = q.research.dossier?.contact?.emails?.[0];
  openContactEditor(null, {
    prefill: {
      name: trunc(nameOf(q), 200), role: TRACKER_ROLES[q.brief.category] || "other",
      email: email?.address || "", notes: email?.kind === "likely" ? "The email is Sociai's guess and isn't published anywhere. Check it before sending." : "",
      organization: trunc(q.research.dossier?.headline || "", 200), subject: trunc(subject, 300), status: "drafted",
    },
    onSaved: (c) => toast(`${c.name} was added to your tracker.`, { action: { label: "Open tracker", fn: () => go("#/tracker") } }),
  });
}

initTracker({ request, toast, esc, icons: I });
const PAGES = { desk: deskView, profile: profileView, pricing: pricingView, account: accountView, welcome: onboardingView, tracker: trackerView };
const PAGE_TITLES = { profile: "Your profile", pricing: "Pricing", account: "Account", welcome: "Welcome", tracker: "Tracker" };
const VIEWS = { recipient: recipientView, research: researchView, review: reviewView, draft: draftView };

/* ───────── Global interactions ───────── */

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("[data-act='theme']")) {
    const next = THEMES[(THEMES.indexOf(theme()) + 1) % THEMES.length];
    try { next === "system" ? localStorage.removeItem("sociai.theme") : localStorage.setItem("sociai.theme", next); } catch {}
    if (next === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    const btn = t.closest("[data-act='theme']");
    btn.outerHTML = themeButton();
    $("[data-act='theme']").focus();
    return;
  }
  if (t.closest("[data-act='close-drawer']")) return closeDrawer();
  const cc = t.closest("[data-act='copy-contact']");
  if (cc) { copyText(cc.dataset.v).then((ok) => toast(ok ? `Copied ${cc.dataset.v}` : "Couldn't reach the clipboard.")); return; }
  const acct = t.closest("[data-act='account']");
  if (acct) return toggleAccountMenu(acct);
  if (t.closest("[data-act='sign-out']")) { signOut().finally(() => location.reload()); return; }
  const jump = t.closest("[data-act='jump-source']");
  if (jump) {
    closePop();
    const li = $(`#src-${jump.dataset.n}`);
    li?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "center" });
    if (li) { li.classList.remove("is-flash"); void li.offsetWidth; li.classList.add("is-flash"); }
    return;
  }
  if (popAnchor && !t.closest("#pop") && !t.closest("[data-act='cite']")) closePop();
  if ($(".menu") && !t.closest(".refine-menu, .account")) closeMenus();
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    const btns = $$("[data-primary]").filter((b) => !b.disabled && b.offsetParent !== null);
    const b = btns[btns.length - 1];
    if (b) { e.preventDefault(); b.click(); }
    return;
  }
  if (e.key === "Escape") {
    if (popAnchor) { const a = popAnchor; closePop(); a.focus(); return; }
    if ($(".menu")) { closeMenus(); $("[data-act='refine-menu']")?.focus(); return; }
    if ($("#drawer-root")) return closeDrawer();
  }
  const ae = document.activeElement;
  const idleWho = ae?.id === "f-target" && !ae.value; // the desk focuses this on load
  if (e.key === "/" && (!isTyping(ae) || idleWho) && $("#ledger-q")) { e.preventDefault(); $("#ledger-q").focus(); }
  // Arrow keys move through the refine menu.
  const menu = $(".menu");
  if (menu && ["ArrowDown", "ArrowUp"].includes(e.key) && menu.contains(document.activeElement)) {
    e.preventDefault();
    const items = $$(".mi, #custom-instr", menu), i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  }
  // Keep focus inside the drawer while it's open.
  const drawer = $("#drawer-root .drawer");
  if (drawer && e.key === "Tab") {
    const f = $$("a[href], button:not([disabled]), textarea, input", drawer);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});
addEventListener("scroll", () => popAnchor && !$("#drawer-root") && closePop(), { passive: true });
addEventListener("resize", closePop);

/* ───────── Boot ───────── */

let sessionUser = null;

// Jobs that were running when the page closed carry on (the server keeps them).
function resumeJobs() {
  for (const s of store.list()) {
    const p = store.get(s.id);
    if (!p) continue;
    for (const kind of ["research", "draft"]) {
      const st = kind === "research" ? p.research : p.draft;
      if (st.status !== "running") continue;
      if (st.job) poll(p.id, kind);
      else failJob(p.id, kind, "This was interrupted before it started. Try again.");
    }
  }
}

// A password-reset link signs the browser in; the person sets a new password before the Desk opens.
let resettingPassword = false;

async function startSession(session) {
  if (sessionUser || !session || resettingPassword) return;
  if (!termsAccepted(session.user)) {
    if (termsSession) return; // already asking
    termsSession = session;
    return showSignIn({ screen: "terms" });
  }
  sessionUser = session.user.id;
  account.email = session.user.email || "";
  hideSignIn();
  $("#main").innerHTML = '<div class="page"><p class="opening" role="status">Opening your desk…</p></div>';
  let me;
  try { me = await api("/api/me"); } catch { me = null; }
  if (me?.http === 403) {
    // The server requires a confirmed email (Supabase normally refuses the sign-in first).
    sessionUser = null;
    await signOut("local").catch(() => {});
    showSignIn();
    return drawCheckInbox(account.email, "unconfirmed");
  }
  if (me?.http === 401) { sessionUser = null; return; } // request() has shown the sign-in screen
  try {
    if (me?.http !== 200) throw new Error("me");
    await Promise.all([store.init({ uid: session.user.id, api: request, summarize }), loadProfile()]);
  } catch {
    return showFatal("Couldn't load your account", "Sociai couldn't load your projects and profile. Check your connection, then refresh the page.");
  }
  ready = true;
  render({ instant: true });
  resumeJobs();
  if (me.data.blocked) toast(me.data.blocked, { ms: 12000 });
  handleCheckoutReturn();
}

const LINK_ERROR = "That link has expired or was already used.";

async function boot() {
  // Email links come back as ?auth=confirmed or ?auth=reset, with a one-time ?code= (PKCE) or,
  // with custom email templates, ?token_hash=...&type=...
  const query = new URLSearchParams(location.search);
  let kind = query.get("auth");
  const tokenHash = query.get("token_hash"), otpType = query.get("type");
  const screen = requestedScreen();
  if (tokenHash) kind = otpType === "recovery" ? "reset" : "confirmed";
  let auth;
  try {
    auth = await initAuth();
  } catch {
    return showFatal("Sociai couldn't load", "The sign-in service didn't load. Check your connection, then refresh the page.");
  }
  if (!auth.configured) {
    return showFatal("Sociai isn't set up yet", "This server needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. See .env.example.");
  }
  let session = auth.session, linkError = auth.linkError;
  if (auth.recovery) kind = "reset";
  const unexchanged = query.has("code") && !session; // the link was opened in another browser
  if (tokenHash && !linkError) {
    const { data, error } = await verifyEmailLink(tokenHash, otpType);
    if (error) linkError = error; else session = data.session;
  }
  for (const k of ["auth", "code", "token_hash", "type", "error", "error_code", "error_description", "sb_flow_id", "mode"]) query.delete(k);
  const hash = /(^#|&)(access_token|error)=/.test(location.hash) ? "" : location.hash;
  history.replaceState(null, "", location.pathname + (query.toString() ? `?${query}` : "") + hash);

  resettingPassword = kind === "reset" && !!session && !linkError;
  onAuthChange((event, s) => {
    if (event === "SIGNED_OUT") return sessionUser && location.reload();
    if (resettingPassword || event === "INITIAL_SESSION") return; // boot decides what the first screen is
    if (s && !sessionUser) return startSession(s); // e.g. signed in from another tab
    if (s && s.user.id !== sessionUser) location.reload();
  });
  let deleted = false;
  try { deleted = sessionStorage.getItem("sociai.deleted") === "1"; sessionStorage.removeItem("sociai.deleted"); } catch {}

  if (kind === "reset") {
    if (resettingPassword) { account.email = session.user.email || ""; return showSignIn({ screen: "new-password" }); }
    return showSignIn({ screen: "forgot", message: linkError ? `${LINK_ERROR} Send yourself a new reset link.`
      : unexchanged ? "Open the reset link in the same browser you asked for it from, or send a new one here." : "" });
  }
  if (session) {
    if (kind === "confirmed") toast("Email confirmed. Welcome to Sociai.");
    return startSession(session);
  }
  if (kind === "confirmed") {
    return linkError ? showSignIn({ message: `${LINK_ERROR} Sign in, and Sociai will offer to send a new confirmation email.` })
      : showSignIn({ notice: "Your email is confirmed. Sign in with your password to continue." });
  }
  if (deleted || linkError) return showSignIn({ message: deleted ? "Your account and all its data were deleted." : LINK_ERROR });
  showSignIn({ screen });
}

boot();
