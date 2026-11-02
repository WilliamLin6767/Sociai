// Outreach tracker: the people you've written to, entered by hand, with a table, a month
// calendar and the follow-ups coming due. Nothing here reads an inbox, sends anything or uses
// credits. The server applies the follow-up rules (sociai/tracker.py) and says what's due.

export const ROLES = [["professor", "Professor"], ["recruiter", "Recruiter"], ["alum", "Alum"], ["other", "Other"]];
export const STATUSES = [["drafted", "Drafted"], ["sent", "Sent"], ["replied", "Replied"], ["no_reply", "No reply"],
  ["follow_up_due", "Follow-up due"], ["closed", "Closed"]];
const FOLLOW_UP_DAYS = { professor: 30, recruiter: 7, alum: 10, other: 10 }; // as in sociai/tracker.py
const TEXT = ["name", "email", "organization", "subject", "notes"];
const DATES = ["sent_at", "follow_up_at", "replied_at"];
const KIND_LABEL = { sent: "Sent", replied: "Replied", follow: "Follow up" };

let ctx = null; // { request, toast, esc, icons } from app.js
export function initTracker(c) { ctx = c; }

/* ───────── Dates (all local, as YYYY-MM-DD) ───────── */

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => iso(new Date());
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s, opts = { month: "short", day: "numeric" }) => (s ? parseISO(s).toLocaleDateString(undefined, opts) : "");
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const label = (list, v) => list.find((x) => x[0] === v)?.[1] || v;
function dueText(n) {
  if (n < 0) return `Overdue by ${n === -1 ? "1 day" : `${-n} days`}`;
  return n === 0 ? "Due today" : n === 1 ? "Due tomorrow" : `Due in ${n} days`;
}

/* ───────── Data ───────── */

let contacts = [];
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());
// The browser's date goes with every call, so "today" is the user's, not the server's (UTC).
const call = (method, path, body) => ctx.request(method, `${path}?today=${todayISO()}`, body);

async function load() {
  const { http, data } = await call("GET", "/api/contacts");
  if (http !== 200) throw new Error(data?.error || "Couldn't load your tracker.");
  contacts = data.contacts;
}

async function save(id, fields) {
  const { http, data } = await call(id ? "PATCH" : "POST", id ? `/api/contacts/${id}` : "/api/contacts", fields);
  if (http !== 200) { ctx.toast(data?.error || "Couldn't save that. Try again."); return null; }
  const i = contacts.findIndex((c) => c.id === data.contact.id);
  if (i >= 0) contacts[i] = data.contact; else contacts.unshift(data.contact);
  changed();
  return data.contact;
}

async function remove(id) {
  const { http, data } = await call("DELETE", `/api/contacts/${id}`);
  if (http !== 200) { ctx.toast(data?.error || "Couldn't delete that. Try again."); return false; }
  contacts = contacts.filter((c) => c.id !== id);
  changed();
  return true;
}

// A status change from the table or the Due soon panel, with a word about the dates it moved.
async function setStatus(id, status) {
  const c = await save(id, { status });
  if (!c) return changed(); // puts the old status back in the select
  if (status === "sent" && c.follow_up_at) ctx.toast(`Marked sent. Follow up on ${fmtDate(c.follow_up_at, { weekday: "short", month: "short", day: "numeric" })}.`);
  else if (status === "replied") ctx.toast("Marked replied. Follow-up cleared.");
}

/* ───────── Add / edit dialog ───────── */

