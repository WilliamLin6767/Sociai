// Projects live in this browser's localStorage, one store per signed-in user. One record
// per outreach; research, review and draft all hang off it, so stages never lose each other's state.

const LEGACY_KEY = "sociai.v1"; // before accounts, one store per browser
let KEY = LEGACY_KEY;

const blank = () => ({ version: 1, projects: {}, profile: { background: "", samples: [] }, pending: null });

function read() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "null");
    if (data && data.projects) return { ...blank(), ...data };
  } catch {}
  return blank();
}

let db = blank();
let timer = null;
const savedListeners = new Set();
const changeListeners = new Set();

function flush() {
  clearTimeout(timer);
  timer = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    savedListeners.forEach((fn) => fn(true));
  } catch (err) {
    savedListeners.forEach((fn) => fn(false, err));
  }
}

function persist() {
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

addEventListener("pagehide", () => timer && flush());

// Another tab changed something: take its copy (this tab saves on every edit, so
// nothing unsaved is lost) and let views refresh.
addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  db = read();
  changeListeners.forEach((fn) => fn(null, "external"));
});

const emit = (id, part) => changeListeners.forEach((fn) => fn(id, part));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Switch to a user's projects. Projects saved before accounts existed go to the first user
// who signs in on this browser.
export function useUser(id) {
  KEY = `${LEGACY_KEY}.${id}`;
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(KEY)) localStorage.setItem(KEY, legacy);
    if (legacy) localStorage.removeItem(LEGACY_KEY);
  } catch {}
  db = read();
}

export const store = {
  get profile() { return db.profile; },
  get pending() { return db.pending; },
  setPending(brief) { db.pending = brief; persist(); },

  list() { return Object.values(db.projects).sort((a, b) => b.updatedAt - a.updatedAt); },
  get(id) { return db.projects[id]; },

  create(brief) {
    const now = Date.now();
    const p = {
      id: uid(), createdAt: now, updatedAt: now, brief,
      research: { status: "idle", events: [] },
      review: null,
      draft: { status: "idle", versions: [], current: -1 },
      copiedAt: null,
    };
    db.projects[p.id] = p;
    persist();
    emit(p.id, "create");
    return p;
  },

  // part names what changed, so views can skip work. "edit" is typing: saved, not re-rendered.
  update(id, fn, part = "any") {
    const p = db.projects[id];
    if (!p) return null;
    fn(p);
    p.updatedAt = Date.now();
    persist();
    emit(id, part);
    return p;
  },

  remove(id) {
    const p = db.projects[id];
    delete db.projects[id];
    persist();
    emit(id, "remove");
    return p;
  },

  restore(p) {
    db.projects[p.id] = p;
    persist();
    emit(p.id, "create");
  },

  saveProfile(patch) { Object.assign(db.profile, patch); persist(); },

  onSaved(fn) { savedListeners.add(fn); return () => savedListeners.delete(fn); },
  on(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
};
