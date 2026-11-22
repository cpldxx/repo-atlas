// The canvases: home, the stack of layers, one layer laid flat, and the mind map.
import { state, LV, ROLE, STAGES, num, nameOf, icon, h, api, q, link, reduced, skeleton, problem, fill, soft, getNode, boxIn } from "./lib.js";
import { mindMap, PAGE } from "./tree.js";

const NS = "http://www.w3.org/2000/svg";
const ARROW = 9;     // arrowhead length on the layer map
let poll = null, pickTimer = null, handoff = null, cleanup = [];

export function leave() {
  clearTimeout(poll);
  poll = null;
  clearTimeout(pickTimer);
  pickTimer = null;
  cleanup.forEach((fn) => fn());
  cleanup = [];
}
export function applyCited(root = document) {
  root.querySelectorAll(".node[data-id], .mm-node[data-id]").forEach((e) => e.classList.toggle("is-cited", state.cited.has(e.dataset.id)));
}
// Re-run on real size changes only: the observer's first callback fires at once, and bursts are folded into one frame.
function onResize(el, fn) {
  let first = true, raf = 0;
  const ro = new ResizeObserver(() => {
    if (first) { first = false; return; }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fn);
  });
  ro.observe(el);
  cleanup.push(() => { ro.disconnect(); cancelAnimationFrame(raf); });
}
const label = (n) => (n.level <= 1 ? soft(nameOf(n)) : nameOf(n));
const layerPath = (rid, lv, limit) => `/repos/${encodeURIComponent(rid)}/layers/${lv}` + q({ limit });
const lvTag = (lv) => h("span", { class: "lv", style: { "--tint": `var(--l${lv})` } }, `L${lv}`);

// ---------------------------------------------------------------- home
export async function home(view) {
  const list = h("ul", { class: "repos" }, h("li", {}, skeleton(3)));
  const msg = h("p", { class: "form-msg", role: "status" });
  const input = h("input", { id: "url", name: "url", type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false",
    placeholder: "https://github.com/pallets/flask", required: true, "aria-describedby": "url-help" });
  const submit = h("button", { class: "btn primary", type: "submit" }, "Read repo");
  const form = h("form", { class: "add", onsubmit: async (e) => {
    e.preventDefault();
    msg.className = "form-msg";
    msg.textContent = "";
    const url = input.value.trim();
    if (!/^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+/.test(url) && !/^[\w.-]+\/[\w.-]+$/.test(url)) {
      msg.textContent = "That's not a GitHub repository URL. Use https://github.com/owner/repo.";
      msg.classList.add("is-error");
      input.focus();
      return;
    }
    submit.disabled = true;
    try {
      await api("/repos", { method: "POST", body: { url } });
      input.value = "";
      msg.textContent = "Reading started. Follow its progress in the list below.";
      await refresh();
    } catch (err) {
      msg.textContent = err.message === "not a GitHub repository URL"
        ? "That's not a GitHub repository URL. Use https://github.com/owner/repo." : err.message;
      msg.classList.add("is-error");
    } finally {
      submit.disabled = false;
    }
  } },
    h("label", { for: "url" }, "GitHub URL"),
    h("div", { class: "add-row" }, input, submit),
    h("p", { class: "help", id: "url-help" }, "Reads the default branch of a public repository. The code stays on this computer."),
    msg);

  fill(view, h("div", { class: "home" },
    h("h1", {}, "Read a GitHub repo, layer by layer"),
    h("p", { class: "lead" }, "Paste a URL. It's read once and kept, then shown as five layers, from the big picture down to single functions."),
    form,
    h("section", { class: "home-list", "aria-labelledby": "h-repos" }, h("h2", { id: "h-repos" }, "Your repositories"), list)));

  async function refresh() {
    clearTimeout(poll);
    let repos;
    try {
      repos = await api("/repos");
    } catch (err) {
      fill(list, h("li", {}, problem(err.message, refresh)));
      return;
    }
    if (state.route.view !== "home") return;
    if (!repos.length) {
      fill(list, h("li", { class: "empty" },
        h("p", {}, "No repositories yet. Paste a URL above and you'll get these five layers."),
        h("ol", { class: "strata" }, [4, 3, 2, 1, 0].map((lv) => h("li", {}, lvTag(lv), ` ${LV[lv].name}`, h("span", { class: "st-hint" }, LV[lv].hint))))));
      return;
    }
    fill(list, repos.map((r) => repoRow(r, refresh)));
    if (repos.some((r) => r.status === "working")) poll = setTimeout(refresh, 1500);
  }
  await refresh();
}

