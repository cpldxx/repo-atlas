// Shared helpers: DOM, API, icons, vocabulary.

export const state = {
  route: { view: "home" },
  repo: null,            // overview of the open repository
  model: null,           // local model status from /api/health
  cited: new Set(),      // node ids cited by the latest answer, highlighted on the map
  tab: "info",           // side panel tab: info | ask
  chats: {},             // repo id -> [{q, scope, text, sources, cited, done, error}]
};

export const LV = {
  4: { name: "Areas", hint: "Big parts of the repo", fact: false },
  3: { name: "Components", hint: "Groups of folders", fact: false },
  2: { name: "Modules", hint: "Folders", fact: true },
  1: { name: "Files", hint: "Source files", fact: true },
  0: { name: "Symbols", hint: "Functions · classes", fact: true },
};
export const ROLE = { app: "Main", tests: "Tests", examples: "Examples & docs", tooling: "Tooling", external: "External" };
export const STAGES = [["clone", "Clone"], ["graph", "Extract graph"], ["layers", "Build layers"], ["describe", "Name parts"], ["index", "Index for search"]];

export const num = (n) => Number(n || 0).toLocaleString("en-US");
export const nameOf = (n) => n.title || n.label;

const PATHS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.2-4.2",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  back: "M19 12H5m5-5-5 5 5 5",
  out: "M14 5h5v5m0-5-8 8M10 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4",
  send: "M5 12 20 5l-5 15-3-6z",
  layers: "M12 4 21 9l-9 5-9-5zm-9 9 9 5 9-5",
  close: "M6 6l12 12M18 6 6 18",
  trash: "M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12",
  retry: "M5 12a7 7 0 1 1 2 5m-2 3v-4h4",
  code: "M9 8l-4 4 4 4m6-8 4 4-4 4",
  both: "M7 8h11m-3-3 3 3-3 3M17 16H6m3-3-3 3 3 3",
  gear: "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM10.6 3.5h2.8l.5 2.3 1.6.9 2.2-.8 1.4 2.4-1.7 1.6v1.8l1.7 1.6-1.4 2.4-2.2-.8-1.6.9-.5 2.3h-2.8l-.5-2.3-1.6-.9-2.2.8-1.4-2.4 1.7-1.6v-1.8L4.9 8.3l1.4-2.4 2.2.8 1.6-.9z",
};
export function icon(name, size = 16) {
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
}

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) e.style.setProperty(p, val);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
// replaceChildren that, like h(), accepts nested arrays and skips null/false (the DOM would print them as text).
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
// Break hints after / . _ and at camelCase humps, so long paths and identifiers wrap at a boundary instead of mid-word.
export function soft(text) {
  const out = [];
  String(text ?? "").split(/(?<=[\/._])|(?<=[a-z0-9])(?=[A-Z])/).forEach((part, i) => {
    if (i) out.push(document.createElement("wbr"));
    out.push(part);
  });
  return out;
}
// Position of `el` inside `root` from layout offsets, so it ignores transforms that are mid-animation.
export function boxIn(el, root) {
  let x = 0, y = 0, n = el;
  while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { left: x, top: y, width: el.offsetWidth, height: el.offsetHeight, right: x + el.offsetWidth, bottom: y + el.offsetHeight };
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Escaped text with `code` spans, for model-written summaries.
export const tick = (s) => esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>");

export async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  let r;
  try {
    r = await fetch("/api" + path, init);
  } catch {
    throw new Error("Can't reach the server. Check that the backend is running.");
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(typeof d.detail === "string" ? d.detail : `Request failed (${r.status})`);
  }
  if (opts.raw) return r;
  return r.status === 204 ? null : r.json();
}
export const q = (params) => "?" + new URLSearchParams(params).toString();

export async function* sse(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) if (line.startsWith("data: ")) yield JSON.parse(line.slice(6));
    }
  }
}

