// Sociai: one workspace, four stages (Recipient → Research → Review → Draft) over a
// single saved project. Views are plain functions that render into #main and return
// a cleanup; store updates tell them what changed.

import { store } from "./store.js";
import { Loom, domain, normUrl } from "./loom.js";

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
};
const MARK = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="9" cy="22" r="3.6" fill="currentColor"/><circle cx="23" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11.8 19.6C15 16 14.6 21.2 20.4 12.4" fill="none" stroke="var(--thread)" stroke-width="2.2" stroke-linecap="round"/></svg>`;
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
    sources: d.sources || [], notes: r.notes || "", reviewed: true,
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

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data;
  try { data = await res.json(); } catch { data = { error: `The server answered with an error (${res.status}).` }; }
  return { http: res.status, data };
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
    if (res.http === 404) { polling.delete(key); return failJob(id, kind, res.data.error || "This job is no longer running."); }
    const d = res.data;
    if (kind === "research" && d.events?.length) store.update(id, (p) => { p.research.events.push(...d.events); }, "research-events");
    if (d.status === "done") { polling.delete(key); return kind === "research" ? finishResearch(id, d.result) : finishDraft(id, d.result); }
    if (d.status === "error") { polling.delete(key); return failJob(id, kind, d.error); }
    polling.set(key, setTimeout(tick, 900));
  };
  polling.set(key, setTimeout(tick, 250));
}