function repoRow(r, refresh) {
  const lv = r.stats && r.stats.levels;
  const ready = r.status === "ready" && lv;
  const name = `${r.owner}/${r.name}`;
  const li = h("li", { class: `repo is-${r.status}` });
  const acts = h("div", { class: "repo-acts" });
  const del = h("button", { class: "btn quiet", type: "button", "aria-label": `Delete ${name}`, html: icon("trash") + "<span>Delete</span>",
    onclick: () => {
      fill(acts, h("span", { class: "confirm" }, "Delete this saved map?"),
        h("button", { class: "btn danger", type: "button", onclick: async () => { await api(`/repos/${encodeURIComponent(r.id)}`, { method: "DELETE" }).catch(() => {}); refresh(); } }, "Delete"),
        h("button", { class: "btn", type: "button", onclick: refresh }, "Cancel"));
      acts.querySelector(".btn.danger").focus();
    } });
  if (ready) {
    li.append(
      h("a", { class: "repo-main", href: link.repo(r.id) },
        h("span", { class: "repo-name" }, soft(name)),
        h("ol", { class: "strata", "aria-label": "Count per layer" }, [4, 3, 2, 1, 0].map((n) => h("li", {},
          lvTag(n), ` ${LV[n].name} `, h("b", {}, num(lv[n])))))),
      acts);
    acts.append(h("a", { class: "btn", href: link.repo(r.id), tabindex: "-1", "aria-hidden": "true", html: "<span>Open</span>" + icon("arrow") }), del);
  } else if (r.status === "error") {
    li.append(h("div", { class: "repo-main" }, h("span", { class: "repo-name" }, soft(name)),
      h("p", { class: "repo-err" }, "Couldn't read it: ", r.error && r.error.includes("not found") ? "Repository not found. Check the URL and that it's public." : (r.error || "unknown problem"))), acts);
    acts.append(h("button", { class: "btn", type: "button", html: icon("retry") + "<span>Retry</span>",
      onclick: async () => { await api("/repos", { method: "POST", body: { url: r.url, refresh: true } }).catch(() => {}); refresh(); } }), del);
  } else {
    const at = STAGES.findIndex((s) => s[0] === r.stage);
    li.append(h("div", { class: "repo-main" }, h("span", { class: "repo-name" }, soft(name)),
      h("ol", { class: "stages", "aria-label": "Reading" }, STAGES.map(([, text], i) =>
        h("li", { class: i < at ? "is-done" : i === at ? "is-now" : "", "aria-current": i === at ? "step" : null }, text)))));
  }
  return li;
}

