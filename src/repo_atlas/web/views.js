// The four canvases: home, the 3D stack of layers, one layer laid flat, and the mind map around one node.
import { state, LV, ROLE, STAGES, num, nameOf, icon, h, api, q, link, reduced, skeleton, problem, curve, fill, soft, boxIn } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
const ZERO = { left: 0, top: 0 };
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
  root.querySelectorAll(".node[data-id], .chip[data-id]").forEach((e) => e.classList.toggle("is-cited", state.cited.has(e.dataset.id)));
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
function drawWires(svg, markerId, links, dress) {
  svg.innerHTML = `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5 8 5 1.5 8.5" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`;
  return links.map((l) => {
    const p = document.createElementNS(NS, "path");
    dress(p, l);
    svg.append(p);
    return { l, p };
  });
}
function wireSvg() {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "wires");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}
const label = (n) => (n.level <= 1 ? soft(nameOf(n)) : nameOf(n));
const layerPath = (rid, lv, limit) => `/repos/${encodeURIComponent(rid)}/layers/${lv}` + q({ limit });

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
    h("p", { class: "help", id: "url-help" }, "Reads the default branch of a public repository. Your code never leaves this computer."),
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
        h("ol", { class: "strata" }, [4, 3, 2, 1, 0].map((lv) => h("li", { style: { "--tint": `var(--l${lv})` } },
          h("span", { class: "st-lv" }, `L${lv}`), ` ${LV[lv].name}`, h("span", { class: "st-hint" }, LV[lv].hint))))));
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
        h("ol", { class: "strata", "aria-label": "Count per layer" }, [4, 3, 2, 1, 0].map((n) => h("li", { style: { "--tint": `var(--l${n})` } },
          h("span", { class: "st-lv" }, `L${n}`), ` ${LV[n].name} `, h("b", {}, num(lv[n])))))),
      acts);
    // The whole row is already a link for keyboards and screen readers; this is the visible "open" affordance.
    acts.append(h("a", { class: "btn", href: link.repo(r.id), tabindex: "-1", "aria-hidden": "true", html: "<span>Open map</span>" + icon("arrow") }), del);
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