function failJob(id, kind, message) {
  store.update(id, (p) => {
    const st = kind === "research" ? p.research : p.draft;
    Object.assign(st, { status: "error", error: message, job: null });
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
    const { data } = await api("/api/research", { request: requestOf(store.get(id)) });
    if (data.error || !data.job) throw new Error(data.error || "The server didn't start the research.");
    store.update(id, (p) => { p.research.job = data.job; }, "edit");
    poll(id, "research");
  } catch (e) {
    failJob(id, "research", e instanceof TypeError ? "Couldn't reach the Sociai server. Is it running?" : String(e.message || e));
  }
}

function finishResearch(id, dossier) {
  store.update(id, (p) => {
    Object.assign(p.research, { status: "done", finishedAt: Date.now(), dossier, job: null });
    p.review = buildReview(dossier, p.review);
  }, "research");
}

async function startDraft(id, { instruction = null, label = "First draft" } = {}) {
  const p = store.get(id);
  const cur = currentVersion(p);
  const body = { request: requestOf(p), dossier: dossierPayload(p) };
  if (instruction && cur) body.revise = { subject: cur.subject, body: cur.body, instruction };
  const threads = instruction && cur ? cur.threads : p.review.hooks.filter((h) => h.selected).map((h) => ({ id: h.id, text: h.text }));
  store.update(id, (p) => { Object.assign(p.draft, { status: "running", error: null, job: null, pending: { label, threads, revise: !!body.revise } }); }, "draft");
  try {
    const { data } = await api("/api/draft", body);
    if (data.error || !data.job) throw new Error(data.error || "The server didn't start the draft.");
    store.update(id, (p) => { p.draft.job = data.job; }, "edit");
    poll(id, "draft");
  } catch (e) {
    failJob(id, "draft", e instanceof TypeError ? "Couldn't reach the Sociai server. Is it running?" : String(e.message || e));
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

function render({ instant = false } = {}) {
  const route = parseRoute();
  let p = null;
  if (route.view === "project") {
    p = store.get(route.id);
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
    const fn = route.view === "desk" ? deskView : VIEWS[route.stage];
    view = { route, cleanup: fn(p, from) };
    if (!instant) { window.scrollTo(0, 0); focusMain(route); }
  };
  const same = from && from.view === route.view && from.id === route.id && from.stage === route.stage;
  if (instant || same || !from || !document.startViewTransition || reduced.matches) return swap();
  document.documentElement.dataset.dir = direction(from, route);
  const t = document.startViewTransition(swap);
  t.finished.finally(() => {
    delete document.documentElement.dataset.dir;
    $$("[data-vt]").forEach((el) => { el.style.viewTransitionName = ""; el.removeAttribute("data-vt"); });
  });
}

function focusMain(route) {
  if (route.view === "desk") {
    if (finePointer.matches) $("#f-target")?.focus({ preventScroll: true });
    return;
  }
  const h = $("#main [data-focus-on-enter]");
  if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
}

addEventListener("hashchange", () => render());

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
    <a class="brand" href="#/" aria-label="Sociai: your desk">${MARK}<span class="brand-word">Sociai</span></a>
    ${p ? `<div class="crumb"><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-who" id="crumb-who">${esc(nameOf(p))}</span><span class="crumb-goal" id="crumb-goal">${esc(p.brief.goal)}</span></div>
      <div id="nav-slot">${threadNav(p, route.stage)}</div>` : '<div class="crumb"></div>'}
    <div class="bar-end">${p ? '<span class="saved" id="saved" title="Saved in this browser"><span>Saved</span></span>' : ""}${themeButton()}</div>
  </div>`;
}

store.onSaved((ok) => {
  const el = $("#saved");
  if (!el) return;
  el.classList.toggle("is-failed", !ok);
  el.querySelector("span").textContent = ok ? "Saved" : "Not saved";
  if (ok) { el.classList.remove("is-fresh"); void el.offsetWidth; el.classList.add("is-fresh"); }
});

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
function closeMenus() { $$(".menu").forEach((m) => m.remove()); $$("[data-act='refine-menu']").forEach((b) => b.setAttribute("aria-expanded", "false")); }

function citeHTML(source, src) {
  if (!source) return ` <span class="cite nolink" title="No source given">?</span>`;
  const n = src.num(source);
  const label = src.title(source) || (isUrl(source) ? domain(source) : source);
  return `<button type="button" class="cite${isUrl(source) ? "" : " nolink"}" data-act="cite" data-src="${esc(source)}" aria-expanded="false" aria-label="Source ${n}: ${esc(label)}">${n}</button>`;
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
        <div class="suggest" id="suggest" hidden></div>
        <p class="field-error" id="err-goal" hidden>Say what you're hoping for. One sentence is plenty.</p>
      </div>
    </div>
    <div class="row">
      <div class="margin">${lbl("04", "About you", "f-bg")}<p class="margin-note">Optional. Helps Sociai find real common ground.</p></div>
      <div class="col">
        <textarea class="textarea" id="f-bg" name="background" rows="3" placeholder="${esc(pur.about)}">${esc(b.background)}</textarea>
        ${isNew && b.background && b.background === store.profile.background ? '<p class="profile-note">Remembered from your last outreach</p>' : ""}
      </div>
    </div>
    <div class="row">
      <div class="margin">${lbl("05", "Your voice")}<p class="margin-note">Optional. Paste up to three things you've written so the draft sounds like you.</p></div>
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
  </div></div>
  ${isNew ? `<div class="row"><div class="margin"></div><div class="col composer-actions">
      ${primary("Begin research", "begin")}
      <span class="muted" style="font-size:13.5px">Sociai reads public pages and cites them. It never sends anything for you.</span>
    </div></div>` : ""}`;
}

function mountComposer(root, { brief, mode, onChange, onSubmit }) {
  const b = brief;
  const touched = new Set(mode === "edit" ? ["channel", "words"] : []);
  const f = { target: $("#f-target", root), goal: $("#f-goal", root), bg: $("#f-bg", root), words: $("#f-words", root) };
  const unfold = $("#unfold", root);
  const open = (instant) => {
    if (unfold.classList.contains("is-open")) return;
    if (instant) unfold.style.transition = "none";
    unfold.classList.add("is-open");
    if (instant) requestAnimationFrame(() => (unfold.style.transition = ""));
  };
  if (mode === "edit" || b.target || b.category) open(true);
  const changed = () => onChange?.(b);

  const renderSamples = () => {
    const host = $("#samples", root);
    host.innerHTML = b.samples.map((s, i) => `<div class="sample">
      <label class="vh" for="sample-${i}">Writing sample ${i + 1}</label>
      <textarea class="textarea" id="sample-${i}" data-sample="${i}" placeholder="Paste an email, post or message you wrote">${esc(s)}</textarea>
      <button type="button" class="icon-btn" data-act="remove-sample" data-i="${i}" aria-label="Remove sample ${i + 1}">${I.x}</button></div>`).join("");
    $("#add-sample", root).hidden = b.samples.length >= 3;
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

function deskView(_, from) {
  const all = store.list();
  const profile = store.profile;
  const brief = store.pending || { target: "", category: "", goal: "", background: profile.background || "", samples: [...(profile.samples || [])], channel: "email", max_words: 160 };
  $("#main").innerHTML = `<div class="ruled"><div class="page">
    <form class="composer" id="composer" novalidate>${composerHTML(brief, "new")}</form>
    ${all.length ? `<section class="ledger" aria-labelledby="ledger-title">
      <div class="row"><div class="margin"><h2 class="label" id="ledger-title">Correspondence</h2><p class="margin-note">Everything you've started, newest first. Saved in this browser.</p></div>
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
      const clean = { ...b, samples: b.samples.filter((s) => s.trim()) };
      store.saveProfile({ background: clean.background, samples: clean.samples });
      const p = store.create(clean);
      store.setPending(null);
      startResearch(p.id);
      go(stageHash(p, "research"));
    },
  });

  if (!all.length) return () => {};
  const rows = $("#rows"), filters = $("#filters");
  const drawRows = () => {
    const list = store.list();
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, 0]));
    list.forEach((p) => { counts.all++; counts[stateOf(p).key] = (counts[stateOf(p).key] || 0) + 1; });
    filters.innerHTML = FILTERS.filter(([k]) => k === "all" || counts[k]).map(([k, l]) =>
      `<button type="button" class="filter" data-act="filter" data-k="${k}" aria-pressed="${deskState.filter === k}">${l} <span class="n">${counts[k]}</span></button>`).join("");
    const q = deskState.query.trim().toLowerCase();
    const shown = list.filter((p) => (deskState.filter === "all" || stateOf(p).key === deskState.filter)
      && (!q || [nameOf(p), p.brief.target, p.brief.goal, p.research.dossier?.headline].join(" ").toLowerCase().includes(q)));
    rows.innerHTML = shown.map((p) => {
      const st = stateOf(p), av = available(p), cur = resumeStage(p);
      const pur = PURPOSES.find((x) => x.id === p.brief.category);
      return `<li class="entry" data-id="${p.id}">
        <a class="entry-link" href="#/p/${p.id}" data-act="open" data-id="${p.id}">
          <span class="mini" aria-hidden="true">${STAGES.map((s) => `<i class="${s === cur ? "cur" : av.includes(s) ? "on" : ""}"></i>`).join("")}</span>
          <span class="who"><span class="entry-name">${esc(nameOf(p))}</span>
            <span class="entry-role">${esc(p.research.dossier?.headline || (p.research.status === "running" ? "Researching…" : "Not researched yet"))}</span></span>
          <span class="entry-goal">${pur ? `<span class="tag">${esc(pur.label)}</span>` : ""}${esc(p.brief.goal)}</span>
          <span class="entry-state ${st.cls || ""}">${st.text}</span>
          <time class="entry-time" datetime="${new Date(p.updatedAt).toISOString()}">${ago(p.updatedAt)}</time>
          <span class="entry-go" aria-hidden="true">${I.arrow}</span>
          <span class="vh">, open at ${STAGE_LABEL[cur]}</span>
        </a>
        <button type="button" class="icon-btn entry-del" data-act="delete" data-id="${p.id}" aria-label="Delete outreach to ${esc(nameOf(p))}">${I.trash}</button>
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
      const gone = store.remove(a.dataset.id);
      toast(`Deleted “${nameOf(gone)}”`, { action: { label: "Undo", fn: () => store.restore(gone) }, ms: 7000 });
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
    if (r.status === "error") return "Research didn't finish";
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
    $("#stats").textContent = loom.stats().text;
    drawExtra(q);
    drawDock(q);
  };

  const drawExtra = (q) => {
    const r = q.research, extra = $("#rs-extra");
    const secs = ((r.finishedAt || Date.now()) - (r.startedAt || Date.now())) / 1000;
    $("#elapsed").textContent = r.status === "running" ? mmss(secs) : r.status === "done" ? `Took ${mmss(secs)}` : "";
    if (r.status === "error") {
      extra.innerHTML = `<div class="failure" role="alert"><p>The research stopped before it finished. ${r.dossier ? "Your earlier research is still there." : "Nothing was lost from your brief."}</p><code>${esc(r.error)}</code></div>`;
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
    if (ui.confirmCopy && v) {
      $("#dock-context").innerHTML = `<span class="confirm-copy" role="alert">${plural(phs.length, "placeholder")} still in the message.</span>`;
      $("#dock-actions").innerHTML = `<button class="btn btn-ghost" data-act="show-ph">Show me</button><button class="btn btn-primary" data-act="copy" data-force="1" data-primary>Copy anyway</button>`;
      return;
    }
    $("#dock-context").innerHTML = vers || `<span>${busy ? "Writing your first draft. This usually takes under a minute." : "No draft yet."}</span>`;
    $("#dock-actions").innerHTML = v ? `
      <div class="refine-menu"><button class="btn btn-ghost" data-act="refine-menu" aria-haspopup="true" aria-expanded="false" ${busy ? "disabled" : ""}>${I.sparkle}<span>Refine<span class="label-long"> tone &amp; length</span></span></button></div>
      <button class="btn btn-ghost" data-act="regenerate" ${busy ? "disabled" : ""} aria-label="Regenerate" title="Write a fresh draft from your research. This one stays in history.">${I.redo}<span class="label-long">Regenerate</span></button>
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
  const jump = t.closest("[data-act='jump-source']");
  if (jump) {
    closePop();
    const li = $(`#src-${jump.dataset.n}`);
    li?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "center" });
    if (li) { li.classList.remove("is-flash"); void li.offsetWidth; li.classList.add("is-flash"); }
    return;
  }
  if (popAnchor && !t.closest("#pop") && !t.closest("[data-act='cite']")) closePop();
  if ($(".menu") && !t.closest(".refine-menu")) closeMenus();
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

// Jobs that were running when the page closed carry on (the server keeps them).
for (const p of store.list()) {
  for (const kind of ["research", "draft"]) {
    const st = kind === "research" ? p.research : p.draft;
    if (st.status !== "running") continue;
    if (st.job) poll(p.id, kind);
    else failJob(p.id, kind, "This was interrupted before it started. Try again.");
  }
}
render({ instant: true });