// prefill sets fields of a new contact (e.g. from a draft); onSaved gets the saved contact.
export function openContactEditor(contact = null, { prefill = {}, onSaved } = {}) {
  const { esc } = ctx;
  const c = contact || { name: "", email: "", role: "other", organization: "", subject: "", status: "drafted",
    sent_at: null, follow_up_at: null, replied_at: null, notes: "", ...prefill };
  const opts = (list, v) => list.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${l}</option>`).join("");
  const field = (id, text, input, cls = "") => `<div class="tr-field ${cls}"><label class="label" for="tr-${id}">${text}</label>${input}</div>`;
  const dateInput = (k) => `<input class="input" type="date" id="tr-${k}" name="${k}" value="${esc(c[k] || "")}" min="2000-01-01" max="2100-12-31">`;
  const dlg = document.createElement("dialog");
  dlg.className = "tr-dialog";
  dlg.setAttribute("aria-labelledby", "tr-dlg-title");
  dlg.innerHTML = `<form class="tr-form" novalidate>
    <header class="tr-dialog-head"><h2 class="h3" id="tr-dlg-title">${contact ? "Edit contact" : "Add to tracker"}</h2>
      <button type="button" class="icon-btn" data-act="tr-cancel" aria-label="Close">${ctx.icons.x}</button></header>
    <div class="tr-grid">
      ${field("name", "Name", `<input class="input" id="tr-name" name="name" maxlength="200" required autocomplete="off" value="${esc(c.name)}">`, "wide")}
      ${field("email", "Email", `<input class="input" type="email" id="tr-email" name="email" maxlength="320" autocomplete="off" value="${esc(c.email)}">`)}
      ${field("role", "Role", `<select class="input" id="tr-role" name="role">${opts(ROLES, c.role)}</select>`)}
      ${field("organization", "Organization", `<input class="input" id="tr-organization" name="organization" maxlength="200" autocomplete="off" value="${esc(c.organization)}">`, "wide")}
      ${field("subject", "Subject", `<input class="input" id="tr-subject" name="subject" maxlength="300" autocomplete="off" value="${esc(c.subject)}">`, "wide")}
      ${field("status", "Status", `<select class="input" id="tr-status" name="status">${opts(STATUSES, c.status)}</select>`)}
      ${field("sent_at", "Sent", dateInput("sent_at"))}
      ${field("follow_up_at", "Follow up", dateInput("follow_up_at") + '<p class="field-hint" id="tr-follow-hint"></p>')}
      ${field("replied_at", "Replied", dateInput("replied_at"))}
      ${field("notes", "Notes", `<textarea class="textarea" id="tr-notes" name="notes" maxlength="5000" rows="3">${esc(c.notes)}</textarea>`, "wide")}
    </div>
    <p class="field-error" id="tr-err" role="alert" hidden></p>
    <footer class="tr-dialog-foot">
      ${contact ? `<button type="button" class="btn btn-danger btn-sm" data-act="tr-delete">${ctx.icons.trash} Delete</button>` : ""}
      <span class="tr-spacer"></span>
      <button type="button" class="btn btn-ghost" data-act="tr-cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">${contact ? "Save" : "Add contact"}</button>
    </footer></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form"), f = form.elements;
  const err = (m) => { const el = dlg.querySelector("#tr-err"); el.textContent = m; el.hidden = !m; };

  // Says what an empty follow-up date will become, so the default is never a surprise.
  const hint = () => {
    const status = f.status.value, days = FOLLOW_UP_DAYS[f.role.value];
    const el = dlg.querySelector("#tr-follow-hint");
    if (status === "replied") el.textContent = "Cleared when you save a reply.";
    else if (status === "sent" && !f.follow_up_at.value && c.status !== "sent") {
      el.textContent = `Leave empty for ${days} days after the sent date (${label(ROLES, f.role.value).toLowerCase()}).`;
    } else el.textContent = "";
  };
  form.addEventListener("input", hint);
  hint();

  const value = (k) => (DATES.includes(k) ? f[k].value || null : f[k].value.trim());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!value("name")) { err("Enter the person's name."); return f.name.focus(); }
    if (value("email") && !f.email.checkValidity()) { err("That email address doesn't look right."); return f.email.focus(); }
    const fields = {};
    for (const k of [...TEXT, "role", "status", ...DATES]) {
      const v = value(k);
      if (contact ? v !== (c[k] ?? (DATES.includes(k) ? null : "")) : v !== null) fields[k] = v;
    }
    if (contact && !Object.keys(fields).length) return dlg.close();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    const saved = await save(contact?.id, fields);
    btn.disabled = false;
    if (!saved) return;
    dlg.close();
    onSaved?.(saved);
  });
  dlg.addEventListener("click", async (e) => {
    if (e.target === dlg || e.target.closest("[data-act='tr-cancel']")) return dlg.close(); // click on the backdrop
    const del = e.target.closest("[data-act='tr-delete']");
    if (!del) return;
    if (!del.dataset.sure) { del.dataset.sure = "1"; del.classList.add("is-solid"); del.innerHTML = "Delete for good?"; return; }
    del.disabled = true;
    if (await remove(contact.id)) { dlg.close(); ctx.toast(`${contact.name} was removed from your tracker.`); } else del.disabled = false;
  });
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  f.name.focus();
  if (f.name.value) f.name.select();
}

