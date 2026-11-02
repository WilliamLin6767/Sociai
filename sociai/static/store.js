// Projects are saved to the signed-in user's account on the server, so they follow the user
// from browser to browser. One record per outreach: research, review and every draft version
// hang off it. This module keeps working copies in memory, saves each change to the server
// shortly after it happens, and keeps not-yet-saved changes in localStorage so closing the
// tab mid-edit loses nothing. The Desk works from light summaries; a project's full state is
// fetched when it's opened.

const SAVE_DELAY = 700;
const RETRY_DELAY = 5000;

let api = null;        // (method, path, body) -> {http, data}, provided by the app
let summarize = null;  // (project) -> summary shown on the Desk, provided by the app
let uid = null;

const summaries = new Map(); // id -> summary
const full = new Map();      // id -> project, for the ones opened in this session
const loading = new Map();   // id -> promise
const timers = new Map();    // id -> scheduled save
const dirty = new Set();     // changed and not yet confirmed by the server
const inflight = new Set();
const again = new Set();
const savedListeners = new Set();
const changeListeners = new Set();
let backupTimer = null;

const key = (name) => `sociai.${name}.${uid}`;
const readJSON = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? fallback; } catch { return fallback; } };
const writeJSON = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const emit = (id, part) => changeListeners.forEach((fn) => fn(id, part));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function remember(p) {
  full.set(p.id, p);
  summaries.set(p.id, { ...summarize(p), id: p.id, updatedAt: p.updatedAt });
}

// Unsaved projects go to localStorage, in case the tab closes before the server has them.
function backup() {
  clearTimeout(backupTimer);
  backupTimer = null;
  if (!uid) return;
  const unsaved = {};
  for (const id of dirty) if (full.has(id)) unsaved[id] = full.get(id);
  writeJSON(key("unsaved"), Object.keys(unsaved).length ? unsaved : null);
}

function schedule(id, delay = SAVE_DELAY) {
  dirty.add(id);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => save(id), delay));
  if (!backupTimer) backupTimer = setTimeout(backup, 250);
}

async function save(id) {
  timers.delete(id);
  if (inflight.has(id)) { again.add(id); return; } // one save at a time per project, in order
  const p = full.get(id);
  if (!p) { dirty.delete(id); return; }
  const version = p.updatedAt;
  const summary = summaries.get(id) || {};
  inflight.add(id);
  let ok = false;
  try {
    const { http } = await api("PUT", `/api/projects/${encodeURIComponent(id)}`, { name: summary.name || "", summary, data: p });
    ok = http === 200;
  } catch {}
  inflight.delete(id);
  if (ok && full.get(id)?.updatedAt === version && !timers.has(id) && !again.has(id)) dirty.delete(id);
  if (!ok && !timers.has(id)) schedule(id, RETRY_DELAY);
  backup();
  savedListeners.forEach((fn) => fn(ok));
  if (again.delete(id)) save(id);
}

addEventListener("pagehide", backup);

// Projects saved in this browser before projects moved to the server.
const LOCAL_KEYS = () => [`sociai.v1.${uid}`, "sociai.v1"];

export const store = {
  async init(options) {
    ({ api, summarize, uid } = options);
    // First, anything left unsaved last time (the tab closed before the server had it).
    for (const p of Object.values(readJSON(key("unsaved"), {}))) {
      remember(p);
      dirty.add(p.id);
      await save(p.id);
    }
    const { http, data } = await api("GET", "/api/projects");
    if (http !== 200) throw new Error(data?.error || "Couldn't load your projects.");
    for (const row of data.projects) {
      if (dirty.has(row.id)) continue;
      summaries.set(row.id, { ...row.summary, id: row.id, updatedAt: row.summary.updatedAt || Date.parse(row.updated_at) });
    }
    // Running jobs keep polling after a refresh, so those projects are needed in full.
    const running = [...summaries.values()].filter((s) => s.running).map((s) => this.load(s.id).catch(() => null));
    await Promise.all(running);
  },

  list() { return [...summaries.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); },
  summary(id) { return summaries.get(id); },
  get(id) { return full.get(id); },

  load(id) {
    if (full.has(id)) return Promise.resolve(full.get(id));
    if (!loading.has(id)) {
      loading.set(id, (async () => {
        try {
          const { http, data } = await api("GET", `/api/projects/${encodeURIComponent(id)}`);
          if (http === 404) { summaries.delete(id); throw new Error("not_found"); }
          if (http !== 200) throw new Error(data?.error || "Couldn't open that project.");
          remember(data.project);
          return data.project;
        } finally {
          loading.delete(id);
        }
      })());
    }
    return loading.get(id);
  },

  create(brief) {
    const now = Date.now();
    const p = {
      id: newId(), createdAt: now, updatedAt: now, brief,
      research: { status: "idle", events: [] },
      review: null,
      draft: { status: "idle", versions: [], current: -1 },
      copiedAt: null,
    };
    remember(p);
    schedule(p.id, 0);
    emit(p.id, "create");
    return p;
  },

  // part names what changed, so views can skip work. "edit" is typing: saved, not re-rendered.
  update(id, fn, part = "any") {
    const p = full.get(id);
    if (!p) return null;
    fn(p);
    p.updatedAt = Date.now();
    remember(p);
    schedule(id);
    emit(id, part);
    return p;
  },

  // Deletes on the server right away; returns the full project so the caller can offer undo.
  async remove(id) {
    const p = full.get(id) || await this.load(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    dirty.delete(id);
    summaries.delete(id);
    full.delete(id);
    backup();
    emit(id, "remove");
    const { http } = await api("DELETE", `/api/projects/${encodeURIComponent(id)}`);
    if (http !== 200) { remember(p); emit(id, "create"); throw new Error("Couldn't delete that project."); }
    return p;
  },

  restore(p) {
    remember(p);
    schedule(p.id, 0);
    emit(p.id, "create");
  },

  // Projects from this browser's old local storage that aren't in the account yet.
  localProjects() {
    const found = new Map();
    for (const k of LOCAL_KEYS()) {
      const db = readJSON(k, null);
      for (const p of Object.values(db?.projects || {})) if (!summaries.has(p.id) && !found.has(p.id)) found.set(p.id, p);
    }
    return [...found.values()];
  },
  localProfile() {
    for (const k of LOCAL_KEYS()) {
      const prof = readJSON(k, null)?.profile;
      if (prof && (prof.background || prof.samples?.length)) return prof;
    }
    return null;
  },
  importProjects(projects) {
    for (const p of projects) { remember(p); schedule(p.id, 0); }
    emit(null, "create");
  },
  forgetLocal() { for (const k of LOCAL_KEYS()) writeJSON(k, null); },

  // The brief being written on the Desk, before it becomes a project (this browser only).
  get pending() { return readJSON(key("pending"), null); },
  setPending(brief) { writeJSON(key("pending"), brief); },

  clearBrowserData() { for (const name of ["unsaved", "pending", "importDismissed"]) writeJSON(key(name), null); this.forgetLocal(); },
  dismissImport() { writeJSON(key("importDismissed"), true); },
  get importDismissed() { return !!readJSON(key("importDismissed"), false); },

  onSaved(fn) { savedListeners.add(fn); return () => savedListeners.delete(fn); },
  on(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
};