export const link = {
  home: () => "#/",
  repo: (rid) => `#/r/${encodeURIComponent(rid)}`,
  settings: () => "#/settings",
  layer: (rid, lv) => `#/r/${encodeURIComponent(rid)}/L/${lv}`,
  node: (rid, id) => `#/r/${encodeURIComponent(rid)}/n/${encodeURIComponent(id)}`,
};
export function parseRoute() {
  const p = location.hash.replace(/^#\/?/, "").split("/");
  if (p[0] === "r" && p[1]) {
    const rid = decodeURIComponent(p[1]);
    if (p[2] === "L" && /^[0-4]$/.test(p[3] || "")) return { view: "layer", rid, level: +p[3] };
    if (p[2] === "n" && p[3]) return { view: "focus", rid, node: decodeURIComponent(p.slice(3).join("/")) };
    return { view: "stack", rid };
  }
  if (p[0] === "settings") return { view: "settings" };
  return { view: "home" };
}

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function skeleton(lines = 3) {
  return h("div", { class: "skel", "aria-hidden": "true" }, Array.from({ length: lines }, (_, i) =>
    h("span", { style: { width: `${[92, 78, 60, 85, 50][i % 5]}%` } })));
}
export function problem(message, retry) {
  return h("div", { class: "problem", role: "alert" }, h("p", {}, message),
    retry && h("button", { class: "btn", type: "button", onclick: retry, html: icon("retry") + "<span>Retry</span>" }));
}

// Curved connector between two boxes inside `box` (all client rects). kind: 'contains' goes down, 'flow' goes across.
export function curve(a, b, o, kind) {
  const f = (v) => v.toFixed(1);
  if (kind === "contains") {
    const x1 = a.left + a.width / 2 - o.left, y1 = a.bottom - o.top, x2 = b.left + b.width / 2 - o.left, y2 = b.top - o.top;
    const m = (y1 + y2) / 2;
    return `M${f(x1)} ${f(y1)} C${f(x1)} ${f(m)} ${f(x2)} ${f(m)} ${f(x2)} ${f(y2 - 1)}`;
  }
  if (a.right < b.left || b.right < a.left) {
    // Side by side. Arrows that run left-to-right ride a little high and bow up; arrows that run back ride low and
    // bow down, so "A calls B" and "B calls A" never sit on top of each other.
    const ltr = a.left <= b.left, off = ltr ? -4 : 4;
    const x1 = (ltr ? a.right : a.left) - o.left, x2 = (ltr ? b.left - 3 : b.right + 3) - o.left;
    const y1 = a.top + a.height / 2 - o.top + off, y2 = b.top + b.height / 2 - o.top + off;
    const level = Math.abs(y1 - y2) < Math.max(a.height, b.height) * 0.6;
    const dx = Math.max(18, Math.abs(x2 - x1) * 0.45) * (ltr ? 1 : -1);
    // An arrow that passes over another column bows clear of the cards in between.
    const span = Math.abs(x2 - x1), skips = span > Math.max(a.width, b.width);
    const bow = level ? (ltr ? -1 : 1) * (skips ? Math.max(a.height, b.height) * 0.7 + 4 : Math.min(28, span * 0.14)) : 0;
    return `M${f(x1)} ${f(y1)} C${f(x1 + dx)} ${f(y1 + bow)} ${f(x2 - dx)} ${f(y2 + bow)} ${f(x2)} ${f(y2)}`;
  }
  const down = a.top < b.top;
  const x1 = a.left + a.width / 2 - o.left, x2 = b.left + b.width / 2 - o.left;
  const y1 = (down ? a.bottom : a.top) - o.top, y2 = (down ? b.top - 3 : b.bottom + 3) - o.top;
  const m = (y1 + y2) / 2;
  return `M${f(x1)} ${f(y1)} C${f(x1)} ${f(m)} ${f(x2)} ${f(m)} ${f(x2)} ${f(y2)}`;
}