// ---------------------------------------------------------------- 3D stack
function mini(layer) {
  const W = 440, H = 280, pad = 36;
  let nodes = layer.level >= 3 ? layer.nodes : layer.nodes.filter((n) => n.role === "app");
  if (!nodes.length) nodes = layer.nodes;
  const ranks = [...new Set(nodes.map((n) => n.rank))].sort((a, b) => a - b);
  const cols = new Map();
  nodes.forEach((n) => { const c = ranks.indexOf(n.rank); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(n); });
  const pos = {};
  for (const [c, arr] of cols) arr.forEach((n, i) => {
    const x = ranks.length === 1 ? W / 2 : pad + (W - 2 * pad) * (c / (ranks.length - 1));
    const y = pad + (H - 2 * pad) * ((i + 0.5) / arr.length);
    pos[n.id] = [x + (arr.length > 7 ? ((i % 3) - 1) * 11 : 0), y];
  });
  const max = Math.max(1, ...nodes.map((n) => n.deg_in + n.deg_out));
  let lines = "", dots = "";
  for (const l of layer.links.slice(0, 70)) {
    const a = pos[l.source], b = pos[l.target];
    if (a && b) lines += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}"/>`;
  }
  for (const n of nodes) {
    const [x, y] = pos[n.id];
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(3 + 8 * Math.sqrt((n.deg_in + n.deg_out) / max)).toFixed(1)}"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="mini-links">${lines}</g><g class="mini-dots">${dots}</g></svg>`;
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
  // Five equal slabs with rounded tops, floating one above another with air between them, each casting a soft
  // shadow on the one below.
  // A slab's top face carries a miniature of its layer, uncovered when the slabs above lift out of the way.
  const tilt = h("div", { class: "stack-tilt" });
  const scene = h("div", { class: "stack-scene" }, tilt);
  const legend = h("ol", { class: "stack-legend" });
  const wrap = h("div", { class: "stack-wrap" }, scene, legend);
  const slabs = {};
  const each = (fn) => Object.entries(slabs).forEach(([n, el]) => fn(el, +n));

  // Picking a layer: the block's top face turns to face you, then the flat view grows out of the rectangle it ended on.
  function pick(lv, e) {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return;   // let the browser open a new tab or window
    if (e) e.preventDefault();
    if (wrap.classList.contains("is-picking")) return;
    if (reduced() || (e && e.detail === 0)) { location.hash = link.layer(rid, lv); return; }   // keyboard: no waiting
    const data = api(layerPath(rid, lv, 90)).catch(() => null);
    wrap.classList.add("is-picking");
    each((el, n) => {
      el.classList.add(n === lv ? "is-picked" : n > lv ? "is-above" : "is-below");
      el.style.setProperty("--lift", n > lv ? "70px" : "0px");
    });
    // Hand over when both the turn is done and the layer has arrived, so the flat view never opens empty.
    const due = new Promise((done) => { pickTimer = setTimeout(done, 260); });
    Promise.all([data, due]).then(() => {
      if (!pickTimer || !wrap.isConnected) return;   // left meanwhile (Back, another link): leave() cleared the timer
      handoff = { rid, level: lv, data, rect: slabs[lv].querySelector(".slab-top").getBoundingClientRect() };
      location.hash = link.layer(rid, lv);
    });
  }
  // Pointing at a block lifts everything above it, uncovering that block's top face. The block itself stays put,
  // so what is under the pointer never moves away from it.
  const hot = (lv, on) => {
    if (wrap.classList.contains("is-picking")) return;
    each((el, n) => {
      el.classList.toggle("is-hot", on && n === lv);
      el.style.setProperty("--lift", on && n > lv ? "44px" : "0px");
      // the lowest lifted slab keeps its shadow on the surface it left, so the shadow says "this one floated up"
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
      // the body: thin rounded sheets stacked through the slab's thickness, so the corners follow the rounded top
      Array.from({ length: 12 }, (_, i) => h("div", { class: "slab-layer", style: { "--i": i } })),
      h("div", { class: "slab-top", html: mini(layer) }),
      h("div", { class: "slab-side s-front" }, h("span", { class: "slab-name" }, `L${lv}`)),
      h("div", { class: "slab-side s-left" }));
    tilt.append(slabs[lv]);
    const top = [...new Set([...layer.nodes].sort((a, b) => (b.deg_in + b.deg_out) - (a.deg_in + a.deg_out)).map(nameOf))].slice(0, 3).join(" · ");
    legend.append(h("li", {}, h("a", { class: "legend-row", href: link.layer(rid, lv), dataset: { level: lv }, style: { "--tint": `var(--l${lv})` },
      onclick: (e) => pick(lv, e), onmouseenter: () => hot(lv, true), onmouseleave: () => hot(lv, false),
      onfocus: () => hot(lv, true), onblur: () => hot(lv, false) },
      h("span", { class: "lg-lv" }, `L${lv}`),
      h("span", { class: "lg-name" }, LV[lv].name,
        h("span", { class: "lg-hint" }, LV[lv].hint, LV[lv].fact ? "" : " · named by the model"),
        top ? h("span", { class: "lg-top" }, top) : null),
      h("span", { class: "lg-count" }, num(layer.total), h("span", { class: "sr" }, " items")),
      h("span", { class: "lg-go", html: icon("arrow") }))));
  });

  fill(root,
    h("header", { class: "view-head" },
      h("h1", {}, soft(`${repo.owner}/${repo.name}`)),
      h("p", { class: "view-sub" }, "Pick a layer to open it. Higher layers show the big picture; lower ones show the actual code. ",
        h("a", { href: `${repo.url}/tree/${repo.commit_sha}`, target: "_blank", rel: "noopener", html: `GitHub ${icon("out", 14)}` }))),
    wrap);

  // The tower builds itself once: blocks drop into place from the bottom up, code first, big picture last.
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
export async function layer(view, rid, level) {
  const PAGE = 90, MAX_WIRES = 90;
  let limit = PAGE, data = null, active = null, firstDraw = true;
  const pass = handoff && handoff.rid === rid && handoff.level === level ? handoff : null;
  handoff = null;

  const sub = h("p", { class: "view-sub" });
  const tools = h("div", { class: "layer-tools" });
  const scroll = h("div", { class: "layer-scroll", tabindex: "0", role: "region", "aria-label": `L${level} ${LV[level].name} map` });
  // aria-disabled rather than disabled while loading: a disabled button drops keyboard focus.
  const more = h("button", { class: "btn", type: "button", hidden: true, onclick: async () => {
    if (more.getAttribute("aria-disabled") === "true") return;
    more.setAttribute("aria-disabled", "true");
    limit = Math.min(2000, limit + PAGE * 2);
    await load();
    more.removeAttribute("aria-disabled");
    if (more.hidden) scroll.focus();   // everything is loaded: the button is gone, keep the keyboard on the map
  } });
  const moreBox = h("div", { class: "layer-more" }, more);
  const edge = () => scroll.classList.toggle("more-x", scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 4);
  scroll.addEventListener("scroll", edge, { passive: true });
  const head = h("header", { class: "view-head" },
    h("a", { class: "btn quiet back", href: link.repo(rid), html: icon("back") + "<span>All five layers</span>" }),
    h("h1", {}, `L${level} ${LV[level].name}`), sub);
  const root = h("div", { class: "layer-view", style: { "--tint": `var(--l${level})` } }, head, tools, scroll, moreBox);
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
    if (before) {   // "Load more" must change what you see: if the new batch is all of a hidden kind, show that kind
      const fresh = data.nodes.filter((n) => !before.has(n.id));
      if (fresh.length && !fresh.some((n) => active.has(n.role))) fresh.forEach((n) => active.add(n.role));
    }
    const kids = [];
    if (present.length > 1) {
      kids.push(h("div", { class: "seg", role: "group", "aria-label": "Show" },
        data.total > data.nodes.length ? h("span", { class: "seg-note" }, `Of ${num(data.nodes.length)} loaded:`) : null,
        present.map((r) => h("button", { class: "seg-b", type: "button", "aria-pressed": String(active.has(r)), onclick: (e) => {
          if (active.has(r) && active.size > 1) active.delete(r); else active.add(r);
          e.currentTarget.setAttribute("aria-pressed", String(active.has(r)));
          draw();
        } }, ROLE[r], h("span", { class: "seg-n" }, num(data.nodes.filter((n) => n.role === r).length))))));
    }
    kids.push(h("ul", { class: "legend-dots", "aria-label": "Groups" }));
    fill(tools, kids);
    more.hidden = data.total <= data.nodes.length;
    more.textContent = `Load ${num(Math.min(PAGE * 2, data.total - data.nodes.length))} more`;
    draw();
  }

  function draw() {
    const at = [scroll.scrollLeft, scroll.scrollTop];
    const shown = data.nodes.filter((n) => active.has(n.role));
    const ranks = [...new Set(shown.map((n) => n.rank))].sort((a, b) => a - b);
    const groups = data.groups.filter((g) => shown.some((n) => n.parent === g.id));
    const tinted = groups.length >= 2 && groups.length <= 6;
    const gi = new Map(groups.map((g, i) => [g.id, i]));
    const map = h("div", { class: "layer-map" + (level <= 1 ? " is-code" : "") });
    const svg = wireSvg();
    map.append(svg);

    const under = (n) => level >= 3 ? (n.title ? n.path || "" : "") : level === 2 ? n.path
      : level === 1 ? (n.path || "").split("/").slice(0, -1).join("/") : `${(n.path || "").split("/").pop()}:${n.line || ""}`;
    ranks.forEach((r) => {
      const col = shown.filter((n) => n.rank === r).sort((a, b) =>
        (gi.get(a.parent) ?? 99) - (gi.get(b.parent) ?? 99) || (b.deg_in + b.deg_out) - (a.deg_in + a.deg_out));
      map.append(h("ul", { class: "layer-col" }, col.map((n) => h("li", {},
        h("a", { class: "node" + (n.role !== "app" ? " is-side" : ""), href: link.node(rid, n.id), dataset: { id: n.id }, title: n.path || n.label },
          tinted && gi.has(n.parent) ? h("i", { class: `dot g${gi.get(n.parent)}`, "aria-hidden": "true" }) : null,
          h("span", { class: "node-t" + (level <= 1 ? " mono" : "") }, label(n)),
          under(n) ? h("span", { class: "node-s mono" }, soft(under(n))) : null,
          n.role !== "app" ? h("span", { class: "node-role" }, ROLE[n.role]) : null)))));
    });
    fill(scroll, map);
    scroll.scrollLeft = at[0];
    scroll.scrollTop = at[1];

    const ids = new Set(shown.map((n) => n.id));
    const all = data.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    const links = all.slice(0, MAX_WIRES);
    fill(sub, `${LV[level].hint} · ${num(shown.length)} of ${num(data.total)} shown · callers on the left, callees on the right`,
      all.length > links.length ? ` · strongest ${num(links.length)} arrows` : "");
    fill(tools.querySelector(".legend-dots"), tinted ? groups.map((g, i) =>
      h("li", {}, h("i", { class: `dot g${i}`, "aria-hidden": "true" }), nameOf(g))) : []);

    const els = Object.fromEntries([...map.querySelectorAll(".node")].map((e) => [e.dataset.id, e]));
    const paths = drawWires(svg, "arw-l", links, (p, l) => {
      p.style.strokeWidth = Math.min(2.2, 0.8 + Math.log2(l.weight) * 0.22).toFixed(2);
      p.setAttribute("marker-end", "url(#arw-l)");
    });
    const place = () => {
      const box = {};
      const get = (id) => (box[id] ||= boxIn(els[id], map));
      paths.forEach(({ l, p }) => p.setAttribute("d", curve(get(l.source), get(l.target), ZERO, "flow")));
    };
    place();
    edge();
    onResize(map, () => { place(); edge(); });

    const near = new Map();
    links.forEach((l) => {
      if (!near.has(l.source)) near.set(l.source, new Set());
      if (!near.has(l.target)) near.set(l.target, new Set());
      near.get(l.source).add(l.target);
      near.get(l.target).add(l.source);
    });
    let off = 0;
    const light = (id) => {
      map.classList.toggle("has-hot", !!id);
      const mine = (id && near.get(id)) || new Set();
      Object.values(els).forEach((e) => {
        e.classList.toggle("is-hot", e.dataset.id === id);
        e.classList.toggle("is-near", mine.has(e.dataset.id));
      });
      paths.forEach(({ l, p }) => p.classList.toggle("is-hot", !!id && (l.source === id || l.target === id)));
    };
    // A short grace before un-highlighting, so sweeping across the gaps between cards does not make the map pulse.
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
        [head, tools, moreBox].forEach((e) => e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 60, easing: "ease-out", fill: "backwards" }));
      } else {
        scroll.classList.add("is-direct");
      }
    }
  }
  await load();
}

