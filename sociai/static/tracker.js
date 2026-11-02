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
const CAL_MODES = [["month", "Month"], ["week", "Week"], ["agenda", "Agenda"]];
const chevron = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const CHEV_LEFT = chevron("M10 3.5 5.5 8l4.5 4.5"), CHEV_RIGHT = chevron("M6 3.5 10.5 8 6 12.5");
const monthOf = (s) => s.slice(0, 7);
const LONG_DAY = { weekday: "long", month: "long", day: "numeric" };

export function trackerView() {
  const { esc } = ctx;
  const main = document.getElementById("main");
  const st = {
    mode: pref("sociai.trackerView", "table"), cal: pref("sociai.calendarView", "month"),
    sort: "created_at", dir: -1, status: "", role: "", q: "", day: todayISO(), loaded: false, error: "",
  };
  main.innerHTML = `<div class="ruled"><div class="page tracker">
    <div class="row tr-lead"><div class="margin"><p class="label">Outreach</p></div>
      <div class="col tr-title">
        <div><h1 class="h2" data-focus-on-enter>Tracker</h1>
          <p class="field-hint">Who you've written to, and when to follow up. You add people here yourself; nothing reads your inbox or uses credits.</p></div>
        <button type="button" class="btn btn-primary" data-act="tr-add">Add contact</button>
      </div></div>
    <section class="row tr-section" aria-labelledby="tr-due-title">
      <div class="margin"><h2 class="label" id="tr-due-title"><span class="n">01</span>&nbsp; Due soon</h2><p class="margin-note">Follow-ups in the next 7 days, and any overdue.</p></div>
      <div class="col" style="max-width:none"><div class="tr-card tr-due" id="tr-due"></div></div></section>
    <section class="row tr-section" aria-labelledby="tr-contacts-title">
      <div class="margin"><h2 class="label" id="tr-contacts-title"><span class="n">02</span>&nbsp; Contacts</h2><p class="margin-note" id="tr-note"></p></div>
      <div class="col" style="max-width:none">
        <div class="choices tr-switch" role="group" aria-label="Show contacts as">
          <button type="button" class="choice" data-act="tr-mode" data-mode="table"><span class="k" aria-hidden="true"></span>Table</button>
          <button type="button" class="choice" data-act="tr-mode" data-mode="calendar"><span class="k" aria-hidden="true"></span>Calendar</button>
        </div>
        <div id="tr-view"><p class="opening" role="status">Loading your tracker…</p></div>
      </div></section>
  </div></div>`;
  const $ = (s) => main.querySelector(s);

  // ── Due soon ──
  const drawDue = () => {
    const due = contacts.filter((c) => c.due_in !== null).sort((a, b) => a.due_in - b.due_in);
    $("#tr-due").innerHTML = due.length ? `<ul class="tr-due-list">${due.map((c) => `<li class="tr-due-item${c.due_in < 0 ? " is-overdue" : ""}">
        <button type="button" class="tr-due-who" data-act="tr-edit" data-id="${c.id}"><b>${esc(c.name)}</b>${c.organization ? `<span>${esc(c.organization)}</span>` : ""}</button>
        <span class="tr-due-when">${dueText(c.due_in)} · ${fmtDate(c.follow_up_at, { weekday: "short", month: "short", day: "numeric" })}</span>
        <button type="button" class="btn btn-line btn-sm" data-act="tr-replied" data-id="${c.id}">Mark replied</button>
      </li>`).join("")}</ul>`
      : `<p class="tr-quiet">${st.loaded ? "Nothing due in the next 7 days." : "…"}</p>`;
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
  const select = (id, text, all, list, v) => `<label class="vh" for="${id}">${text}</label><select class="input input-sm" id="${id}">
    <option value="">${all}</option>${list.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const drawTable = () => {
    $("#tr-view").innerHTML = `<div class="tr-tools">
        <label class="search"><span class="vh">Search contacts</span>${ctx.icons.search}<input class="input" id="tr-q" type="search" placeholder="Search name, email, organization" value="${esc(st.q)}" autocomplete="off"></label>
        <div class="tr-selects">${select("tr-f-status", "Filter by status", "All statuses", STATUSES, st.status)}${select("tr-f-role", "Filter by role", "All roles", ROLES, st.role)}</div>
      </div><div id="tr-table"></div>`;
    drawRows();
  };
  const drawRows = () => {
    const rows = shown();
    $("#tr-note").textContent = !contacts.length ? "" : rows.length === contacts.length ? `${contacts.length} in your tracker.` : `${rows.length} of ${contacts.length} shown.`;
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

  // ── Calendar: month, week and agenda, all around one selected day (st.day) ──
  const events = () => {
    const by = {};
    const add = (d, kind, c) => d && (by[d] ||= []).push({ kind, c, overdue: kind === "follow" && c.due_in !== null && c.due_in < 0 });
    for (const c of contacts) {
      add(c.sent_at, "sent", c);
      add(c.replied_at, "replied", c);
      if (c.status !== "closed") add(c.follow_up_at, "follow", c);
    }
    return by;
  };
  const kindClass = (e) => `is-${e.overdue ? "overdue" : e.kind}`;
  const pill = (e) => `<button type="button" class="cal-pill ${kindClass(e)}" data-act="tr-edit" data-id="${e.c.id}"
      aria-label="${KIND_LABEL[e.kind]}${e.overdue ? " (overdue)" : ""}: ${esc(e.c.name)}. Edit" title="${KIND_LABEL[e.kind]}: ${esc(e.c.name)}">${esc(e.c.name)}</button>`;
  const dayButton = (d, today, inner, cls = "cal-n") => `<button type="button" class="${cls}" data-act="cal-day" data-date="${d}" tabindex="${d === st.day ? 0 : -1}"
      aria-label="${fmtDate(d, LONG_DAY)}${d === today ? ", today" : ""}" aria-pressed="${d === st.day}">${inner}</button>`;
  const weekOf = (s) => { const d = parseISO(s); return addDays(s, -d.getDay()); }; // the Sunday it falls in
  const dowNames = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));

  const calTitle = () => {
    if (st.cal !== "week") return parseISO(st.day).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const a = parseISO(weekOf(st.day)), b = parseISO(addDays(weekOf(st.day), 6));
    const same = a.getMonth() === b.getMonth();
    return `${a.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${b.toLocaleDateString(undefined, same ? { day: "numeric" } : { month: "short", day: "numeric" })}, ${b.getFullYear()}`;
  };
  const monthHTML = (by, today) => {
    const first = `${monthOf(st.day)}-01`, start = weekOf(first);
    const last = parseISO(first); last.setMonth(last.getMonth() + 1, 0);
    const weeks = Math.ceil((parseISO(first).getDay() + last.getDate()) / 7);
    return `<div class="cal-dows" aria-hidden="true">${dowNames.map((n) => `<span>${n}</span>`).join("")}</div>
      <div class="cal-month" style="--weeks:${weeks}">${Array.from({ length: weeks * 7 }, (_, i) => {
        const d = addDays(start, i), ev = by[d] || [];
        return `<div class="cal-cell${monthOf(d) !== monthOf(st.day) ? " is-out" : ""}${d === today ? " is-today" : ""}${d === st.day ? " is-selected" : ""}" data-date="${d}">
          ${dayButton(d, today, parseISO(d).getDate())}
          <div class="cal-pills">${ev.slice(0, 3).map(pill).join("")}${ev.length > 3 ? `<button type="button" class="cal-more" data-act="cal-day" data-date="${d}" tabindex="-1">+${ev.length - 3} more</button>` : ""}</div>
        </div>`;
      }).join("")}</div>`;
  };
  const weekHTML = (by, today) => `<div class="cal-week">${Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekOf(st.day), i), ev = by[d] || [];
      return `<div class="cal-wday${d === today ? " is-today" : ""}${d === st.day ? " is-selected" : ""}" data-date="${d}">
        ${dayButton(d, today, `<span class="cal-dow">${dowNames[i]}</span><span class="cal-n-big">${parseISO(d).getDate()}</span>`, "cal-whead")}
        <div class="cal-pills">${ev.map(pill).join("") || '<span class="cal-none">No items</span>'}</div></div>`;
    }).join("")}</div>`;
  const itemsHTML = (ev) => `<ul class="cal-items">${ev.map((e) => `<li><button type="button" class="cal-item" data-act="tr-edit" data-id="${e.c.id}">
      <span class="cal-tag ${kindClass(e)}">${KIND_LABEL[e.kind]}${e.overdue ? ", overdue" : ""}</span>
      <span class="cal-item-text"><b>${esc(e.c.name)}</b>${e.c.organization ? `<span class="tr-sub">${esc(e.c.organization)}</span>` : ""}${e.c.subject ? `<span class="tr-sub">${esc(e.c.subject)}</span>` : ""}</span>
    </button></li>`).join("")}</ul>`;
  const agendaHTML = (by, today) => {
    const days = Object.keys(by).filter((d) => monthOf(d) === monthOf(st.day)).sort();
    if (!days.length) return `<p class="empty">Nothing in ${esc(calTitle())}.</p>`;
    return `<ol class="cal-agenda">${days.map((d) => `<li class="cal-aday${d === today ? " is-today" : ""}">
        <span class="cal-adate"><span class="cal-dow">${parseISO(d).toLocaleDateString(undefined, { weekday: "short" })}</span><span class="cal-n-big">${parseISO(d).getDate()}</span></span>
        ${itemsHTML(by[d])}</li>`).join("")}</ol>`;
  };
  const sideHTML = (by) => `<h3 class="label">${fmtDate(st.day, LONG_DAY)}</h3>
    ${by[st.day]?.length ? itemsHTML(by[st.day]) : '<p class="tr-quiet">Nothing on this day.</p>'}`;

  const drawCalendar = (focus = false) => {
    const by = events(), today = todayISO(), unit = st.cal === "week" ? "week" : "month";
    $("#tr-note").textContent = "Sent dates, replies and follow-ups. Click a name to edit it.";
    $("#tr-view").innerHTML = `<div class="cal">
      <div class="cal-bar">
        <button type="button" class="btn btn-line btn-sm" data-act="cal-today">Today</button>
        <span class="cal-arrows"><button type="button" class="icon-btn" data-act="cal-prev" aria-label="Previous ${unit}" title="Previous ${unit}">${CHEV_LEFT}</button><button type="button" class="icon-btn" data-act="cal-next" aria-label="Next ${unit}" title="Next ${unit}">${CHEV_RIGHT}</button></span>
        <h3 class="cal-title" aria-live="polite">${esc(calTitle())}</h3>
        <div class="seg" role="group" aria-label="Calendar view">${CAL_MODES.map(([k, l]) => `<button type="button" data-act="cal-mode" data-mode="${k}" aria-pressed="${st.cal === k}">${l}</button>`).join("")}</div>
      </div>
      <div class="cal-legend"><span><i class="is-sent"></i>Sent</span><span><i class="is-replied"></i>Replied</span><span><i class="is-follow"></i>Follow up</span><span><i class="is-overdue"></i>Overdue</span></div>
      <div class="cal-body is-${st.cal}">
        <div class="cal-main">${st.cal === "agenda" ? agendaHTML(by, today) : st.cal === "week" ? weekHTML(by, today) : monthHTML(by, today)}</div>
        ${st.cal === "agenda" ? "" : `<aside class="tr-card cal-side" aria-live="polite" aria-label="Selected day">${sideHTML(by)}</aside>`}
      </div></div>`;
    if (focus) $(".cal-main [data-act='cal-day'][aria-pressed='true']")?.focus();
  };
  const selectDay = (d) => {
    const moved = st.cal === "week" ? weekOf(d) !== weekOf(st.day) : monthOf(d) !== monthOf(st.day);
    st.day = d;
    if (moved) return drawCalendar(true);
    main.querySelectorAll(".cal-main [data-date]").forEach((el) => {
      const on = el.dataset.date === d;
      if (el.matches(".cal-cell, .cal-wday")) el.classList.toggle("is-selected", on);
      if (el.matches("[data-act='cal-day']:not(.cal-more)")) { el.tabIndex = on ? 0 : -1; el.setAttribute("aria-pressed", on); }
    });
    $(".cal-side").innerHTML = sideHTML(events());
  };
  // Previous / next: a month (month and agenda) or a week. A month step lands on the 1st, or today in this month.
  const step = (n) => {
    if (st.cal === "week") st.day = addDays(st.day, 7 * n);
    else {
      const d = parseISO(`${monthOf(st.day)}-01`); d.setMonth(d.getMonth() + n);
      st.day = monthOf(iso(d)) === monthOf(todayISO()) ? todayISO() : iso(d);
    }
    drawCalendar();
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

  main.addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (!a) {
      const cell = e.target.closest(".cal-cell, .cal-wday"); // a click on a day's empty space selects it
      if (cell) selectDay(cell.dataset.date);
      return;
    }
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
    else if (act === "cal-mode") { st.cal = a.dataset.mode; setPref("sociai.calendarView", st.cal); drawCalendar(); }
    else if (act === "cal-prev") step(-1);
    else if (act === "cal-next") step(1);
    else if (act === "cal-today") { st.day = todayISO(); drawCalendar(true); }
    else if (act === "cal-day") selectDay(a.dataset.date);
  });
  main.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.act === "tr-status") { t.dataset.status = t.value; setStatus(t.dataset.id, t.value); }
    else if (t.id === "tr-f-status") { st.status = t.value; drawRows(); }
    else if (t.id === "tr-f-role") { st.role = t.value; drawRows(); }
  });
  main.addEventListener("input", (e) => { if (e.target.id === "tr-q") { st.q = e.target.value; drawRows(); } });
  // Arrow keys move between days (a week up or down in the month view).
  main.addEventListener("keydown", (e) => {
    const day = e.target.closest?.(".cal-main [data-act='cal-day']:not(.cal-more)");
    const n = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: st.cal === "month" ? -7 : -1, ArrowDown: st.cal === "month" ? 7 : 1 }[e.key];
    if (!day || !n) return;
    e.preventDefault();
    selectDay(addDays(day.dataset.date, n));
    $(".cal-main [data-act='cal-day'][aria-pressed='true']")?.focus();
  });
  return () => { alive = false; listeners.delete(redraw); };
}