// ---------------------------------------------------------------- the stack
// A slab's top shows its layer as dots, one per item, larger for the more connected ones.
function mini(layer) {
  const W = 440, H = 280, pad = 36;
  let nodes = layer.level >= 3 ? layer.nodes : layer.nodes.filter((n) => n.role === "app");
  if (!nodes.length) nodes = layer.nodes;
  const ranks = [...new Set(nodes.map((n) => n.rank))].sort((a, b) => a - b);
  const cols = new Map();
  nodes.forEach((n) => { const c = ranks.indexOf(n.rank); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(n); });
  const max = Math.max(1, ...nodes.map((n) => n.deg_in + n.deg_out));
  let dots = "";
  for (const [c, arr] of cols) arr.forEach((n, i) => {
    const x = (ranks.length === 1 ? W / 2 : pad + (W - 2 * pad) * (c / (ranks.length - 1))) + (arr.length > 7 ? ((i % 3) - 1) * 11 : 0);
    const y = pad + (H - 2 * pad) * ((i + 0.5) / arr.length);
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(3 + 7 * Math.sqrt((n.deg_in + n.deg_out) / max)).toFixed(1)}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="mini-dots">${dots}</g></svg>`;
}

export async function stack(view, rid) {
  const repo = state.repo.repo;
  const root = h("div", { class: "stack-view" }, skeleton(5));
  fill(view, root);
  let layers;
  try {
    layers = await Promise.all([4, 3, 2, 1, 0].map((lv) => api(layerPath(rid, lv, 70))));
  } catch (err) {
    fill(root, problem(err.message, () => stack(view, rid)));
    return;
  }
  if (state.route.view !== "stack" || state.route.rid !== rid) return;
  const tilt = h("div", { class: "stack-tilt" });
  const scene = h("div", { class: "stack-scene" }, tilt);
  const legend = h("ol", { class: "stack-legend" });
  const side = h("div", { class: "stack-side" }, legend,
    h("p", { class: "stack-note" }, "L0 to L2 come straight from the code. L3 and L4 are grouped from the folders and named by your model."));
  const wrap = h("div", { class: "stack-wrap" }, scene, side);
  const slabs = {};
  const each = (fn) => Object.entries(slabs).forEach(([n, el]) => fn(el, +n));

  // Picking a layer: the block's top face turns to face you, then the flat view grows out of the rectangle it ended on.
  function pick(lv, e) {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return;
    if (e) e.preventDefault();
    if (wrap.classList.contains("is-picking")) return;
    if (reduced() || (e && e.detail === 0)) { location.hash = link.layer(rid, lv); return; }
    const data = api(layerPath(rid, lv, 90)).catch(() => null);
    wrap.classList.add("is-picking");
    each((el, n) => {
      el.classList.add(n === lv ? "is-picked" : n > lv ? "is-above" : "is-below");
      el.style.setProperty("--lift", n > lv ? "70px" : "0px");
    });
    const due = new Promise((done) => { pickTimer = setTimeout(done, 260); });
    Promise.all([data, due]).then(() => {
      if (!pickTimer || !wrap.isConnected) return;
      handoff = { rid, level: lv, data, rect: slabs[lv].querySelector(".slab-top").getBoundingClientRect() };
      location.hash = link.layer(rid, lv);
    });
  }
  // Pointing at a block lifts everything above it, uncovering that block's top face.
  const hot = (lv, on) => {
    if (wrap.classList.contains("is-picking")) return;
    each((el, n) => {
      el.classList.toggle("is-hot", on && n === lv);
      el.style.setProperty("--lift", on && n > lv ? "44px" : "0px");
      el.style.setProperty("--drop", on && n === lv + 1 ? "44px" : "0px");
    });
    legend.querySelector(`[data-level="${lv}"]`).classList.toggle("is-hot", on);
  };

  layers.forEach((layer) => {
    const lv = layer.level;
    slabs[lv] = h("div", { class: "slab", "aria-hidden": "true", dataset: { level: lv }, style: { "--z": lv, "--tint": `var(--l${lv})` },
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey) { window.open(link.layer(rid, lv), "_blank"); return; }
        pick(lv, e);
      }, onmouseenter: () => hot(lv, true), onmouseleave: () => hot(lv, false) },
      h("div", { class: "slab-cast" }),
      Array.from({ length: 12 }, (_, i) => h("div", { class: "slab-layer", style: { "--i": i } })),
      h("div", { class: "slab-top", html: mini(layer) }),
      h("div", { class: "slab-side s-front" }, h("span", { class: "slab-name" }, `L${lv}`)),
      h("div", { class: "slab-side s-left" }));
    tilt.append(slabs[lv]);
    legend.append(h("li", {}, h("a", { class: "legend-row", href: link.layer(rid, lv), dataset: { level: lv },
      onclick: (e) => pick(lv, e), onmouseenter: () => hot(lv, true), onmouseleave: () => hot(lv, false),
      onfocus: () => hot(lv, true), onblur: () => hot(lv, false) },
      lvTag(lv),
      h("span", { class: "lg-name" }, LV[lv].name, h("span", { class: "lg-hint" }, LV[lv].hint)),
      h("span", { class: "lg-count" }, num(layer.total), h("span", { class: "sr" }, " items")),
      h("span", { class: "lg-go", html: icon("chev") }))));
  });

  fill(root,
    h("header", { class: "view-head with-actions" },
      h("div", {},
        h("h1", {}, soft(`${repo.owner}/${repo.name}`)),
        h("p", { class: "view-sub" }, "Pick a layer to open it flat. Higher layers show the big picture, lower ones the actual code.")),
      h("div", { class: "head-actions" },
        h("a", { class: "btn primary", href: link.map(rid), html: icon("tree") + "<span>Open mind map</span>" }),
        h("a", { class: "btn", href: `${repo.url}/tree/${repo.commit_sha}`, target: "_blank", rel: "noopener", html: `<span>GitHub</span>${icon("out", 14)}` }))),
    wrap);

  // The tower builds itself once: blocks drop into place from the bottom up.
  if (!reduced()) {
    const pitch = parseFloat(getComputedStyle(slabs[0]).getPropertyValue("--pitch")) || 72;
    each((el, n) => {
      const opts = { duration: 420, delay: 60 + n * 70, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" };
      el.animate([{ transform: `translateZ(${n * pitch + 120}px)` }, { transform: `translateZ(${n * pitch}px)` }], opts);
      [...el.children].forEach((face) => face.animate([{ opacity: 0 }, { opacity: 1 }], { ...opts, duration: 180 }));
    });
  }
}

// ---------------------------------------------------------------- one layer, flat
// Cards stand in columns, callers on the left and what they call on the right. No lines: pointing at a card colours
// what calls it and what it calls. The most connected cards are marked as the place to start.
export async function layer(view, rid, level) {
  const PAGE_L = 90;
  let limit = PAGE_L, data = null, active = null, firstDraw = true;
  const pass = handoff && handoff.rid === rid && handoff.level === level ? handoff : null;
  handoff = null;

  const sub = h("p", { class: "view-sub" });
  const tools = h("div", { class: "layer-tools" });
  const start = h("div", { class: "layer-start" });
  const scroll = h("div", { class: "layer-scroll", tabindex: "0", role: "region", "aria-label": `L${level} ${LV[level].name} map` });
  const more = h("button", { class: "btn", type: "button", hidden: true, onclick: async () => {
    if (more.getAttribute("aria-disabled") === "true") return;
    more.setAttribute("aria-disabled", "true");
    limit = Math.min(2000, limit + PAGE_L * 2);
    await load();
    more.removeAttribute("aria-disabled");
    if (more.hidden) scroll.focus();
  } });
  const moreBox = h("div", { class: "layer-more" }, more);
  const edge = () => scroll.classList.toggle("more-x", scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 4);
  scroll.addEventListener("scroll", edge, { passive: true });
  const head = h("header", { class: "view-head" },
    h("a", { class: "btn quiet back", href: link.repo(rid), html: icon("back") + "<span>All five layers</span>" }),
    h("h1", {}, lvTag(level), " ", LV[level].name), sub);
  const root = h("div", { class: "layer-view", style: { "--tint": `var(--l${level})` } }, head, start, tools, scroll, moreBox);
  if (!pass) fill(scroll, skeleton(6));
  fill(view, root);

  async function load() {
    const before = data && new Set(data.nodes.map((n) => n.id));
    try {
      const handed = !data && pass ? await pass.data : null;
      data = handed || await api(layerPath(rid, level, limit));
    } catch (err) {
      fill(scroll, problem(err.message, load));
      return;
    }
    if (state.route.view !== "layer" || state.route.level !== level) return;
    const present = Object.keys(ROLE).filter((r) => data.nodes.some((n) => n.role === r));
    if (!active) active = new Set(present.includes("app") ? present.filter((r) => r === "app" || r === "external") : present);
    if (before) {
      const fresh = data.nodes.filter((n) => !before.has(n.id));
      if (fresh.length && !fresh.some((n) => active.has(n.role))) fresh.forEach((n) => active.add(n.role));
    }
    fill(tools, present.length > 1 ? h("div", { class: "seg", role: "group", "aria-label": "Show" },
      present.map((r) => h("button", { class: "seg-b", type: "button", "aria-pressed": String(active.has(r)), onclick: (e) => {
        if (active.has(r) && active.size > 1) active.delete(r); else active.add(r);
        e.currentTarget.setAttribute("aria-pressed", String(active.has(r)));
        draw();
      } }, ROLE[r], h("span", { class: "seg-n" }, num(data.nodes.filter((n) => n.role === r).length))))) : null);
    more.hidden = data.total <= data.nodes.length;
    more.textContent = `Load ${num(Math.min(PAGE_L * 2, data.total - data.nodes.length))} more`;
    draw();
  }

  function draw() {
    const at = [scroll.scrollLeft, scroll.scrollTop];
    const shown = data.nodes.filter((n) => active.has(n.role));
    const ranks = [...new Set(shown.map((n) => n.rank))].sort((a, b) => a - b);
    const map = h("div", { class: "layer-map" + (level <= 1 ? " is-code" : "") });
    // the lines of one card at a time: over the cards that stepped back, under the ones they connect
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "wires");
    svg.setAttribute("aria-hidden", "true");
    // filled arrowheads whose tip is the very end of the line (refX = tip), sized in pixels, not by line width
    // The line stops where the arrowhead's base is and the head reaches the card, so no line pokes past its tip.
    const head = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="0" refY="5" markerUnits="userSpaceOnUse" markerWidth="${ARROW}" markerHeight="${ARROW}" orient="auto"><path d="M0 1 10 5 0 9z" fill="${color}"/></marker>`;
    svg.innerHTML = `<defs>${head("arw-in", "#557A4A")}${head("arw-out", "#D97A45")}</defs>`;
    const lines = document.createElementNS(NS, "g");
    svg.append(lines);
    map.append(svg);
    // where to start: hand-written code that calls the most other parts here, which is where reading naturally begins
    const ids = new Set(shown.map((n) => n.id));
    const links = data.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    const outs = new Map(), ins = new Map();
    links.forEach((l) => { outs.set(l.source, (outs.get(l.source) || 0) + 1); ins.set(l.target, (ins.get(l.target) || 0) + 1); });
    const generated = /\.gen\.|generated|_pb2|\.d\.ts$|routeTree/i;
    const best = shown.length > 5 ? [...shown].filter((n) => n.role === "app" && outs.get(n.id) && !generated.test(n.path || n.label))
      .sort((a, b) => (outs.get(b.id) - outs.get(a.id)) || ((ins.get(b.id) || 0) - (ins.get(a.id) || 0)) || a.rank - b.rank).slice(0, 3) : [];
    const starred = new Set(best.map((n) => n.id));
    fill(start, best.length ? [h("span", { class: "layer-start-k" }, "Not sure where to begin? Start here:"),
      best.map((n) => h("a", { class: "start-chip" + (level <= 1 ? " mono" : ""), href: link.node(rid, n.id) }, label(n)))] : null);

    const under = (n) => level === 2 ? n.path : level === 1 ? (n.path || "").split("/").slice(0, -1).join("/") : level === 0 ? (n.path || "").split("/").pop() : "";
    ranks.forEach((r) => {
      const col = shown.filter((n) => n.rank === r).sort((a, b) =>
        (starred.has(b.id) - starred.has(a.id)) || String(a.parent).localeCompare(String(b.parent)) || (b.deg_in + b.deg_out) - (a.deg_in + a.deg_out));
      map.append(h("ul", { class: "layer-col" }, col.map((n) => h("li", {},
        h("a", { class: "node" + (n.role !== "app" ? " is-side" : "") + (starred.has(n.id) ? " is-start" : ""), href: link.node(rid, n.id), dataset: { id: n.id },
          title: [n.path, n.role !== "app" ? ROLE[n.role] : ""].filter(Boolean).join(" · ") || n.label },
          starred.has(n.id) ? h("span", { class: "node-flag" }, "Start here") : null,
          h("span", { class: "node-t" + (level <= 1 ? " mono" : "") }, label(n)),
          under(n) ? h("span", { class: "node-s" }, soft(under(n))) : null,
          h("span", { class: "node-rel", "aria-hidden": "true" }))))));
    });
    fill(scroll, map);
    scroll.scrollLeft = at[0];
    scroll.scrollTop = at[1];
    fill(sub, `${LV[level].hint} · ${num(shown.length)} of ${num(data.total)} · callers on the left, what they call on the right. Point at a card to see what it's connected to; click it for its mind map.`);
    edge();
    onResize(map, () => { edge(); redraw(); });   // cards may have moved or changed height: lines are measured again

    const callers = new Map(), callees = new Map();
    links.forEach((l) => {
      if (!callees.has(l.source)) callees.set(l.source, new Set());
      if (!callers.has(l.target)) callers.set(l.target, new Set());
      callees.get(l.source).add(l.target);
      callers.get(l.target).add(l.source);
    });
    const els = Object.fromEntries([...map.querySelectorAll(".node")].map((e) => [e.dataset.id, e]));
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    // the side panel lists the pointed-at card's connections by name, so nothing has to be scrolled into view
    const peek = (id) => {
      const box = document.getElementById("layer-peek"), n = byId.get(id);
      if (!box || !n) return;
      const rows = (title, set) => {
        const list = [...(set || [])].map((k) => byId.get(k)).filter(Boolean);
        return list.length ? [h("h3", {}, title, " ", h("span", { class: "count" }, num(list.length))),
          h("ul", { class: "rows" }, list.map((m) => h("li", {}, h("a", { class: "row-link", href: link.node(rid, m.id) },
            h("span", { class: "row-t" + (level <= 1 ? " mono" : "") }, label(m)), h("span", { class: "row-s" }, (m.path || "").split("/").slice(-2, -1)[0] || "")))))] : [];
      };
      fill(box, h("p", { class: "peek-name" }, h("span", { class: level <= 1 ? "mono" : "" }, label(n))),
        rows("Called by", callers.get(id)), rows("Calls", callees.get(id)),
        !callers.get(id) && !callees.get(id) ? h("p", { class: "pane-note" }, "Nothing on this layer calls it or is called by it.") : null);
    };
    let off = 0;
    // lines grow out of the pointed-at card: in from what calls it (sage), out to what it calls (apricot).
    // Each line gets its own spot on the card's edge, at the height of the card it leads to, so arrows never pile up.
    // each column's x and the vertical spans its cards take up, for finding the gaps between cards
    // (measured each time lines are drawn, so a resized window never leaves them routed around old positions)
    const measure = () => [...map.querySelectorAll(".layer-col")].map((ul) => {
      const cards = [...ul.querySelectorAll(".node")].map((e) => boxIn(e, map));
      return { x: cards.length ? cards[0].left : 0, spans: cards.map((b) => [b.top - 5, b.bottom + 5]) };
    });
    let lanes = [], cols = [];
    // the height nearest to y where a line passes every given column without touching a card (or another lane)
    const freeLane = (between, y) => {
      const ok = (v) => between.every((c) => c.spans.every(([t, b]) => v <= t || v >= b)) && lanes.every((u) => Math.abs(u - v) >= 6);
      for (let step = 0; step < 600; step++) {
        for (const v of step ? [y - step * 2, y + step * 2] : [y]) if (v > 2 && ok(v)) { lanes.push(v); return v; }
      }
      return y;
    };
    // A line from one card's edge to another's: a short straight start, a bend in the gap beside the first card,
    // (for cards further away) a straight run on a free lane and a second bend in the gap before the last card,
    // then a straight approach, so the arrowhead always sits on a straight piece of line, its tip on the card.
    const GAP = parseFloat(getComputedStyle(map).columnGap) || 48, STUB = 5, LEAD = 7;
    const f = (n) => n.toFixed(1);
    const bendTo = (x0, y0, x1, y1) => { const k = (x1 - x0) * 0.55; return ` C${f(x0 + k)} ${f(y0)} ${f(x1 - k)} ${f(y1)} ${f(x1)} ${f(y1)}`; };
    const route = (sx, sy, ex, ey, lane, far) => {
      const s = ex > sx ? 1 : -1, end = ex - s * ARROW, approach = end - s * LEAD, start = sx + s * STUB;
      let d = `M${f(sx)} ${f(sy)} L${f(start)} ${f(sy)}`;
      if (far) {
        // every line bends over the same stretch of each gap, so lines keep their order through it
        const out = sx + s * (GAP - ARROW - LEAD), into = ex - s * (GAP - STUB);
        d += bendTo(start, sy, out, lane) + ` L${f(into)} ${f(lane)}` + bendTo(into, lane, approach, ey);
      } else {
        d += bendTo(start, sy, approach, ey);
      }
      return d + ` L${f(end)} ${f(ey)}`;
    };
    // two cards in one column: out from the column's edge and back in, ending straight into the arrowhead
    const bracket = (x, sy, ey, sign) => {
      const end = x + sign * ARROW, approach = end + sign * LEAD, start = x + sign * STUB;
      const bx = x + sign * (ARROW + LEAD + 10 + Math.min(30, Math.abs(ey - sy) * 0.08));
      return `M${f(x)} ${f(sy)} L${f(start)} ${f(sy)} C${f(bx)} ${f(sy)} ${f(bx)} ${f(ey)} ${f(approach)} ${f(ey)} L${f(end)} ${f(ey)}`;
    };
    let drawn = null;
    const drawLines = (id) => {
      if (drawn === id) return;
      drawn = id;
      lines.replaceChildren();
      lanes = [];
      if (!id || !els[id]) return;
      cols = measure();
      const me = boxIn(els[id], map), inSet = callers.get(id) || new Set();
      const items = [];
      inSet.forEach((k) => { if (els[k]) items.push({ k, kind: "in" }); });
      (callees.get(id) || []).forEach((k) => { if (els[k] && !inSet.has(k)) items.push({ k, kind: "out" }); });
      items.forEach((it) => {
        it.o = boxIn(els[it.k], map);
        it.side = it.o.left >= me.right - 1 ? "right" : it.o.right <= me.left + 1 ? "left" : "column";
      });
      // Which edge of my card each line uses: its own side for cards to the left or right; links within my column
      // take whichever edge has fewer lines, so they don't tangle with the lines heading across.
      const across = { left: items.filter((it) => it.side === "left").length, right: items.filter((it) => it.side === "right").length };
      const bracketEdge = across.left < across.right ? "left" : "right";
      items.forEach((it) => {
        it.edge = it.side === "column" ? bracketEdge : it.side;
        it.oy = it.o.top + it.o.height / 2;
        if (it.side === "column") return;
        it.px = it.edge === "right" ? me.right : me.left;
        it.qx = it.edge === "right" ? it.o.left : it.o.right;
        it.sgn = it.qx > it.px ? 1 : -1;
        it.between = cols.filter((c) => it.sgn > 0 ? c.x > it.px + 1 && c.x < it.qx - 1 : c.x < it.px - 1 && c.x > it.qx + 1);
      });
      // A line that crosses other columns travels through the gaps between their cards, on the free height nearest
      // its card. Nearer cards pick first, so they keep the inner lanes and the lines to farther cards go around them.
      items.filter((it) => it.between && it.between.length).sort((x, y) => Math.abs(x.qx - x.px) - Math.abs(y.qx - y.px))
        .forEach((it) => { it.lane = freeLane(it.between, it.oy); });
      items.forEach((it) => { it.first = it.lane ?? it.oy; });
      // Each line leaves at the height it travels at (top of my card for lines going up, bottom for lines going
      // down, level for lines going straight), in that order, with a little room between lines.
      for (const edge of ["left", "right"]) {
        const at = items.filter((it) => it.edge === edge).sort((x, y) => x.first - y.first || x.oy - y.oy);
        const lo = me.top + 9, hi = me.bottom - 9, n = at.length;
        const gap = n > 1 ? Math.min(12, (hi - lo) / (n - 1)) : 0;
        at.forEach((it, i) => {
          it.py = Math.min(hi, Math.max(lo, it.first));
          if (i) it.py = Math.max(it.py, at[i - 1].py + gap);
        });
        for (let i = n - 1; i >= 0; i--) at[i].py = Math.min(at[i].py, i === n - 1 ? hi : at[i + 1].py - gap);
      }
      items.forEach((it) => {
        const o = it.o, oy = it.oy;
        let d;
        if (it.side === "column") {
          const sign = it.edge === "right" ? 1 : -1, x = it.edge === "right" ? me.right : me.left;
          d = it.kind === "out" ? bracket(x, it.py, oy, sign) : bracket(x, oy, it.py, sign);
        } else {
          // metro-map style: lines leave in the order of the heights they travel, so they don't cross
          const far = it.between.length > 0, lane = it.first;
          d = it.kind === "out" ? route(it.px, it.py, it.qx, oy, lane, far) : route(it.qx, oy, it.px, it.py, lane, far);
        }
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", d);
        p.setAttribute("class", it.kind === "in" ? "w-in" : "w-out");
        p.setAttribute("marker-end", `url(#arw-${it.kind})`);
        lines.append(p);
        if (reduced()) return;
        // the line draws itself from the caller's end toward the arrowhead
        const len = p.getTotalLength();
        p.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }],
          { duration: 240, easing: "cubic-bezier(.23,1,.32,1)" });
      });
    };
    const redraw = () => { const id = drawn; drawn = null; drawLines(id); };
    const light = (id) => {
      if (id) peek(id);
      map.classList.toggle("has-hot", !!id);
      const ins = (id && callers.get(id)) || new Set(), outs = (id && callees.get(id)) || new Set();
      Object.values(els).forEach((e) => {
        const k = e.dataset.id, isIn = ins.has(k), isOut = outs.has(k);
        e.classList.toggle("is-hot", k === id);
        e.classList.toggle("is-caller", isIn && !isOut);
        e.classList.toggle("is-callee", isOut && !isIn);
        e.classList.toggle("is-both", isIn && isOut);
        e.querySelector(".node-rel").textContent = isIn && isOut ? "Both ways" : isIn ? "Calls it" : isOut ? "Called by it" : "";
      });
      drawLines(id);
    };
    Object.values(els).forEach((e) => {
      const on = () => { clearTimeout(off); light(e.dataset.id); };
      const out = () => { clearTimeout(off); off = setTimeout(() => light(null), 90); };
      e.addEventListener("mouseenter", on);
      e.addEventListener("focus", on);
      e.addEventListener("mouseleave", out);
      e.addEventListener("blur", out);
    });
    cleanup.push(() => clearTimeout(off));
    applyCited(root);

    if (firstDraw) {
      firstDraw = false;
      if (pass && !reduced()) {
        const to = scroll.getBoundingClientRect(), from = pass.rect;
        scroll.animate([
          { transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
          { transformOrigin: "0 0", transform: "none" }], { duration: 280, easing: "cubic-bezier(.23,1,.32,1)" });
        map.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 90, easing: "ease-out", fill: "backwards" });
        [head, start, tools, moreBox].forEach((e) => e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 60, easing: "ease-out", fill: "backwards" }));
      } else {
        scroll.classList.add("is-direct");
      }
    }
  }
  await load();
}

