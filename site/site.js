// Copy buttons and the tower of layers (drawn in SVG, the same slabs as the app). No libraries.
(() => {
  // ---- copy the install command (every button copies the same one command)
  const command = document.querySelector("[data-cmd]").textContent.trim();
  const status = document.querySelector("[data-copy-status]");
  const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    const label = btn.querySelector(".label");
    let timer = 0;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
        label.textContent = "Copied";
        status.textContent = `Copied ${command}`;
      } catch {
        const range = document.createRange();
        range.selectNodeContents(btn.closest("[data-install]").querySelector("[data-cmd]"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        label.textContent = mac ? "Press ⌘C" : "Press Ctrl+C";
        status.textContent = `Selected ${command}. ${label.textContent} to copy it.`;
      }
      btn.setAttribute("data-copied", "");
      clearTimeout(timer);
      timer = setTimeout(() => { btn.removeAttribute("data-copied"); label.textContent = "Copy command"; }, 1800);
    });
  });

  // ---- the tower: five equal slabs with rounded tops, floating with air between them.
  // The dots on each top are the real counts of fastapi/full-stack-fastapi-template, the repo in the screenshots.
  const stage = document.querySelector("[data-tower]");
  if (!stage) return;
  const NS = "http://www.w3.org/2000/svg";
  const TINT = ["#EDAE86", "#F5C19C", "#FAD3B5", "#FDE3CD", "#FFF1E3"];   // L0 .. L4
  const COUNT = [653, 160, 36, 29, 7];
  const W = 400, D = 260, R = 20, T = 22, PITCH = 66, LIFT = 80;
  const RZ = -34 * Math.PI / 180, TILT = 56 * Math.PI / 180;
  const cz = Math.cos(RZ), sz = Math.sin(RZ), ct = Math.cos(TILT), st = Math.sin(TILT);
  const proj = (x, y, z) => { const xr = x * cz - y * sz, yr = x * sz + y * cz; return [xr, yr * ct - z * st]; };
  const pts = (list) => list.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, w) => { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v * (1 - w) + B[i] * w)).join(",")})`; };

  // rounded-rectangle outline, clockwise on screen (y grows downward)
  const outline = [];
  const corners = [[W / 2 - R, -(D / 2 - R), -90], [W / 2 - R, D / 2 - R, 0], [-(W / 2 - R), D / 2 - R, 90], [-(W / 2 - R), -(D / 2 - R), 180]];
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= 6; k++) {
    const a = (a0 + k * 15) * Math.PI / 180;
    outline.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  const ring = (z, scale = 1) => outline.map(([x, y]) => proj(x * scale, y * scale, z));

  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const svg = document.createElementNS(NS, "svg");
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e; };
  const blur = el("filter", { id: "soft", x: "-20%", y: "-20%", width: "140%", height: "140%" }, el("defs", {}, svg));
  el("feGaussianBlur", { stdDeviation: "7" }, blur);

  const lifts = [], casts = [];
  for (let lv = 0; lv < 5; lv++) {
    const z0 = lv * PITCH, z1 = z0 + T;
    // the shadow this slab casts on the slab below (on the floor for L0); it stays put when the slab lifts
    const cast = el("g", { class: "cast" }, svg);
    el("polygon", { points: pts(ring(lv ? z0 - PITCH + T : -24, lv ? 0.9 : 1.05)), fill: "rgba(150,76,36,.30)", filter: "url(#soft)" }, cast);
    casts.push(cast);
    const g = el("g", { class: "lift" }, svg);
    lifts.push(g);
    const top = ring(z1), bot = ring(z0);
    // the sides: only the faces turned towards us, shaded by which way they face
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      const [ax, ay] = outline[i], [bx, by] = outline[j];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / len, ny = -(bx - ax) / len;
      const nxr = nx * cz - ny * sz, nyr = nx * sz + ny * cz;
      if (nyr <= 0.02) continue;
      const fill = mix(TINT[lv], "#D2683A", 0.2 + 0.14 * Math.max(0, -nxr));
      el("polygon", { points: pts([top[i], top[j], bot[j], bot[i]]), fill, stroke: fill, "stroke-width": "0.8", "stroke-linejoin": "round" }, g);
    }
    el("polygon", { points: pts(top), fill: TINT[lv], stroke: "rgba(255,255,255,.55)", "stroke-width": "1" }, g);
    const n = COUNT[lv], r = Math.max(1.6, Math.min(9, 60 / Math.sqrt(n)));
    const dg = el("g", { fill: "#40291C", "fill-opacity": lv ? ".42" : ".34" }, g);
    for (let i = 0; i < n; i++) {
      const [x, y] = proj((rand() - 0.5) * (W - 50), (rand() - 0.5) * (D - 44), z1);
      el("ellipse", { cx: x.toFixed(1), cy: y.toFixed(1), rx: r.toFixed(1), ry: (r * ct).toFixed(1) }, dg);
    }
  }
  // fit the drawing, with headroom for the lift
  const all = [...ring(-24, 1.05), ...ring(4 * PITCH + T + LIFT)];
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs) - 16, y0 = Math.min(...ys) - 16, x1 = Math.max(...xs) + 16, y1 = Math.max(...ys) + 24;
  svg.setAttribute("viewBox", `${x0.toFixed(0)} ${y0.toFixed(0)} ${(x1 - x0).toFixed(0)} ${(y1 - y0).toFixed(0)}`);
  stage.append(svg);

  // A layer button lifts the slabs above it and uncovers that layer's map: a click keeps it, hover and focus preview it.
  const buttons = [...document.querySelectorAll("[data-legend] button")];
  let pinned = +(buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.level ?? 2);
  const show = (lv) => lifts.forEach((g, n) => {
    g.style.transform = n > lv ? `translateY(${(-LIFT * st).toFixed(1)}px)` : "";
    casts[n].style.opacity = n === lv + 1 ? ".45" : "";
  });
  buttons.forEach((b) => {
    const lv = +b.dataset.level;
    b.addEventListener("click", () => {
      pinned = lv;
      buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      show(lv);
    });
    b.addEventListener("focus", () => show(lv));
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) b.addEventListener("mouseenter", () => show(lv));
  });
  const list = document.querySelector("[data-legend]");
  list.addEventListener("mouseleave", () => show(pinned));
  list.addEventListener("focusout", (e) => { if (!list.contains(e.relatedTarget)) show(pinned); });
  show(pinned);
})();
