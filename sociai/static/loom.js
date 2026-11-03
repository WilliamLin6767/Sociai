// The loom: a live map of the research as it really happens. The recipient sits at
// the centre; each web search is a diamond on an inner ring, the pages it found are
// dots beyond it, and every page Sociai actually reads gets its own thread back to
// the person. Nothing here is invented: it only draws events the server reported.

const NS = "http://www.w3.org/2000/svg";
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const START = -Math.PI / 2;
const PER_QUERY = 8;

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "")).toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
}

export function domain(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); }
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class Loom {
  constructor(host, { initials = "" } = {}) {
    this.host = host;
    this.queries = [];
    this.pages = [];
    this.byUrl = new Map();
    this.orphans = 0;
    this.svg = el("svg", { class: "loom-svg", role: "img", "aria-label": "Research map" }, host);
    this.gThreads = el("g", {}, this.svg);
    this.gLinks = el("g", {}, this.svg);
    this.gNodes = el("g", {}, this.svg);
    this.gLabels = el("g", {}, this.svg);
    const c = el("g", { class: "l-center" }, this.svg);
    el("circle", { class: "l-halo", r: 30 }, c);
    el("circle", { class: "l-core", r: 26 }, c);
    el("text", { class: "l-initials", "text-anchor": "middle", dy: "0.36em" }, c).textContent = initials;
    this.centerG = c;
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host);
  }

  destroy() { this.ro.disconnect(); }

  // state: running | composing | done | error
  setState(state) {
    for (const s of ["running", "composing", "done", "error"]) this.svg.classList.toggle("is-" + s, s === state);
    this.state = state;
    this.svg.classList.toggle("is-waiting", state === "running" && !this.queries.length && !this.pages.length);
  }

  apply(events, { instant = false } = {}) {
    let delay = 0;
    for (const e of events) delay = this.handle(e, instant, delay);
    this.layout();
    this.setState(this.state || "running");
    this.svg.setAttribute("aria-label", `Research map: ${this.stats().text}`);
  }

  stats() {
    const read = this.pages.filter((p) => p.state === "read").length;
    const q = this.queries.length, f = this.pages.length;
    return { q, f, read, text: `${q} search${q === 1 ? "" : "es"} · ${f} page${f === 1 ? "" : "s"} found · ${read} read` };
  }

  handle(e, instant, delay) {
    if (e.kind === "search") {
      const k = this.queries.length;
      const q = { type: "query", angle: START + k * GOLDEN, r: 0.38 + (k % 3) * 0.05, label: trunc(e.query || "", 30) };
      this.queries.push(q);
      this.addNode(q, null, instant, delay);
    } else if (e.kind === "found") {
      const parent = this.queries[this.queries.length - 1] || null;
      const fresh = (e.results || []).filter((r) => !this.byUrl.has(normUrl(r.url))).slice(0, PER_QUERY);
      const base = parent ? parent.angle : START + this.orphans * GOLDEN;
      fresh.forEach((r, j) => {
        const p = this.addPage(r.url, base + (j - (fresh.length - 1) / 2) * 0.16, 0.78 + (j % 2) * 0.12);
        this.addNode(p, parent, instant, delay + j * 45);
      });
      delay += fresh.length * 45;
    } else if (e.kind === "fetch") {
      let p = this.byUrl.get(normUrl(e.url));
      if (!p) {
        this.orphans += 1;
        p = this.addPage(e.url, START + 0.7 + this.orphans * GOLDEN, 0.7);
        this.addNode(p, null, instant, delay);
      }
      this.mark(p, "reading", instant);
    } else if (e.kind === "read" || e.kind === "read_failed") {
      const p = this.byUrl.get(normUrl(e.url)) || [...this.pages].reverse().find((x) => x.state === "reading");
      if (p) this.mark(p, e.kind === "read" ? "read" : "failed", instant);
    } else if (e.kind === "composing") {
      this.setState("composing");
      this.pages.filter((p) => p.link).forEach((p, i) => {
        p.link.classList.add("is-live");
        p.link.style.transitionDelay = instant ? "0ms" : `${i * 90}ms`;
      });
    }
    return delay;
  }

  addPage(url, angle, r) {
    const p = { type: "page", url, angle, r, state: "found", label: domain(url) };
    this.pages.push(p);
    this.byUrl.set(normUrl(url), p);
    return p;
  }

  addNode(item, parent, instant, delay) {
    item.parent = parent;
    item.thread = el("path", { class: "l-thread" + (item.type === "query" ? " to-query" : ""), pathLength: 1 }, this.gThreads);
    item.node = item.type === "query"
      ? el("path", { class: "l-node query" }, this.gNodes)
      : el("circle", { class: "l-node page", r: 3 }, this.gNodes);
    item.text = el("text", { class: "l-label " + item.type }, this.gLabels);
    item.text.textContent = item.label;
    if (!instant) {
      item.thread.classList.add("draw");
      item.node.classList.add("pop-in");
      item.thread.style.animationDelay = `${delay}ms`;
      item.node.style.animationDelay = `${delay + 160}ms`;
    }
  }

  mark(p, state, instant) {
    p.state = state;
    p.node.classList.remove("is-reading", "is-read", "is-failed");
    p.node.classList.add("is-" + state);
    p.node.setAttribute("r", state === "found" ? 3 : 5.5);
    if (state === "reading" || state === "read") p.text.classList.add("is-shown");
    if (state === "read" && !p.link) {
      // A page that was read gets its own thread back to the person.
      p.link = el("path", { class: "l-link", pathLength: 1 }, this.gLinks);
      if (!instant) p.link.classList.add("draw");
      this.place(p);
    }
    if (state === "failed" && p.link) { p.link.remove(); p.link = null; }
  }

  layout() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.compact = w < 540;
    this.w = w;
    this.svg.classList.toggle("is-compact", this.compact);
    this.cx = w / 2;
    this.cy = h / 2;
    this.rx = w / 2 - (this.compact ? 22 : 96);
    this.ry = h / 2 - 28;
    this.centerG.setAttribute("transform", `translate(${this.cx} ${this.cy})`);
    this.queries.forEach((q) => this.place(q));
    this.pages.forEach((p) => this.place(p));
  }

  pos(item) {
    if (!item) return { x: this.cx, y: this.cy };
    return { x: this.cx + Math.cos(item.angle) * item.r * this.rx, y: this.cy + Math.sin(item.angle) * item.r * this.ry };
  }

  place(item) {
    if (this.cx === undefined) return;
    const at = this.pos(item);
    if (item.type === "query") {
      const { x, y } = at;
      item.node.setAttribute("d", `M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z`);
    } else {
      item.node.setAttribute("cx", at.x);
      item.node.setAttribute("cy", at.y);
    }
    const from = this.pos(item.parent);
    item.thread.setAttribute("d", curve(from, at, item.angle));
    if (item.link) item.link.setAttribute("d", curve({ x: this.cx, y: this.cy }, at, item.angle + 1));
    // On phones, query labels are cut shorter and point away from the centre only when that
    // keeps them inside the map.
    const label = this.compact && item.type === "query" ? trunc(item.label, 18) : item.label;
    if (item.text.textContent !== label) item.text.textContent = label;
    const approx = label.length * 6.5 + 14;
    let right = Math.cos(item.angle) >= 0;
    if (right && at.x + approx > this.w) right = false;
    else if (!right && at.x - approx < 0) right = true;
    item.text.setAttribute("x", at.x + (right ? 11 : -11));
    item.text.setAttribute("y", at.y + 4);
    item.text.setAttribute("text-anchor", right ? "start" : "end");
  }
}

function curve(a, b, seed) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = len * 0.14 * (Math.sin(seed * 7) > 0 ? 1 : -1);
  const mx = (a.x + b.x) / 2 - (dy / len) * bend;
  const my = (a.y + b.y) / 2 + (dx / len) * bend;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