// ---------------------------------------------------------------- the mind map
// Centred on one item (what is inside it, what it calls, what calls it), or with no item, on the whole repository.
export async function focus(view, rid, nodeId) {
  const repo = state.repo.repo;
  const enc = encodeURIComponent;
  const branch = (rel) => api(`/repos/${enc(rid)}/branch` + q({ rel, node: nodeId || "", limit: PAGE }));
  if (!view.querySelector(".focus-view")) fill(view, h("div", { class: "focus-view" }, skeleton(5)));
  else view.querySelector(".mm-scroll")?.classList.add("is-loading");
  let d = null, branches;
  try {
    if (nodeId) {
      const [node, inside, calls, callers] = await Promise.all([getNode(rid, nodeId), branch("inside"), branch("calls"), branch("callers")]);
      d = node;
      branches = [inside, calls, callers];
    } else {
      branches = [await branch("inside")];
    }
  } catch (err) {
    const missing = err.message === "node not found";
    fill(view, h("div", { class: "focus-view" },
      h("header", { class: "view-head" }, h("h1", {}, missing ? "Item not found" : "Couldn't load the map")),
      problem(missing ? "It may have been renamed when the repository was re-read, or the link is wrong." : err.message, missing ? null : () => focus(view, rid, nodeId)),
      h("p", { class: "after-problem" }, h("a", { class: "btn", href: link.repo(rid) }, "All five layers"))));
    return null;
  }
  const here = state.route;
  if (here.rid !== rid || (nodeId ? here.view !== "focus" || here.node !== nodeId : here.view !== "map")) return null;

  const name = d ? nameOf(d) : `${repo.owner}/${repo.name}`;
  const code = d && d.level <= 1;
  // a part that only repeats its parent's name adds nothing to the path
  const crumbs = d && d.breadcrumbs ? d.breadcrumbs.filter((b, i, all) => !i || b.label.toLowerCase() !== all[i - 1].label.toLowerCase()) : [];
  const path = crumbs.length
    ? h("nav", { class: "mm-path", "aria-label": "Part of" }, h("span", { class: "mm-path-k" }, "Part of"),
      h("ol", {}, crumbs.map((b) => h("li", {}, lvTag(b.level), h("a", { href: link.node(rid, b.id) }, b.label)))))
    : null;
  const scroll = h("div", { class: "mm-scroll" });
  const empty = d && !branches.some((b) => b.total)
    ? h("p", { class: "mm-empty" }, "Nothing is inside it, and nothing calls it or is called by it.") : null;
  const root = h("div", { class: "focus-view" },
    h("header", { class: "view-head" },
      h("a", { class: "btn quiet back", href: d ? link.layer(rid, d.level) : link.repo(rid),
        html: icon("back") + `<span>${d ? `L${d.level} ${LV[d.level].name}` : "All five layers"}</span>` }),
      h("h1", { class: code ? "mono" : "" }, code ? soft(name) : name),
      path,
      h("p", { class: "view-sub" }, d ? "Click anything to grow its branch. Its details show on the right."
        : "The whole repository, from its big parts down to single functions. Click anything to grow its branch."),
      h("button", { class: "btn to-panel", type: "button",
        onclick: () => document.getElementById("panel").scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }) }, d ? "Details · code · ask" : "Guide · ask")),
    empty, scroll);
  fill(view, root);
  const map = mindMap(scroll, {
    rid, flat: !d,
    root: { node: d ? { id: d.id, level: d.level } : null, label: name, sub: d ? `L${d.level} ${LV[d.level].name}` : "Repository" },
    branches,
    onSelect: (item) => {
      state.sel = item ? item.id : null;
      state.selName = item ? nameOf(item) : null;
      document.dispatchEvent(new Event("atlas:select"));
    },
  });
  cleanup.push(() => map.stop());
  if (!reduced()) scroll.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  applyCited(root);
  return d || { id: null, level: null, label: name };
}
