// The mind map: a tree that grows to the right one branch at a time, like NotebookLM's.
// Each item opens with its arrow button; clicking its name makes it the new centre.
import { h, api, q, link, num, nameOf, soft, icon, reduced, fill, LV } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
export const PAGE = 8;
const GX = 72;          // gap between a parent and its children
const PAD = 40;
export const REL = { inside: "Inside", calls: "Calls", callers: "Called by" };
const ease = (k) => 1 - Math.pow(1 - k, 3);

// scroll: the scrolling box to draw in.
// root: { node: card|null, label, sub }; branches: [{ rel, total, items }] shown under the root.
// flat: true puts the branch items straight under the root (the whole-repo map), without a "Inside" group node.
export function mindMap(scroll, { rid, root: rootInfo, branches, flat = false }) {
  const canvas = h("div", { class: "mm-canvas" });
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "mm-wires");
  svg.setAttribute("aria-hidden", "true");
  canvas.append(svg);
  fill(scroll, canvas);

  let uid = 0, raf = 0, firstRun = true;
  const wires = new Map();          // tree node -> its path in from the parent
  const leaving = new Set();
  const make = (kind, props) => ({ key: ++uid, kind, kids: null, open: false, total: 0, ...props });
  const loops = (parent, id) => { for (let p = parent; p; p = p.parent) if (p.data && p.data.id === id) return true; return false; };
  const item = (d, rel, parent) => make("item", { data: d, rel, parent, total: (d.counts && d.counts[rel]) || 0, loop: loops(parent, d.id) });
  const withMore = (T) => {
    T.kids = T.kids.filter((k) => k.kind !== "more");
    const rest = T.total - T.kids.length;
    if (rest > 0) T.kids.push(make("more", { parent: T, rest }));
  };

  const root = make("root", { data: rootInfo.node, label: rootInfo.label, sub: rootInfo.sub, open: true, kids: [] });
  for (const b of branches) {
    if (flat) {
      root.total = b.total;
      root.rel = b.rel;
      root.kids = b.items.map((d) => item(d, b.rel, root));
      withMore(root);
    } else if (b.total > 0) {
      const g = make("group", { rel: b.rel, total: b.total, parent: root, open: true });
      g.kids = b.items.map((d) => item(d, b.rel, g));
      withMore(g);
      root.kids.push(g);
    }
  }

  // ---- loading a branch
  async function load(T) {
    const owner = T.kind === "group" ? T.parent.data : T.data;
    const have = (T.kids || []).filter((k) => k.kind !== "more").length;
    const d = await api(`/repos/${encodeURIComponent(rid)}/branch` + q({ rel: T.rel, node: owner ? owner.id : "", limit: PAGE, offset: have }));
    T.total = d.total;
    T.kids = [...(T.kids || []).filter((k) => k.kind !== "more"), ...d.items.map((i) => item(i, T.rel, T))];
    withMore(T);
  }
  function busy(T, on) {
    const b = T.kind === "item" ? T.el && T.el.querySelector(".mm-open") : T.el;
    if (!b) return;
    b.toggleAttribute("aria-busy", on);
    b.classList.toggle("is-busy", on);
  }
  async function toggle(T) {
    if (T.loading) return;
    if (T.open) { T.open = false; sync(T); layout(T); return; }
    if (!T.kids) {
      T.loading = true;
      busy(T, true);
      try { await load(T); } catch (err) { T.loading = false; busy(T, false); fail(T, err); return; }
      T.loading = false;
      busy(T, false);
    }
    T.open = true;
    sync(T);
    layout(T, true);
  }
  async function more(M) {
    const P = M.parent;
    if (M.loading) return;
    M.loading = true;
    M.el.classList.add("is-busy");
    M.el.textContent = "Loading…";
    try { await load(P); } catch (err) { M.loading = false; M.el.classList.remove("is-busy"); M.el.textContent = "Couldn't load. Try again"; return; }
    const at = M.el;
    layout(P, true);
    // keep the keyboard where it was: on the first of the newly shown items
    if (document.activeElement === at || !document.activeElement || document.activeElement === document.body) {
      const fresh = P.kids.find((k) => k.el && k.el.isConnected && !k.seen);
      if (fresh) (fresh.el.querySelector("a, button") || fresh.el).focus({ preventScroll: true });
    }
  }
  function fail(T, err) {
    const b = T.kind === "item" ? T.el.querySelector(".mm-open") : T.el;
    if (b) { b.classList.add("is-error"); b.title = err.message; }
  }

  // ---- elements
  const chev = () => h("span", { class: "mm-chev", html: icon("chev", 14) });
  function sync(T) {
    const b = T.kind === "item" ? T.el && T.el.querySelector(".mm-open") : T.kind === "group" ? T.el : null;
    if (!b) return;
    b.setAttribute("aria-expanded", String(T.open));
    b.classList.toggle("is-open", T.open);
  }
  function element(T) {
    if (T.el) return T.el;
    let e;
    if (T.kind === "root") {
      const lv = T.data ? T.data.level : null;
      e = h("div", { class: "mm-node is-root", dataset: T.data ? { id: T.data.id } : {} },
        h("span", { class: "mm-t" + (lv != null && lv <= 1 ? " mono" : "") }, lv != null && lv <= 1 ? soft(T.label) : T.label),
        T.sub ? h("span", { class: "mm-sub" }, T.sub) : null);
    } else if (T.kind === "group") {
      e = h("button", { class: `mm-node is-group rel-${T.rel}`, type: "button", "aria-expanded": String(T.open), onclick: () => toggle(T) },
        h("span", { class: "mm-t" }, REL[T.rel]), h("span", { class: "mm-count" }, num(T.total)), chev());
    } else if (T.kind === "more") {
      e = h("button", { class: "mm-node is-more", type: "button", onclick: () => more(T) },
        T.rest <= PAGE ? `Show ${num(T.rest)} more` : `Show ${PAGE} more · ${num(T.rest)} left`);
    } else {
      const d = T.data, code = d.level <= 1;
      const opener = T.total > 0 && !T.loop
        ? h("button", { class: "mm-open", type: "button", "aria-expanded": String(T.open),
          "aria-label": `${REL[T.rel]}: ${num(T.total)}, under ${nameOf(d)}`, title: `${REL[T.rel]} · ${num(T.total)}`, onclick: () => toggle(T) },
          h("span", { class: "mm-count" }, num(T.total)), chev())
        : null;
      e = h("div", { class: "mm-node is-item" + (T.loop ? " is-loop" : ""), dataset: { id: d.id }, style: { "--tint": `var(--l${d.level})` } },
        h("a", { class: "mm-t" + (code ? " mono" : ""), href: link.node(rid, d.id),
          title: [`L${d.level} ${LV[d.level].name}`, d.path].filter(Boolean).join(" · ") + (T.loop ? " · already on this branch" : "") },
          h("i", { class: "mm-dot", "aria-hidden": "true" }), h("span", {}, code ? soft(nameOf(d)) : nameOf(d))),
        opener);
    }
    T.el = e;
    e.addEventListener("mouseenter", () => hot(T, true));
    e.addEventListener("mouseleave", () => hot(T, false));
    return e;
  }
  // a pointed-at item lights the line back to the centre
  function hot(T, on) {
    for (let n = T; n && n.parent; n = n.parent) {
      const p = wires.get(n);
      if (p) p.classList.toggle("is-hot", on);
    }
  }

  // ---- layout: children to the right, the parent centred on them
  const shown = (T, out = []) => { out.push(T); if (T.open && T.kids) T.kids.forEach((k) => shown(k, out)); return out; };
  const gapAfter = (a, b) => (a.kind === "group" || (a.open && a.kids && a.kids.length) || (b && b.open && b.kids && b.kids.length) ? 18 : 8);
  function size(T) {
    const kids = T.open && T.kids ? T.kids : [];
    if (!kids.length) return (T.sh = T.h);
    let sum = 0;
    kids.forEach((k, i) => { sum += size(k) + (i ? gapAfter(kids[i - 1], k) : 0); });
    return (T.sh = Math.max(T.h, sum));
  }
  function place(T, x, top) {
    T.x = x;
    const kids = T.open && T.kids ? T.kids : [];
    if (!kids.length) { T.y = top + (T.sh - T.h) / 2; return; }
    let sum = 0;
    kids.forEach((k, i) => { sum += k.sh + (i ? gapAfter(kids[i - 1], k) : 0); });
    let y = top + (T.sh - sum) / 2;
    const kx = x + T.w + GX;
    kids.forEach((k, i) => { if (i) y += gapAfter(kids[i - 1], k); place(k, kx, y); y += k.sh; });
    const a = kids[0], b = kids[kids.length - 1];
    T.y = (a.y + a.h / 2 + b.y + b.h / 2) / 2 - T.h / 2;
  }
  // Insert new elements right after the one before them, so the tab order follows the tree without moving anything
  // that already has focus.
  function order(list) {
    let prev = svg;
    for (const T of list) {
      let next = prev.nextElementSibling;
      while (next && next.classList.contains("is-leaving")) next = next.nextElementSibling;
      if (next !== T.el) prev.after(T.el);
      prev = T.el;
    }
  }

  function layout(anchor = null, reveal = false) {
    const list = shown(root);
    const live = new Set(list);
    for (const T of [...wires.keys()]) if (!live.has(T) && T.el && !leaving.has(T)) goAway(T);
    list.forEach(element);
    order(list);
    list.forEach((T) => { T.w = T.el.offsetWidth; T.h = T.el.offsetHeight; });
    size(root);
    place(root, PAD, 0);
    const W = Math.max(...list.map((T) => T.x + T.w)) + PAD;
    const H = Math.max(root.sh + 2 * PAD, scroll.clientHeight - 2);
    const oy = Math.max(PAD, (H - root.sh) / 2);
    list.forEach((T) => { T.to = { x: T.x, y: T.y + oy, o: 1 }; });

    // keep the thing you clicked where it is: move the view by as much as the tree moved under it
    const oldH = canvas.offsetHeight;
    canvas.style.width = `${Math.max(W, canvas.offsetWidth)}px`;
    canvas.style.height = `${Math.max(H, oldH)}px`;
    if (anchor && anchor.cur) {
      const before = scroll.scrollTop;
      scroll.scrollTop = before + (anchor.to.y - anchor.cur.y);
      const moved = scroll.scrollTop - before;
      if (moved) [...wires.keys(), root].forEach((T) => { if (T.cur) T.cur.y += moved; });
    }
    list.forEach((T) => {
      if (T.cur) return;
      T.seen = false;
      const p = T.parent && T.parent.cur;
      T.cur = p && !firstRun
        ? { x: p.x + T.parent.w + GX * 0.35, y: p.y + T.parent.h / 2 - T.h / 2, o: 0 }
        : firstRun && p ? { x: p.x + T.parent.w, y: p.y + T.parent.h / 2 - T.h / 2, o: 0 } : { ...T.to, o: T === root ? 1 : 0 };
    });
    list.forEach((T) => { if (T !== root && !wires.has(T)) wires.set(T, svg.appendChild(document.createElementNS(NS, "path"))); });
    tween(list, () => {
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      list.forEach((T) => { T.seen = true; });
    });
    if (firstRun) {
      firstRun = false;
      scroll.scrollTop = root.to.y + root.h / 2 - scroll.clientHeight / 2;
      // on a narrow screen, start with the first branches in view rather than the centre's empty left side
      scroll.scrollLeft = Math.max(0, root.to.x + root.w + GX - scroll.clientWidth * 0.42);
    } else if (reveal && anchor) {
      // bring the new branch into view, without losing the item that opened it
      const kids = anchor.kids || [];
      const right = Math.max(anchor.to.x + anchor.w, ...kids.map((k) => k.to.x + k.w)) + 24;
      const want = Math.min(right - scroll.clientWidth, anchor.to.x - 24);
      if (want > scroll.scrollLeft) scroll.scrollTo({ left: want, behavior: reduced() ? "auto" : "smooth" });
    }
  }
  function goAway(T) {
    leaving.add(T);
    T.el.classList.add("is-leaving");
    T.el.inert = true;
    let p = T.parent;
    while (p && p.parent && !(p.open && shown(root).includes(p))) p = p.parent;
    T.away = p && p.cur ? { x: p.cur.x + p.w * 0.6, y: p.cur.y + p.h / 2 - T.h / 2, o: 0 } : { ...T.cur, o: 0 };
  }

  function draw(T) {
    T.el.style.transform = `translate(${T.cur.x.toFixed(1)}px, ${T.cur.y.toFixed(1)}px)`;
    T.el.style.opacity = T.cur.o >= 0.999 ? "" : T.cur.o.toFixed(3);
  }
  function wire(T) {
    const p = wires.get(T), P = T.parent;
    if (!p || !P || !P.cur) return;
    const x1 = P.cur.x + P.w, y1 = P.cur.y + P.h / 2, x2 = T.cur.x, y2 = T.cur.y + T.h / 2;
    const dx = Math.max(16, (x2 - x1) / 2);
    p.setAttribute("d", `M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    p.style.opacity = T.cur.o >= 0.999 ? "" : T.cur.o.toFixed(3);
  }
  function tween(list, done) {
    cancelAnimationFrame(raf);
    const D = reduced() ? 0 : 340;
    const from = new Map([...list, ...leaving].map((T) => [T, { ...T.cur }]));
    const t0 = performance.now();
    const step = (now) => {
      const k = D ? Math.min(1, (now - t0) / D) : 1, e = ease(k);
      for (const [T, a] of from) {
        const b = leaving.has(T) ? T.away : T.to;
        T.cur = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, o: a.o + (b.o - a.o) * e };
        if (T.el) draw(T);
      }
      for (const T of from.keys()) wire(T);
      if (k < 1) { raf = requestAnimationFrame(step); return; }
      for (const T of leaving) {
        T.el.remove();
        T.el = null;
        T.cur = null;
        const p = wires.get(T);
        if (p) p.remove();
        wires.delete(T);
      }
      leaving.clear();
      done();
    };
    raf = requestAnimationFrame(step);
  }

  // drag the empty canvas to move around, like a sheet of paper
  let drag = null;
  scroll.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".mm-node")) return;
    drag = { x: e.clientX, y: e.clientY, l: scroll.scrollLeft, t: scroll.scrollTop, id: e.pointerId };
    scroll.setPointerCapture(e.pointerId);
    scroll.classList.add("is-dragging");
  });
  scroll.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    scroll.scrollLeft = drag.l - (e.clientX - drag.x);
    scroll.scrollTop = drag.t - (e.clientY - drag.y);
  });
  const drop = () => { drag = null; scroll.classList.remove("is-dragging"); };
  scroll.addEventListener("pointerup", drop);
  scroll.addEventListener("pointercancel", drop);

  layout();
  let first = true;
  const ro = new ResizeObserver(() => { if (first) { first = false; return; } layout(); });
  ro.observe(scroll);
  return {
    root,
    stop() { cancelAnimationFrame(raf); ro.disconnect(); },
    collapseAll() {
      const shut = (T) => { if (T.kids) T.kids.forEach(shut); if (T.kind === "item" && T.open) { T.open = false; sync(T); } };
      shut(root);
      layout();
    },
  };
}
