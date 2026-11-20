// Side panel: what the selected thing is (details / first-day guide) and a place to ask about it.
import { state, LV, ROLE, num, nameOf, icon, h, esc, tick, api, q, link, sse, skeleton, problem, fill, soft, getNode } from "./lib.js";
import { applyCited } from "./views.js";

const rid = () => state.route.rid;
const enc = encodeURIComponent;
// the item picked on the mind map, if any (otherwise the panel follows the page)
const picked = () => (state.route.view === "focus" || state.route.view === "map") && state.sel ? state.sel : null;
const shownNode = () => picked() || state.route.node;
let mounted = null;   // the ask pane that is on screen right now; a streaming answer always paints into this one

export function renderPanel(panel) {
  const r = state.route;
  if (r.view === "home" || r.view === "settings") { panel.hidden = true; mounted = null; fill(panel); return; }
  panel.hidden = false;
  const sel = picked();
  const whole = (r.view === "stack" || r.view === "map") && !sel;
  const infoLabel = whole ? "First-day guide" : "Details";
  const tabs = [["info", infoLabel], ["ask", "Ask"]];
  const panes = {};
  const tablist = h("div", { class: "tabs", role: "tablist", "aria-label": "Panel" }, tabs.map(([id, text]) =>
    h("button", { class: "tab", role: "tab", type: "button", id: `tab-${id}`, "aria-controls": `pane-${id}`,
      "aria-selected": String(state.tab === id), tabindex: state.tab === id ? "0" : "-1",
      onclick: () => select(id),
      onkeydown: (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const btns = [...tablist.querySelectorAll(".tab")];
        const next = btns[(btns.indexOf(document.activeElement) + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
        next.focus();
        select(next.id.slice(4));
      } }, text)));
  for (const [id] of tabs) panes[id] = h("div", { class: `pane pane-${id}`, role: "tabpanel", id: `pane-${id}`, "aria-labelledby": `tab-${id}`, tabindex: "0", hidden: state.tab !== id });
  function select(id) {
    state.tab = id;
    tablist.querySelectorAll(".tab").forEach((b) => {
      const on = b.id === `tab-${id}`;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    for (const k in panes) panes[k].hidden = k !== id;
  }
  fill(panel, tablist, panes.info, panes.ask);
  if (whole) tour(panes.info);
  else if (r.view === "layer") layerInfo(panes.info, r.level);
  else nodeInfo(panes.info, sel || r.node);
  ask(panes.ask, () => select("ask"));
}

// ---------------------------------------------------------------- info panes
const text = (n) => (n.level <= 1 ? soft(nameOf(n)) : nameOf(n));
const nodeLink = (n, extra) => h("a", { class: "row-link", href: link.node(rid(), n.id) },
  h("span", { class: "row-t" + (n.level <= 1 ? " mono" : "") }, text(n)),
  h("span", { class: "row-s" }, extra ?? `L${n.level} ${LV[n.level].name}`));

const honesty = (level) => h("p", { class: "honest" + (LV[level].fact ? " is-fact" : "") },
  LV[level].fact ? "Taken straight from the code." : "Names and descriptions are the local model's interpretation. The grouping itself follows the folders.");

async function tour(pane) {
  fill(pane, skeleton(6));
  let t;
  try {
    t = await api(`/repos/${enc(rid())}/tour`);
  } catch (err) {
    fill(pane, problem(err.message, () => tour(pane)));
    return;
  }
  const list = (items, extra) => h("ul", { class: "rows" }, items.map((n) => h("li", {}, nodeLink(n, extra ? extra(n) : undefined))));
  fill(pane,
    h("h2", {}, "First-day guide"),
    h("p", { class: "pane-lead" }, "Read from callers to callees and the flow comes together."),
    h("h3", {}, "Reading order"),
    h("ol", { class: "rows steps" }, t.reading_order.slice(0, 10).map((n) => h("li", {},
      h("a", { class: "row-link", href: link.node(rid(), n.id) }, h("span", { class: "row-t" }, nameOf(n)),
        h("span", { class: "row-s mono" }, soft(n.path)), n.summary ? h("span", { class: "row-d", html: tick(n.summary) }) : null)))),
    honesty(3),
    t.entry_points.length ? h("h3", {}, "Entry points") : null,
    t.entry_points.length ? h("p", { class: "pane-note" }, "Functions nothing in the repo calls. They're likely the doors in from outside.") : null,
    list(t.entry_points.slice(0, 6), (n) => (n.path || "").split("/").pop()),
    t.hubs.length ? h("h3", {}, "Most used") : null,
    list(t.hubs.slice(0, 6), (n) => `${num(n.deg_in)} links`));
}

function layerInfo(pane, level) {
  const counts = state.repo.layers;
  fill(pane,
    h("h2", {}, `L${level} ${LV[level].name}`),
    h("p", { class: "pane-lead" }, `${LV[level].hint}. Point at a card to see what calls it and what it calls, from real calls and uses in the code. Click a card for its mind map.`),
    honesty(level),
    h("div", { id: "layer-peek", class: "peek", "aria-live": "polite" },
      h("p", { class: "pane-note" }, "Point at a card and what it's connected to is listed here.")),
    h("h3", {}, "Other layers"),
    h("ul", { class: "rows" }, counts.filter((l) => l.level !== level).map((l) => h("li", {},
      h("a", { class: "row-link", href: link.layer(rid(), l.level) },
        h("span", { class: "row-t" }, `L${l.level} ${LV[l.level].name}`), h("span", { class: "row-s" }, `${num(l.count)}`))))));
}

async function nodeInfo(pane, id) {
  fill(pane, skeleton(8));
  let d;
  try {
    d = await getNode(rid(), id);
  } catch (err) {
    const missing = err.message === "node not found";
    fill(pane, problem(missing ? "This item wasn't found." : err.message, missing ? null : () => nodeInfo(pane, id)));
    return;
  }
  if (shownNode() !== id) return;
  const summary = h("p", { class: "summary", html: tick(d.summary || d.doc || "") });
  // The API returns the eight strongest connections; say so instead of letting 8 read as the total.
  const rel = (title, items) => items.length ? [h("h3", {}, `${title} `, h("span", { class: "count" }, items.length >= 8 ? `top ${items.length}` : num(items.length))),
    h("ul", { class: "rows" }, items.map((n) => h("li", {}, nodeLink(n, `×${num(n.weight)}`))))] : [];
  const sn = d.snippet;
  fill(pane,
    h("p", { class: "tags" }, h("span", { class: "tag", style: { "--tint": `var(--l${d.level})` } }, `L${d.level} ${LV[d.level].name}`),
      d.role !== "app" ? h("span", { class: "tag plain" }, ROLE[d.role]) : null,
      d.entry ? h("span", { class: "tag plain" }, "Entry point") : null),
    h("h2", { class: d.level <= 1 ? "mono" : "" }, text(d)),
    d.path ? h("p", { class: "path mono" }, soft(d.path + (d.line ? `:${d.line}` : ""))) : null,
    summary,
    honesty(d.level),
    h("p", { class: "pane-acts" },
      id !== state.route.node ? h("a", { class: "btn primary", href: link.node(rid(), id), html: `${icon("tree")}<span>Open as its own map</span>` }) : null,
      d.url ? h("a", { class: "btn", href: d.url, target: "_blank", rel: "noopener", html: `<span>View on GitHub</span>${icon("out")}` }) : null),
    d.kind === "external" && d.meta.top ? [h("h3", {}, "Most used packages"),
      h("ul", { class: "rows" }, d.meta.top.slice(0, 10).map((t) => h("li", {}, h("span", { class: "row-link is-static" },
        h("span", { class: "row-t mono" }, soft(t.name)), h("span", { class: "row-s" }, `×${num(t.uses)}`)))))] : null,
    rel("Called by", d.called_by), rel("Calls", d.calls),
    d.children_preview.length ? [h("h3", {}, "Inside ", h("span", { class: "count" }, num(d.children))),
      h("ul", { class: "rows" }, d.children_preview.map((n) => h("li", {}, nodeLink(n))))] : null,
    sn ? [h("h3", {}, "Code ", h("span", { class: "count" }, `lines ${sn.start}–${sn.end}`)),
      h("pre", { class: "code", tabindex: "0", style: { "--start": sn.start - 1 } }, h("code", {}, sn.text.split("\n").map((l) => h("span", { class: "ln" }, l || " ")))),
      sn.truncated ? h("p", { class: "pane-note" }, `Showing the start only. The whole file has ${num(sn.total)} lines.`) : null] : null);

  if (!d.summary && state.model && state.model.chat_model) {
    fill(summary, skeleton(2));
    try {
      const ex = await api(`/repos/${enc(rid())}/explain` + q({ node: id }), { method: "POST" });
      if (shownNode() === id) summary.innerHTML = tick(ex.summary || d.doc || "");
    } catch {
      summary.innerHTML = tick(d.doc || "");
    }
  }
}

// ---------------------------------------------------------------- ask
function fmt(body, sources, repoId) {
  let s = tick(body.replace(/^[ \t]*[*-][ \t]+/gm, "• ")).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[(\d+)\]/g, (m, n) => {
    const src = sources.find((x) => x.n === +n);
    return src ? `<a class="cite" href="${link.node(repoId, src.id)}" title="${esc(src.label)}"><span class="sr">source </span>${n}</a>` : m;
  });
  return s.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

// One turn's DOM is built once and then only its parts are updated, so a streaming answer never rebuilds the list
// (which would close the sources the reader just opened and make a screen reader re-read everything).
function turnEl(t, repoId) {
  const ans = h("div", { class: "turn-a" });
  const status = h("p", { class: "turn-status" });
  const srcBox = h("div", { class: "turn-src" });
  t.dom = { ans, status, srcBox, repoId, details: null, marked: false };
  paint(t);
  return h("article", { class: "turn" }, h("p", { class: "turn-q" }, t.q, h("span", { class: "turn-scope" }, t.scope)), ans, status, srcBox);
}
function paint(t) {
  const d = t.dom;
  if (!d) return;
  if (t.error) fill(d.ans, problem(t.error));
  else d.ans.innerHTML = t.text ? fmt(t.text, t.sources, d.repoId) : "";
  d.status.hidden = t.done;
  if (!t.done) {
    d.status.textContent = t.text ? "Writing the answer…" : t.sources.length
      ? `Reading ${num(t.sources.length)} places in the code…` : "Looking for related code…";
  }
  if (t.sources.length && !d.details) {
    d.details = h("details", { class: "srcs" }, h("summary", {}, `Sources: ${num(t.sources.length)} places in the code`),
      h("ol", {}, t.sources.map((s) => h("li", { value: s.n, dataset: { n: s.n } },
        h("a", { href: link.node(d.repoId, s.id) },
          h("span", { class: s.level <= 1 ? "mono" : "" }, s.level <= 1 ? soft(s.title || s.label) : (s.title || s.label)),
          s.path ? h("span", { class: "src-path mono" }, soft(`${s.path}${s.line ? ":" + s.line : ""}`)) : null)))));
    d.details.addEventListener("click", (e) => { if (e.target.closest("summary")) t.touched = true; });
    fill(d.srcBox, d.details);
  }
  if (t.done && d.details && !d.marked) {
    d.marked = true;
    const cited = new Set(t.cited);
    d.details.querySelectorAll("li").forEach((li) => {
      if (!cited.has(+li.dataset.n)) return;
      li.classList.add("is-used");
      li.querySelector("a").append(h("span", { class: "src-used" }, "cited"));
    });
    if (!t.touched) d.details.open = true;
  }
}
function paintSoon(t) {
  if (t.queued) return;
  t.queued = true;
  requestAnimationFrame(() => {
    t.queued = false;
    const pane = mounted && mounted.pane;
    const stick = pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 90;
    paint(t);
    if (stick) pane.scrollTop = pane.scrollHeight;
  });
}
async function run(repoId, t, body) {
  try {
    const resp = await api(`/repos/${enc(repoId)}/ask`, { method: "POST", body, raw: true });
    for await (const ev of sse(resp)) {
      if (ev.type === "sources") t.sources = ev.sources;
      else if (ev.type === "delta") t.text += ev.text;
      else if (ev.type === "error") t.error = "The model stopped while answering. Try again in a moment.";
      else if (ev.type === "done") t.cited = ev.cited;
      paintSoon(t);
    }
  } catch (err) {
    t.error = err.message;
  }
  t.done = true;
  paint(t);
  if (state.route.rid === repoId) {
    state.cited = new Set(t.sources.filter((s) => t.cited.includes(s.n)).map((s) => s.id));
    applyCited();
  }
  if (mounted) mounted.sync();
}

function ask(pane, reveal) {
  const r = state.route;
  const chat = (state.chats[r.rid] ||= []);
  const sel = picked();
  const target = sel || (r.view === "focus" ? r.node : null);
  const scope = target ? { node: target } : r.view === "layer" ? { level: r.level } : {};
  const scopeLabel = () => sel ? (state.selName || "selected item") : r.view === "focus" ? (state.nodeName || "selected item")
    : r.view === "layer" ? `L${r.level} ${LV[r.level].name} layer` : "whole repository";
  const log = h("div", { class: "chat", "aria-live": "polite" });
  const input = h("textarea", { id: "ask-q", rows: "2", maxlength: "2000", placeholder: "e.g. Where is this called from?", "aria-describedby": "ask-scope" });
  const send = h("button", { class: "btn primary", type: "submit", "aria-label": "Send question", html: icon("send") });
  const scopeEl = h("p", { class: "ask-scope", id: "ask-scope" });
  const setScope = () => fill(scopeEl, "About: ", h("b", {}, scopeLabel()));
  const ideas = target ? ["What does this do?", "Where is it called, and what does it call?", "Where should I start reading?"]
    : r.view === "layer" ? ["What should I look at first in this layer?", "What is most tangled together here?"]
      : ["What does this repository do?", "Where should I start reading?"];
  const busy = () => chat.some((t) => !t.done);
  const sync = () => {
    send.disabled = busy();
    log.setAttribute("aria-busy", String(busy()));
  };

  function submit(question) {
    question = question.trim();
    if (!question || busy()) return;
    reveal();
    const t = { q: question, scope: scopeLabel(), text: "", sources: [], cited: [], done: false };
    const history = chat.filter((x) => x.done && !x.error).slice(-2).flatMap((x) => [{ role: "user", content: x.q }, { role: "assistant", content: x.text }]);
    chat.push(t);
    input.value = "";
    if (chat.length === 1) fill(log);
    log.append(turnEl(t, r.rid));
    sync();
    pane.scrollTop = pane.scrollHeight;
    run(r.rid, t, { question, ...scope, history });
  }

  if (chat.length) {
    fill(log, chat.map((t) => turnEl(t, r.rid)));
  } else {
    fill(log, h("div", { class: "chat-empty" },
      h("p", {}, "Ask about an item or a layer on the map. The answer is written from the related code, with sources."),
      state.model && !state.model.chat_model ? h("p", { class: "pane-note" }, "No model is connected, so you'll get the related code locations without a written answer. ",
        h("a", { href: link.settings() }, "Connect a model")) : null,
      h("ul", { class: "ideas" }, ideas.map((idea) => h("li", {}, h("button", { class: "btn idea", type: "button", onclick: () => submit(idea) }, idea))))));
  }
  const form = h("form", { class: "ask-form", onsubmit: (e) => { e.preventDefault(); submit(input.value); } },
    scopeEl, h("label", { class: "sr", for: "ask-q" }, "Question"),
    h("div", { class: "ask-row" }, input, send));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); }
  });
  fill(pane, log, form);
  mounted = { pane, sync };
  setScope();
  document.addEventListener("atlas:ready", setScope, { once: true });
  sync();
  pane.scrollTop = pane.scrollHeight;
}