/* ───────── The Tracker page ───────── */

const pref = (k, fallback) => { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const STATUS_ORDER = Object.fromEntries(STATUSES.map(([k], i) => [k, i]));
const COLUMNS = [["name", "Name"], ["role", "Role"], ["organization", "Organization"], ["subject", "Subject"],
  ["sent_at", "Sent"], ["shown_status", "Status"], ["follow_up_at", "Follow up"]];

export function trackerView() {
  const { esc } = ctx;
  const main = document.getElementById("main");
  const now = new Date();
  const st = {
    mode: pref("sociai.trackerView", "table"), sort: "created_at", dir: -1, status: "", role: "", q: "",
    month: new Date(now.getFullYear(), now.getMonth(), 1), day: todayISO(), loaded: false, error: "",
  };
  main.innerHTML = `<div class="page tracker">
    <header class="tr-head">
      <div><p class="label">Outreach</p><h1 class="h2" data-focus-on-enter>Tracker</h1>
        <p class="field-hint">Who you've written to, and when to follow up. You add people here yourself. Nothing reads your inbox or uses credits.</p></div>
      <button type="button" class="btn btn-primary" data-act="tr-add">Add contact</button>
    </header>
    <section class="tr-due" id="tr-due" aria-labelledby="tr-due-title"></section>
    <div class="tr-switch choices" role="group" aria-label="View">
      <button type="button" class="choice choice-sm" data-act="tr-mode" data-mode="table">Table</button>
      <button type="button" class="choice choice-sm" data-act="tr-mode" data-mode="calendar">Calendar</button>
    </div>
    <div id="tr-view"><p class="opening" role="status">Loading your tracker…</p></div>
  </div>`;
  const $ = (s) => main.querySelector(s);

  // ── Due soon ──
  const drawDue = () => {
    const due = contacts.filter((c) => c.due_in !== null).sort((a, b) => a.due_in - b.due_in);
    $("#tr-due").innerHTML = `<div class="tr-due-head"><h2 class="label" id="tr-due-title">Due soon</h2>
        <span class="tr-due-count">${due.length ? `${due.length} follow-up${due.length === 1 ? "" : "s"} in the next 7 days or overdue` : ""}</span></div>
      ${due.length ? `<ul class="tr-due-list">${due.map((c) => `<li class="tr-due-item${c.due_in < 0 ? " is-overdue" : ""}">
          <button type="button" class="tr-due-who" data-act="tr-edit" data-id="${c.id}"><b>${esc(c.name)}</b>${c.organization ? `<span>${esc(c.organization)}</span>` : ""}</button>
          <span class="tr-due-when">${dueText(c.due_in)} · ${fmtDate(c.follow_up_at, { weekday: "short", month: "short", day: "numeric" })}</span>
          <span class="tr-due-acts"><button type="button" class="btn btn-line btn-sm" data-act="tr-replied" data-id="${c.id}">Mark replied</button></span>
        </li>`).join("")}</ul>`
        : `<p class="tr-due-empty">${st.loaded ? "Nothing due in the next 7 days." : ""}</p>`}`;
  };

  // ── Table ──
  const shown = () => {
    const q = st.q.toLowerCase();
    const rows = contacts.filter((c) => (!st.status || c.shown_status === st.status) && (!st.role || c.role === st.role)
      && (!q || [c.name, c.email, c.organization, c.subject, c.notes].some((x) => x.toLowerCase().includes(q))));
    const key = st.sort;
    const val = (c) => (key === "shown_status" ? STATUS_ORDER[c[key]] : key === "role" ? label(ROLES, c.role) : c[key] || null);
    return rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return 0;
      if (x === null || x === "") return 1; // blanks last either way
      if (y === null || y === "") return -1;
      return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: "base" })) * st.dir;
    });
  };
  const drawTable = () => {
    $("#tr-view").innerHTML = `<div class="tr-tools">
        <label class="vh" for="tr-q">Search contacts</label><input class="input input-sm tr-q" id="tr-q" type="search" placeholder="Search" value="${esc(st.q)}" autocomplete="off">
        <label class="vh" for="tr-f-status">Filter by status</label><select class="input input-sm" id="tr-f-status"><option value="">All statuses</option>${STATUSES.map(([k, l]) => `<option value="${k}"${k === st.status ? " selected" : ""}>${l}</option>`).join("")}</select>
        <label class="vh" for="tr-f-role">Filter by role</label><select class="input input-sm" id="tr-f-role"><option value="">All roles</option>${ROLES.map(([k, l]) => `<option value="${k}"${k === st.role ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="tr-count" id="tr-count" aria-live="polite"></span>
      </div><div id="tr-table"></div>`;
    drawRows();
  };
  const drawRows = () => {
    const rows = shown();
    $("#tr-count").textContent = `${rows.length} of ${contacts.length}`;
    if (!contacts.length) {
      $("#tr-table").innerHTML = `<p class="empty">No one here yet. Add someone you've written to, or press "Track this" under a draft.</p>`;
      return;
    }
    if (!rows.length) { $("#tr-table").innerHTML = `<p class="empty">No contacts match these filters.</p>`; return; }
    const th = ([k, l]) => `<th scope="col" aria-sort="${st.sort === k ? (st.dir === 1 ? "ascending" : "descending") : "none"}" class="tr-col-${k}">
      <button type="button" data-act="tr-sort" data-k="${k}">${l}<span class="tr-sort" aria-hidden="true">${st.sort === k ? (st.dir === 1 ? "↑" : "↓") : ""}</span></button></th>`;
    $("#tr-table").innerHTML = `<div class="tr-table-wrap"><table class="tr-table">
      <thead><tr>${COLUMNS.map(th).join("")}<th scope="col"><span class="vh">Actions</span></th></tr></thead>
      <tbody>${rows.map((c) => `<tr data-id="${c.id}">
        <td class="tr-col-name"><button type="button" class="tr-name" data-act="tr-edit" data-id="${c.id}">${esc(c.name)}</button>${c.email ? `<span class="tr-sub">${esc(c.email)}</span>` : ""}</td>
        <td data-label="Role">${label(ROLES, c.role)}</td>
        <td data-label="Organization">${esc(c.organization)}</td>
        <td data-label="Subject" class="tr-col-subject">${esc(c.subject)}</td>
        <td data-label="Sent" class="tr-date">${fmtDate(c.sent_at)}</td>
        <td data-label="Status"><label class="vh" for="st-${c.id}">Status of ${esc(c.name)}</label>
          <select class="tr-status" id="st-${c.id}" data-status="${c.shown_status}" data-act="tr-status" data-id="${c.id}">
            ${STATUSES.map(([k, l]) => `<option value="${k}"${k === c.shown_status ? " selected" : ""}>${l}</option>`).join("")}</select></td>
        <td data-label="Follow up" class="tr-date${c.due_in !== null && c.due_in < 0 ? " is-overdue" : ""}">${fmtDate(c.follow_up_at)}</td>
        <td class="tr-acts"><button type="button" class="icon-btn" data-act="tr-edit" data-id="${c.id}" aria-label="Edit ${esc(c.name)}" title="Edit">${ctx.icons.pen}</button></td>
      </tr>`).join("")}</tbody></table></div>`;
  };

  // ── Calendar ──
  const events = () => {
    const by = {};
    const add = (d, kind, c) => d && (by[d] ||= []).push({ kind, c });
    for (const c of contacts) {
      add(c.sent_at, "sent", c);
      add(c.replied_at, "replied", c);
      if (c.status !== "closed") add(c.follow_up_at, "follow", c);
    }
    return by;
  };
  const drawCalendar = (focus = false) => {
    const by = events(), today = todayISO();
    const y = st.month.getFullYear(), m = st.month.getMonth();
    const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()); // the Sunday on or before the 1st
    const weeks = Math.ceil((new Date(y, m, 1).getDay() + new Date(y, m + 1, 0).getDate()) / 7);
    if (st.day.slice(0, 7) !== iso(st.month).slice(0, 7)) st.day = today.slice(0, 7) === iso(st.month).slice(0, 7) ? today : iso(st.month);
    const days = Array.from({ length: weeks * 7 }, (_, i) => iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
    const names = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
    const chip = (e) => `<span class="cal-chip is-${e.kind}${e.kind === "follow" && e.c.due_in !== null && e.c.due_in < 0 ? " is-overdue" : ""}"><i aria-hidden="true"></i><span>${esc(e.c.name)}</span></span>`;
    $("#tr-view").innerHTML = `<div class="cal">
      <div class="cal-head">
        <button type="button" class="icon-btn" data-act="cal-prev" aria-label="Previous month">${ctx.icons.back}</button>
        <h2 class="h3 cal-title" aria-live="polite">${st.month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <button type="button" class="icon-btn" data-act="cal-next" aria-label="Next month">${ctx.icons.arrow}</button>
        <button type="button" class="btn btn-line btn-sm" data-act="cal-today">Today</button>
        <span class="cal-legend" aria-hidden="true"><span class="cal-chip is-sent"><i></i>Sent</span><span class="cal-chip is-replied"><i></i>Replied</span><span class="cal-chip is-follow"><i></i>Follow up</span></span>
      </div>
      <div class="cal-grid" role="grid" aria-label="${st.month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}">
        <div class="cal-row" role="row">${names.map((n) => `<span class="cal-dow" role="columnheader">${n}</span>`).join("")}</div>
        ${Array.from({ length: weeks }, (_, w) => `<div class="cal-row" role="row">${days.slice(w * 7, w * 7 + 7).map((d) => {
          const ev = by[d] || [], out = d.slice(0, 7) !== iso(st.month).slice(0, 7);
          const desc = ev.length ? `, ${ev.length} item${ev.length === 1 ? "" : "s"}` : "";
          return `<button type="button" role="gridcell" class="cal-day${out ? " is-out" : ""}${d === today ? " is-today" : ""}${d === st.day ? " is-selected" : ""}"
              data-act="cal-day" data-date="${d}" tabindex="${d === st.day ? 0 : -1}" aria-selected="${d === st.day}"
              aria-label="${fmtDate(d, { weekday: "long", month: "long", day: "numeric" })}${d === today ? ", today" : ""}${desc}">
            <span class="cal-n">${parseISO(d).getDate()}</span>
            <span class="cal-chips">${ev.slice(0, 3).map(chip).join("")}${ev.length > 3 ? `<span class="cal-more">+${ev.length - 3}</span>` : ""}</span></button>`;
        }).join("")}</div>`).join("")}
      </div>
      <section class="cal-agenda" aria-live="polite" id="cal-agenda"></section></div>`;
    drawAgenda(by);
    if (focus) $(".cal-day.is-selected")?.focus();
  };
  const drawAgenda = (by = events()) => {
    const ev = by[st.day] || [];
    $("#cal-agenda").innerHTML = `<h3 class="label">${fmtDate(st.day, { weekday: "long", month: "long", day: "numeric" })}</h3>
      ${ev.length ? `<ul class="cal-items">${ev.map((e) => `<li><button type="button" class="cal-item" data-act="tr-edit" data-id="${e.c.id}">
          <span class="cal-chip is-${e.kind}${e.kind === "follow" && e.c.due_in !== null && e.c.due_in < 0 ? " is-overdue" : ""}"><i aria-hidden="true"></i>${KIND_LABEL[e.kind]}</span>
          <b>${esc(e.c.name)}</b>${e.c.organization ? `<span class="tr-sub">${esc(e.c.organization)}</span>` : ""}
          ${e.c.subject ? `<span class="tr-sub">${esc(e.c.subject)}</span>` : ""}</button></li>`).join("")}</ul>`
        : `<p class="tr-due-empty">Nothing on this day.</p>`}`;
  };

  const drawView = () => {
    main.querySelectorAll("[data-act='tr-mode']").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === st.mode));
    if (st.error) { $("#tr-view").innerHTML = `<p class="empty">${esc(st.error)}</p>`; return; }
    if (!st.loaded) return;
    (st.mode === "calendar" ? drawCalendar : drawTable)();
  };
  const redraw = () => {
    drawDue();
    if (st.mode === "table" && $("#tr-table")) drawRows(); else drawView();
  };
  listeners.add(redraw);
  drawDue();
  drawView();
  let alive = true;
  load().then(() => { st.loaded = true; }, (e) => { st.error = e.message; })
    .finally(() => { if (alive) { drawDue(); drawView(); } });

  const moveMonth = (n) => { st.month = new Date(st.month.getFullYear(), st.month.getMonth() + n, 1); drawCalendar(); };
  main.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const act = a.dataset.act, c = contacts.find((x) => x.id === a.dataset.id);
    if (act === "tr-add") openContactEditor(null, { onSaved: (x) => ctx.toast(`${x.name} was added to your tracker.`) });
    else if (act === "tr-edit" && c) openContactEditor(c);
    else if (act === "tr-replied" && c) setStatus(c.id, "replied");
    else if (act === "tr-mode") { st.mode = a.dataset.mode; setPref("sociai.trackerView", st.mode); drawView(); }
    else if (act === "tr-sort") {
      const k = a.dataset.k;
      st.dir = st.sort === k ? -st.dir : k.endsWith("_at") ? -1 : 1; // dates start newest first
      st.sort = k;
      drawRows();
      $(`[data-act='tr-sort'][data-k='${k}']`)?.focus();
    }
    else if (act === "cal-prev") moveMonth(-1);
    else if (act === "cal-next") moveMonth(1);
    else if (act === "cal-today") { const t = new Date(); st.month = new Date(t.getFullYear(), t.getMonth(), 1); st.day = todayISO(); drawCalendar(true); }
    else if (act === "cal-day") {
      st.day = a.dataset.date;
      if (a.classList.contains("is-out")) { const d = parseISO(st.day); st.month = new Date(d.getFullYear(), d.getMonth(), 1); return drawCalendar(true); }
      main.querySelectorAll(".cal-day").forEach((b) => { const on = b === a; b.classList.toggle("is-selected", on); b.tabIndex = on ? 0 : -1; b.setAttribute("aria-selected", on); });
      drawAgenda();
    }
  });
  main.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.act === "tr-status") { t.dataset.status = t.value; setStatus(t.dataset.id, t.value); }
    else if (t.id === "tr-f-status") { st.status = t.value; drawRows(); }
    else if (t.id === "tr-f-role") { st.role = t.value; drawRows(); }
  });
  main.addEventListener("input", (e) => { if (e.target.id === "tr-q") { st.q = e.target.value; drawRows(); } });
  // Arrow keys move between days; Enter or Space opens one (the button default).
  main.addEventListener("keydown", (e) => {
    const day = e.target.closest?.(".cal-day");
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!day || !step) return;
    e.preventDefault();
    st.day = addDays(day.dataset.date, step);
    const d = parseISO(st.day);
    if (d.getMonth() !== st.month.getMonth()) st.month = new Date(d.getFullYear(), d.getMonth(), 1);
    drawCalendar(true);
  });
  return () => { alive = false; listeners.delete(redraw); };
}
