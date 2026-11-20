// Shell: routing, breadcrumbs, search, model status.
import { state, LV, nameOf, icon, h, api, q, link, parseRoute, problem, skeleton, fill } from "./lib.js";
import * as V from "./views.js";
import { renderPanel } from "./panel.js";
import { settings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const view = $("view"), panel = $("panel"), crumbs = $("crumbs"), searchBox = $("search"), modelEl = $("model"), shell = $("shell");
let first = true;

function setCrumbs(items) {
  fill(crumbs, items.length ? h("ol", {}, items.map(([label, href], i) =>
    h("li", {}, i === items.length - 1 ? h("span", { "aria-current": "page" }, label) : h("a", { href }, label)))) : "");
}

async function loadModel() {
  try {
    state.model = (await api("/health")).model;
    const where = { anthropic: "Claude", ollama: "Ollama" }[state.model.provider];
    modelEl.className = "model" + (state.model.chat_model ? " is-on" : "");
    modelEl.innerHTML = icon("gear", 15);
    modelEl.append(state.model.chat_model ? `${where} · ${state.model.chat_model}` : "Connect a model");
    modelEl.title = "Model settings";
  } catch {
    state.model = null;
    modelEl.className = "model is-off";
    modelEl.textContent = "Server not reachable";
    modelEl.title = "";
  }
}

function mountSearch(rid) {
  searchBox.hidden = false;
  if (searchBox.dataset.rid === rid) return;
  searchBox.dataset.rid = rid;
  const list = h("ul", { id: "q-list", class: "q-list", role: "listbox", "aria-label": "Results", hidden: true });
  const input = h("input", { type: "search", id: "q", placeholder: "Search by name or what it does", autocomplete: "off", maxlength: "300", role: "combobox",
    "aria-expanded": "false", "aria-controls": "q-list", "aria-label": "Search this repository" });
  let timer, seq = 0, hits = [], at = -1, fresh = "";
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); at = -1; };
  const mark = () => {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === at)));
    if (at >= 0) input.setAttribute("aria-activedescendant", `q-opt-${at}`); else input.removeAttribute("aria-activedescendant");
  };
  const show = (kids) => { fill(list, ...kids); list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      if (list.hidden || !hits.length) show([h("li", { class: "q-note" }, "Searching…")]);
      try {
        const found = await api(`/repos/${encodeURIComponent(rid)}/search` + q({ q: text, k: 8 }));
        if (mine !== seq) return;
        hits = found;
        fresh = text;
        at = -1;
        show(hits.length ? hits.map((n, i) => h("li", { role: "option", id: `q-opt-${i}`, "aria-selected": "false" },
          h("a", { href: link.node(rid, n.id), tabindex: "-1" }, h("span", { class: "q-t" + (n.level <= 1 ? " mono" : "") }, nameOf(n)),
            h("span", { class: "q-s" }, `L${n.level} ${LV[n.level].name}`, n.path ? ` · ${n.path}` : ""))))
          : [h("li", { class: "q-note" }, "Nothing matches. Try other words.")]);
      } catch (err) {
        show([h("li", { class: "q-note" }, err.message)]);
      }
    }, 260);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (list.hidden || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = (at + (e.key === "ArrowDown" ? 1 : hits.length - 1) + (at < 0 && e.key === "ArrowUp" ? 1 : 0)) % hits.length;
      mark();
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      if (input.value.trim() !== fresh) return;   // results on screen belong to an earlier query
      location.hash = link.node(rid, hits[Math.max(at, 0)].id);
      input.value = "";
      close();
    }
  });
  input.addEventListener("blur", close);
  list.addEventListener("mousedown", (e) => e.preventDefault());   // keep focus in the field so a slow click still lands
  addEventListener("hashchange", close);
  fill(searchBox, h("span", { class: "q-ic", html: icon("search") }), input, list);
}

async function render() {
  const r = parseRoute();
  const prev = state.route;
  state.route = r;
  V.leave();
  shell.dataset.view = r.view;
  document.querySelector('.skip[href="#panel"]').hidden = r.view === "home";
  if (r.view === "settings") {
    document.title = "Settings · Repo Atlas";
    setCrumbs([["Settings", ""]]);
    searchBox.hidden = true;
    renderPanel(panel);
    await settings(view, loadModel);
    return;
  }
  if (r.view === "home") {
    state.repo = null;
    document.title = "Repo Atlas";
    setCrumbs([]);
    searchBox.hidden = true;
    renderPanel(panel);
    await V.home(view);
    return;
  }
  if (!state.repo || state.repo.repo.id !== r.rid) {
    fill(view, skeleton(5));
    panel.hidden = true;
    state.cited = new Set();
    try {
      state.repo = await api(`/repos/${encodeURIComponent(r.rid)}`);
    } catch {
      state.repo = null;
    }
    if (state.route !== r) return;
    if (!state.repo || state.repo.repo.status !== "ready") {
      const working = state.repo && state.repo.repo.status === "working";
      state.repo = null;
      searchBox.hidden = true;
      setCrumbs([]);
      fill(view, h("div", { class: "home" }, problem(working ? "This repository is still being read. Follow its progress on the home screen."
        : "This repository isn't here. Pick one on the home screen."), h("p", {}, h("a", { class: "btn", href: link.home() }, "Back to home"))));
      return;
    }
  }
  const repo = state.repo.repo, name = `${repo.owner}/${repo.name}`;
  if (prev.view !== r.view && !(state.tab === "ask" && (state.chats[r.rid] || []).length)) state.tab = "info";
  state.nodeName = null;
  const base = [[name, link.repo(r.rid)]];
  setCrumbs(r.view === "layer" ? [...base, [`L${r.level} ${LV[r.level].name}`, ""]] : base);
  document.title = `${name} · Repo Atlas`;
  mountSearch(r.rid);
  renderPanel(panel);
  if (r.view === "stack") await V.stack(view, r.rid);
  else if (r.view === "layer") await V.layer(view, r.rid, r.level);
  else if (r.view === "map") {
    setCrumbs([...base, ["Mind map", ""]]);
    document.title = `Mind map · ${name}`;
    await V.focus(view, r.rid, null);
  } else {
    const node = await V.focus(view, r.rid, r.node);
    if (!node && state.route === r) panel.hidden = true;
    if (node && state.route === r) {
      state.nodeName = nameOf(node);
      setCrumbs([...base, [`L${node.level} ${LV[node.level].name}`, link.layer(r.rid, node.level)], [nameOf(node), ""]]);
      document.title = `${nameOf(node)} · ${name}`;
    }
  }
  if (state.route !== r) return;
  document.dispatchEvent(new Event("atlas:ready"));
  if (!first) $("main").focus({ preventScroll: true });
  first = false;
}

addEventListener("hashchange", render);
loadModel().then(() => { if (state.repo && state.route.view !== "home" && !panel.hidden) renderPanel(panel); });

// Skip links move focus instead of changing the hash, which the router would read as a route.
document.querySelectorAll(".skip").forEach((a) => a.addEventListener("click", (e) => {
  e.preventDefault();
  const target = document.getElementById(a.getAttribute("href").slice(1));
  if (target && !target.hidden) { target.focus(); target.scrollIntoView(); }
}));
render();