// ---------------------------------------------------------------- mind map around one node
export async function focus(view, rid, nodeId) {
  let cap = innerWidth < 760 ? 6 : 14;
  const current = view.querySelector(".mm");
  const old = new Map([...view.querySelectorAll(".mm [data-id]")].map((e) => [e.dataset.id, e.getBoundingClientRect()]));
  if (current) {
    // While the next map loads, the old one stays but is plainly "on its way out", and the clicked chip answers at once.
    current.classList.add("is-loading");
    current.setAttribute("aria-busy", "true");
    const going = [...current.querySelectorAll("[data-id]")].find((e) => e.dataset.id === nodeId);
    if (going) going.classList.add("is-going");
  } else {
    fill(view, h("div", { class: "focus-view" }, skeleton(6)));
  }

  async function load(prev) {
    let data;
    try {
      data = await api(`/repos/${encodeURIComponent(rid)}/focus` + q({ node: nodeId, cap }));
    } catch (err) {
      const missing = err.message === "node not found";
      fill(view, h("div", { class: "focus-view" },
        h("header", { class: "view-head" }, h("h1", {}, missing ? "Item not found" : "Couldn't load the map")),
        problem(missing ? "It may have been renamed when the repository was re-read, or the link is wrong." : err.message, missing ? null : () => load(new Map())),
        h("p", { class: "after-problem" }, h("a", { class: "btn", href: link.repo(rid) }, "All five layers"))));
      return null;
    }
    if (state.route.view !== "focus" || state.route.node !== nodeId) return null;
    const self = data.node;
    const mm = h("div", { class: "mm" });
    const svg = wireSvg();
    mm.append(svg, h("div", { class: "mm-heads", "aria-hidden": "true" },
      h("span", {}), h("span", {}, "Callers"), h("span", {}, "Structure"), h("span", {}, "Callees")));

    const chip = (i) => {
      const me = i.relation === "self";
      return h(me ? "span" : "a", { class: `chip rel-${i.relation}` + (i.level <= 1 ? " mono" : ""), href: me ? null : link.node(rid, i.id),
        dataset: { id: i.id }, "aria-current": me ? "true" : null, title: i.path || i.label },
        h("span", { class: "chip-t" }, label(i)),
        i.relation === "both" ? h("span", { class: "chip-both", title: "They call each other", html: icon("both", 13) + '<span class="sr">calls each other</span>' }) : null,
        i.weight && !me ? h("span", { class: "chip-w" }, `×${num(i.weight)}`, h("span", { class: "sr" }, " connections")) : null);
    };
    data.levels.forEach((row) => {
      const lv = row.level;
      const zone = (rels) => row.items.filter((i) => rels.includes(i.relation));
      const mid = zone(["self", "ancestor", "descendant"]);
      const rest = row.total != null ? row.total - mid.filter((i) => i.relation === "descendant").length : 0;
      const none = () => h("span", { class: "mm-none" }, "—", h("span", { class: "sr" }, "none"));
      const moreChip = rest <= 0 ? null : cap >= 80
        ? h("a", { class: "chip more", href: link.layer(rid, lv) }, `${num(rest)} more · view in L${lv}`)
        : h("button", { class: "chip more", type: "button", onclick: () => {
          cap = Math.min(80, cap + 20);
          load(new Map([...mm.querySelectorAll("[data-id]")].map((e) => [e.dataset.id, e.getBoundingClientRect()])));
        } }, `${num(rest)} more`);
      mm.append(h("section", { class: "mm-row" + (lv === self.level ? " is-own" : ""), dataset: { level: lv }, style: { "--tint": `var(--l${lv})` }, "aria-label": `L${lv} ${LV[lv].name}` },
        h("a", { class: "mm-lv", href: link.layer(rid, lv), title: `See all of L${lv} ${LV[lv].name}` },
          h("span", { class: "lg-lv" }, `L${lv}`), h("span", {}, LV[lv].name)),
        h("div", { class: "mm-zone mm-in", "aria-label": "Callers" }, zone(["caller"]).map(chip)),
        h("div", { class: "mm-zone mm-mid", "aria-label": "Structure" }, mid.length ? mid.map(chip) : none(), moreChip),
        h("div", { class: "mm-zone mm-out", "aria-label": "Callees" }, zone(["both", "callee"]).map(chip))));
    });

    const root = h("div", { class: "focus-view" },
      h("header", { class: "view-head" },
        h("a", { class: "btn quiet back", href: link.layer(rid, self.level), html: icon("back") + `<span>Back to L${self.level} ${LV[self.level].name}</span>` }),
        h("h1", { class: self.level <= 1 ? "mono" : "" }, label(self)),
        h("p", { class: "view-sub" }, "Click anything to put it in the centre. ",
          h("span", { class: "key k-contains" }, "Contains"), h("span", { class: "key k-flow" }, "Calls · uses")),
        h("button", { class: "btn to-panel", type: "button",
          onclick: () => document.getElementById("panel").scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }) }, "Details · code · ask")),
      h("div", { class: "mm-scroll" }, mm));
    fill(view, root);

    const chips = [...mm.querySelectorAll("[data-id]")];
    const els = Object.fromEntries(chips.map((e) => [e.dataset.id, e]));
    const rel = Object.fromEntries(data.levels.flatMap((row) => row.items.map((i) => [i.id, i.relation])));
    const inner = data.links.filter((l) => l.kind === "flow" && rel[l.source] === "descendant" && rel[l.target] === "descendant");
    const keep = new Set([4, 3, 2, 1, 0].flatMap((lv) => inner.filter((l) => l.level === lv).sort((a, b) => b.weight - a.weight).slice(0, 3)));
    const links = data.links.filter((l) => els[l.source] && els[l.target] && (!inner.includes(l) || keep.has(l)));
    const paths = drawWires(svg, "arw-m", links, (p, l) => {
      p.setAttribute("class", `w-${l.kind}`);
      if (l.kind === "flow") p.setAttribute("marker-end", "url(#arw-m)");
    });
    // `live` follows chips while they are moving (their on-screen boxes); otherwise use layout offsets, which no
    // half-finished animation can distort.
    const place = (live) => {
      const box = {}, o = live ? mm.getBoundingClientRect() : null;
      const get = (id) => {
        if (box[id]) return box[id];
        if (!live) return (box[id] = boxIn(els[id], mm));
        const r = els[id].getBoundingClientRect();
        return (box[id] = { left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top, width: r.width, height: r.height });
      };
      paths.forEach(({ l, p }) => p.setAttribute("d", curve(get(l.source), get(l.target), ZERO, l.kind)));
    };
    place(false);
    onResize(mm, () => place(false));

    let off = 0;
    const light = (id) => {
      mm.classList.toggle("has-hot", !!id);
      paths.forEach(({ l, p }) => p.classList.toggle("is-hot", !!id && (l.source === id || l.target === id)));
    };
    chips.forEach((e) => {
      const on = () => { clearTimeout(off); light(e.dataset.id); };
      const out = () => { clearTimeout(off); off = setTimeout(() => light(null), 90); };
      e.addEventListener("mouseenter", on);
      e.addEventListener("focus", on);
      e.addEventListener("mouseleave", out);
      e.addEventListener("blur", out);
    });
    cleanup.push(() => clearTimeout(off));
    applyCited(root);

    if (!reduced()) {
      // Things that stay travel to their new place; new things arrive from the centre, nearest rows first.
      const me = mm.querySelector(".rel-self").getBoundingClientRect();
      const cx = me.left + me.width / 2, cy = me.top + me.height / 2;
      const anims = [], wait = {};
      chips.forEach((e) => {
        const was = prev.get(e.dataset.id), now = e.getBoundingClientRect();
        const nx = now.left + now.width / 2, ny = now.top + now.height / 2;
        if (was) {
          const dx = was.left + was.width / 2 - nx, dy = was.top + was.height / 2 - ny;
          if (Math.abs(dx) + Math.abs(dy) > 1) {
            anims.push(e.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 340, easing: "cubic-bezier(.77,0,.175,1)" }));
          }
        } else {
          let dx = (cx - nx) * 0.2, dy = (cy - ny) * 0.2;
          const d = Math.hypot(dx, dy);
          if (d > 36) { dx *= 36 / d; dy *= 36 / d; }
          const far = Math.min(4, Math.abs(+e.closest(".mm-row").dataset.level - self.level));
          wait[e.dataset.id] = (prev.size ? 80 : 0) + [0, 40, 70, 90, 100][far];
          anims.push(e.animate([{ opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.96)` }, { opacity: 1, transform: "none" }],
            { duration: 220, delay: wait[e.dataset.id], easing: "cubic-bezier(.23,1,.32,1)", fill: "backwards" }));
        }
      });
      paths.forEach(({ l, p }) => p.animate([{ opacity: 0 }, { opacity: 1 }],
        { duration: 200, delay: Math.max(wait[l.source] || 0, wait[l.target] || 0), easing: "ease-out", fill: "backwards" }));
      if (anims.length) {
        let run = true;
        const tick = () => { if (!run) return; place(true); requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        Promise.allSettled(anims.map((a) => a.finished)).then(() => { run = false; if (mm.isConnected) place(false); });
        cleanup.push(() => { run = false; });
      }
    }
    return self;
  }
  return load(old);
}
