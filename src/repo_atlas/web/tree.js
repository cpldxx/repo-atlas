// The mind map: a tree that grows to the right one branch at a time, like NotebookLM's.
// Clicking an item grows its branch right there and shows the item in the side panel. The map shrinks to fit the
// width of the screen (down to a readable size), so there is no dragging around to see what just opened.
import { h, api, q, link, num, nameOf, soft, icon, reduced, fill, LV } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
export const PAGE = 8;
const GX = 60;          // gap between a parent and its children
const PAD = 28;
const MIN_SCALE = 0.72; // never smaller than this: below it, text gets too small to read
export const REL = { inside: "Inside", calls: "Calls", callers: "Called by" };
const ease = (k) => 1 - Math.pow(1 - k, 3);

// scroll: the scrolling box to draw in.
// root: { node: card|null, label, sub }; branches: [{ rel, total, items }] shown under the root.
// flat: put the branch items straight under the root (the whole-repo map), without an "Inside" group node.
// onSelect(card|null): an item was picked (null: the centre).
export function mindMap(scroll, { rid, root: rootInfo, branches, flat = false, onSelect = () => {} }) {
  const sizer = h("div", { class: "mm-sizer" });
  const canvas = h("div", { class: "mm-canvas" });
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "mm-wires");
  svg.setAttribute("aria-hidden", "true");
  canvas.append(svg);
  sizer.append(canvas);
  fill(scroll, sizer);

  let uid = 0, raf = 0, firstRun = true, scale = 1, size0 = { w: 0, h: 0 }, picked = null;
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
  const canOpen = (T) => T.kind === "group" || (T.kind === "item" && T.total > 0 && !T.loop);
  function busy(T, on) {
    if (!T.el) return;
    T.el.toggleAttribute("aria-busy", on);
    T.el.classList.toggle("is-busy", on);
  }
  async function toggle(T) {
    if (T.loading || !canOpen(T)) return;
    if (T.open) { T.open = false; sync(T); layout(T); return; }
    if (!T.kids) {
      T.loading = true;
      busy(T, true);
      try { await load(T); } catch (err) {
        T.loading = false;
        busy(T, false);
        if (T.el) { T.el.classList.add("is-error"); T.el.title = err.message; }
        return;
      }
      T.loading = false;
      busy(T, false);
    }
    T.open = true;
    sync(T);
    // its parent was closed while the branch loaded: it opens with the rest the next time it is shown
    if (!T.el || !T.el.isConnected) return;
    layout(T, true);
  }
  function pick(T) {
    if (picked && picked.el) picked.el.classList.remove("is-picked");
    picked = T;
    if (T.el) T.el.classList.add("is-picked");
    onSelect(T.kind === "root" ? null : T.data);
  }
  async function more(M) {
    const P = M.parent;
    if (M.loading) return;
    M.loading = true;
    M.el.classList.add("is-busy");
    M.el.textContent = "Loading…";
    try { await load(P); } catch { M.loading = false; M.el.classList.remove("is-busy"); M.el.textContent = "Couldn't load. Try again"; return; }
    layout(P, true);
    const fresh = P.kids.find((k) => k.el && k.el.isConnected && !k.seen);
    if (fresh && (!document.activeElement || document.activeElement === document.body)) fresh.el.focus({ preventScroll: true });
  }

  // ---- elements
  const chev = () => h("span", { class: "mm-chev", html: icon("chev", 14) });
  function sync(T) {
    if (!T.el || !canOpen(T)) return;
    T.el.setAttribute("aria-expanded", String(T.open));
    T.el.classList.toggle("is-open", T.open);
  }
  function element(T) {
    if (T.el) return T.el;
    let e;
    if (T.kind === "root") {
      const lv = T.data ? T.data.level : null, code = lv != null && lv <= 1;
      e = h("button", { class: "mm-node is-root is-picked", type: "button", dataset: T.data ? { id: T.data.id } : {}, onclick: () => pick(T) },
        h("span", { class: "mm-t" + (code ? " mono" : "") }, code ? soft(T.label) : T.label),
        T.sub ? h("span", { class: "mm-sub" }, T.sub) : null);
      picked = T;
    } else if (T.kind === "group") {
      e = h("button", { class: `mm-node is-group rel-${T.rel}`, type: "button", "aria-expanded": String(T.open), onclick: () => toggle(T) },
        h("span", { class: "mm-t" }, REL[T.rel]), h("span", { class: "mm-count" }, num(T.total)), chev());
    } else if (T.kind === "more") {
      e = h("button", { class: "mm-node is-more", type: "button", onclick: () => more(T) },
        T.rest <= PAGE ? `Show ${num(T.rest)} more` : `Show ${PAGE} more · ${num(T.rest)} left`);
    } else {
      const d = T.data, code = d.level <= 1, open = canOpen(T);
      const what = [`L${d.level} ${LV[d.level].name}`, d.path].filter(Boolean).join(" · ");
      e = h("button", { class: "mm-node is-item" + (T.loop ? " is-loop" : ""), type: "button", dataset: { id: d.id }, style: { "--tint": `var(--l${d.level})` },
        title: what + (T.loop ? " · already on this branch" : open ? ` · ${REL[T.rel]}: ${num(T.total)}` : ""),
        "aria-expanded": open ? String(T.open) : null,
        "aria-label": `${nameOf(d)}${open ? `, ${REL[T.rel].toLowerCase()} ${num(T.total)}` : ""}`,
        onclick: (ev) => {
          if (ev.metaKey || ev.ctrlKey) { window.open(link.node(rid, d.id), "_blank"); return; }
          pick(T);
          toggle(T);
        } },
        h("i", { class: "mm-dot", "aria-hidden": "true" }),
        h("span", { class: "mm-t" + (code ? " mono" : "") }, code ? soft(nameOf(d)) : nameOf(d)),
        open ? h("span", { class: "mm-open", "aria-hidden": "true" }, h("span", { class: "mm-count" }, num(T.total)), chev()) : null);
    }
    T.el = e;
    if (T.kind === "item" && T.open) e.classList.add("is-open");
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
    for (const T of list) if (leaving.has(T)) { leaving.delete(T); T.el.classList.remove("is-leaving"); T.el.inert = false; }
    list.forEach(element);
    order(list);
    list.forEach((T) => { T.w = T.el.offsetWidth; T.h = T.el.offsetHeight; });
    size(root);
    place(root, PAD, 0);
    const vw = scroll.clientWidth, vh = scroll.clientHeight;
    const W = Math.max(...list.map((T) => T.x + T.w)) + PAD;
    // as wide as it needs, as small as it has to be to fit (but still readable)
    const s1 = Math.max(MIN_SCALE, Math.min(1, (vw - 2) / W));
    const H = Math.max(root.sh + 2 * PAD, (vh - 2) / s1);
    const oy = Math.max(PAD, (H - root.sh) / 2);
    list.forEach((T) => { T.to = { x: T.x, y: T.y + oy, o: 1 }; });

    // where the clicked item is on screen now: it stays there while the map changes around it
    const pin = anchor && anchor.cur ? anchor.cur.y * scale - scroll.scrollTop : null;
    list.forEach((T) => {
      if (T.cur) return;
      T.seen = false;
      const p = T.parent && T.parent.cur;
      T.cur = p ? { x: p.x + T.parent.w + (firstRun ? 0 : GX * 0.35), y: p.y + T.parent.h / 2 - T.h / 2, o: 0 } : { ...T.to, o: T === root ? 1 : 0 };
    });
    list.forEach((T) => { if (T !== root && !wires.has(T)) wires.set(T, svg.appendChild(document.createElementNS(NS, "path"))); });

    // sideways: everything fits, or (at the smallest size) keep the opened item and its new branch in view
    let x1 = 0;
    if (W * s1 > vw) {
      if (anchor && reveal) {
        const kids = anchor.kids || [];
        const right = Math.max(anchor.to.x + anchor.w, ...kids.map((k) => k.to.x + k.w)) * s1 + 20;
        x1 = Math.max(0, Math.min(right - vw, anchor.to.x * s1 - 20));
      } else {
        x1 = Math.min(scroll.scrollLeft, W * s1 - vw);
      }
    }
    const s0 = firstRun ? s1 : scale, x0 = scroll.scrollLeft;
    const wMax = Math.max(size0.w, W), hMax = Math.max(size0.h, H);
    const frame = (e) => {
      scale = s0 + (s1 - s0) * e;
      canvas.style.transform = `scale(${scale.toFixed(4)})`;
      canvas.style.width = `${wMax}px`;
      canvas.style.height = `${hMax}px`;
      sizer.style.width = `${(wMax * scale).toFixed(1)}px`;
      sizer.style.height = `${(hMax * scale).toFixed(1)}px`;
      if (!firstRun) scroll.scrollLeft = x0 + (x1 - x0) * e;
      if (pin != null) scroll.scrollTop = anchor.cur.y * scale - pin;
    };
    if (firstRun) {
      frame(0);
      scroll.scrollTop = (root.to.y + root.h / 2) * scale - vh / 2;
      scroll.scrollLeft = 0;
      firstRun = false;
    }
    tween(list, frame, () => {
      size0 = { w: W, h: H };
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      sizer.style.width = `${(W * s1).toFixed(1)}px`;
      sizer.style.height = `${(H * s1).toFixed(1)}px`;
      if (pin != null) scroll.scrollTop = anchor.cur.y * s1 - pin;
      list.forEach((T) => { T.seen = true; });
      // the branch that just grew: scroll just enough to bring all of it into view, never losing the item that opened it
      if (anchor && reveal && anchor.open && anchor.kids && anchor.kids.length) {
        const ks = anchor.kids.filter((k) => k.to);
        const top = Math.min(anchor.to.y, ...ks.map((k) => k.to.y)) * s1 - 12;
        const bottom = Math.max(anchor.to.y + anchor.h, ...ks.map((k) => k.to.y + k.h)) * s1 + 12;
        const vt = scroll.scrollTop;
        let want = vt;
        if (bottom - top <= vh) want = top < vt ? top : bottom > vt + vh ? bottom - vh : vt;
        else want = Math.min(top, anchor.to.y * s1 - 12);
        if (Math.abs(want - vt) > 2) scroll.scrollTo({ top: want, behavior: reduced() ? "auto" : "smooth" });
      }
    });
  }
  function goAway(T) {
    leaving.add(T);
    T.el.classList.add("is-leaving");
    T.el.inert = true;
    let p = T.parent;
    const now = shown(root);
    while (p && p.parent && !now.includes(p)) p = p.parent;
    T.away = p && p.cur ? { x: p.cur.x + p.w * 0.6, y: p.cur.y + p.h / 2 - T.h / 2, o: 0 } : { ...T.cur, o: 0 };
    if (picked === T) pick(root);
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
  function tween(list, frame, done) {
    cancelAnimationFrame(raf);
    const D = reduced() ? 0 : 360;
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
      frame(e);
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
    // a press on the box's own scrollbars is for the scrollbar, not for dragging the map
    if (e.target === scroll && (e.offsetX >= scroll.clientWidth || e.offsetY >= scroll.clientHeight)) return;
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
  let first = true, lastW = scroll.clientWidth;
  const ro = new ResizeObserver(() => {
    if (first) { first = false; return; }
    if (scroll.clientWidth === lastW) return;
    lastW = scroll.clientWidth;
    layout();
  });
  ro.observe(scroll);
  return {
    root,
    stop() { cancelAnimationFrame(raf); ro.disconnect(); },
    select(id) {
      const find = (T) => (T.data && T.data.id === id && T.el ? T : (T.open && T.kids || []).map(find).find(Boolean));
      const T = id ? find(root) : root;
      if (T) pick(T);
    },
  };
}
