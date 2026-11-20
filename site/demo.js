// The hero demo: the app's mind map opening itself along one real path of fastapi/full-stack-fastapi-template,
// from the repository down to one function. Every name, count, description and line of code is the app's real output.
(() => {
  const frame = document.querySelector("[data-demo]");
  if (!frame) return;
  const view = frame.querySelector(".demo-map"), panel = frame.querySelector(".demo-panel"), pauseBtn = frame.querySelector("[data-pause]");
  const NS = "http://www.w3.org/2000/svg", GX = 64, PAD = 32;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LV = { 4: "L4 Areas", 3: "L3 Components", 2: "L2 Modules", 1: "L1 Files", 0: "L0 Symbols" };

  const n = (label, lv, count, kids, info) => ({ label, lv, count, kids: kids || null, info });
  const syms = [
    n("reset_password()", 0, 0), n("recover_password()", 0, 0),
    n("login_access_token()", 0, 0, null, {
      path: "backend/app/api/routes/login.py:24",
      text: "Authenticates a user by checking their email and password against the database, then returns an OAuth2 access token that expires after a set number of minutes.",
      code: ["def login_access_token(", "    session: SessionDep, form_data: Annotated[OAuth2PasswordRequestForm, Depends()]", ") -> Token:",
        '    """', "    OAuth2 compatible token login, get an access token for future requests", '    """',
        "    user = crud.authenticate(", "        session=session, email=form_data.username, password=form_data.password", "    )"],
      start: 24 }),
    n("recover_password_html_content()", 0, 0), n("test_token()", 0, 0)];
  const files = [n("users.py", 1, 10), n("login.py", 1, 5, syms, { path: "backend/app/api/routes/login.py", text: "5 functions inside. Taken straight from the code." }),
    n("items.py", 1, 5), n("utils.py", 1, 2), n("private.py", 1, 2), n("__init__.py", 1, 0)];
  const mods = [n("routes", 2, 6, files, { path: "backend/app/api/routes", text: "6 files: users.py, login.py, items.py, utils.py, private.py, __init__.py." }), n("api", 2, 3)];
  const comps = [n("Core Application Logic", 3, 1),
    n("Backend API Endpoints", 3, 2, mods, { path: "backend/app/api", text: "Exposes the HTTP routes for user registration, login, password recovery, and item retrieval.", model: true }),
    n("Backend Core Utilities", 3, 1), n("Database Migration Scripts", 3, 2)];
  const areas = [
    n("Backend Application Core", 4, 4, comps, { path: "backend/app", text: "Contains the main API logic, database models, and utility scripts that power the server-side functionality.", model: true }),
    n("Frontend User Interface", 4, 14), n("Git Hook Configuration", 4, 1), n("Email Template Library", 4, 2),
    n("Automated Test Suite", 4, 6), n("Development Tooling Scripts", 4, 2), n("External libraries", 4, 0)];
  const root = { label: "fastapi/full-stack-fastapi-template", root: true, kids: areas, open: true,
    info: { path: "github.com/fastapi/full-stack-fastapi-template", text: "7 areas · 29 components · 36 modules · 160 files · 653 functions and classes." } };
  const path = [areas[0], comps[1], mods[0], files[1]];
  const target = syms[2];
  const all = [];
  (function link(t, parent) { t.parent = parent; all.push(t); (t.kids || []).forEach((k) => link(k, t)); })(root, null);

  // ---- elements
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "mm-wires");
  const canvas = document.createElement("div");
  canvas.className = "mm-canvas";
  canvas.append(svg);
  view.append(canvas);
  const chev = '<span class="mm-chev"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 7l5 5-5 5"/></svg></span>';
  for (const t of all) {
    const e = document.createElement("div");
    if (t.root) {
      e.className = "mm-node is-root";
      e.innerHTML = `<span class="mm-t"></span><span class="mm-sub">Repository</span>`;
    } else {
      e.className = "mm-node is-item";
      e.style.setProperty("--tint", `var(--l${t.lv})`);
      e.innerHTML = `<span class="mm-t${t.lv <= 1 ? " mono" : ""}"><i class="mm-dot"></i><span></span></span>` + (t.count ? `<span class="mm-open"><span class="mm-count">${t.count}</span>${chev}</span>` : "");
    }
    (t.root ? e.querySelector(".mm-t") : e.querySelector(".mm-t > span")).textContent = t.label;
    t.el = e;
    canvas.append(e);
    if (t.parent) { t.wire = document.createElementNS(NS, "path"); svg.append(t.wire); }
  }

  // ---- layout (the app's own: children to the right, the parent centred on them)
  const kidsOf = (t) => (t.open && t.kids ? t.kids : []);
  const gap = (a, b) => ((a.open && a.kids) || (b && b.open && b.kids) ? 16 : 8);
  function size(t) {
    const k = kidsOf(t);
    if (!k.length) return (t.sh = t.h);
    let s = 0;
    k.forEach((c, i) => { s += size(c) + (i ? gap(k[i - 1], c) : 0); });
    return (t.sh = Math.max(t.h, s));
  }
  function place(t, x, top) {
    t.x = x;
    const k = kidsOf(t);
    if (!k.length) { t.y = top + (t.sh - t.h) / 2; return; }
    let s = 0;
    k.forEach((c, i) => { s += c.sh + (i ? gap(k[i - 1], c) : 0); });
    let y = top + (t.sh - s) / 2;
    k.forEach((c, i) => { if (i) y += gap(k[i - 1], c); place(c, x + t.w + GX, y); y += c.sh; });
    t.y = (k[0].y + k[0].h / 2 + k[k.length - 1].y + k[k.length - 1].h / 2) / 2 - t.h / 2;
  }
  const visible = (t, out = []) => { out.push(t); kidsOf(t).forEach((k) => visible(k, out)); return out; };
  function measure() { for (const t of all) { t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; } }

  // the camera keeps the item that just opened, and its children, in the middle of the frame
  let cam = { x: 0, y: 0 };
  function aim(focus) {
    const vw = view.clientWidth, vh = view.clientHeight;
    const k = kidsOf(focus);
    const top = Math.min(focus.y, ...k.map((c) => c.y)), bottom = Math.max(focus.y + focus.h, ...k.map((c) => c.y + c.h));
    const right = Math.max(focus.x + focus.w, ...k.map((c) => c.x + c.w));
    const x = Math.max(0, Math.min(focus.x - PAD - Math.max(0, vw * 0.06), right + PAD - vw));
    // the opening view: the repository on the left, its areas in view (on a phone that means the root is partly off-frame)
    const rootX = Math.max(0, focus.x + focus.w + GX - vw * 0.5);
    return { x: focus.root ? rootX : Math.max(0, x), y: (top + bottom) / 2 - vh / 2 };
  }

  let raf = 0;
  function tween(focus, D, done) {
    const list = visible(root);
    size(root);
    place(root, PAD, 0);
    const from = new Map(all.map((t) => [t, t.cur ? { ...t.cur } : null]));
    for (const t of all) {
      const on = list.includes(t);
      const p = t.parent;
      if (!t.cur) t.cur = p && p.cur ? { x: p.cur.x + p.w, y: p.cur.y + p.h / 2 - t.h / 2, o: 0 } : { x: t.x, y: t.y, o: 0 };
      t.to = on ? { x: t.x, y: t.y, o: 1 } : p && p.to ? { x: p.to.x + p.w * 0.6, y: p.to.y + p.h / 2 - t.h / 2, o: 0 } : { ...t.cur, o: 0 };
      if (!from.get(t)) from.set(t, { ...t.cur });
    }
    const c0 = { ...cam }, c1 = aim(focus);
    const t0 = performance.now();
    cancelAnimationFrame(raf);
    const step = (now) => {
      const k = D ? Math.min(1, (now - t0) / D) : 1, e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      for (const t of all) {
        const a = from.get(t), b = t.to;
        t.cur = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, o: a.o + (b.o - a.o) * e };
        t.el.style.transform = `translate(${t.cur.x.toFixed(1)}px, ${t.cur.y.toFixed(1)}px)`;
        t.el.style.opacity = t.cur.o.toFixed(3);
        t.el.style.visibility = t.cur.o < 0.01 ? "hidden" : "";
      }
      for (const t of all) if (t.wire) {
        const p = t.parent, x1 = p.cur.x + p.w, y1 = p.cur.y + p.h / 2, x2 = t.cur.x, y2 = t.cur.y + t.h / 2, dx = Math.max(14, (x2 - x1) / 2);
        t.wire.setAttribute("d", `M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`);
        t.wire.style.opacity = Math.min(t.cur.o, p.cur.o).toFixed(3);
      }
      cam = { x: c0.x + (c1.x - c0.x) * e, y: c0.y + (c1.y - c0.y) * e };
      canvas.style.transform = `translate(${(-cam.x).toFixed(1)}px, ${(-cam.y).toFixed(1)}px)`;
      if (k < 1) raf = requestAnimationFrame(step); else if (done) done();
    };
    raf = requestAnimationFrame(step);
  }

  // ---- the panel beside the map shows what the last opened item is
  function show(t) {
    const i = t.info;
    const tag = t.root ? "Repository" : LV[t.lv];
    panel.innerHTML = `<p class="dp-tag"${t.root ? "" : ` style="--tint: var(--l${t.lv})"`}>${tag}</p><p class="dp-name${t.lv <= 1 ? " mono" : ""}"></p><p class="dp-path mono"></p><p class="dp-text"></p>`
      + (i.model ? '<p class="dp-note">Named and described by your model</p>' : "")
      + (i.code ? `<pre class="dp-code"><code>${i.code.map((l, k) => `<span><i>${i.start + k}</i>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join("")}</code></pre>` : "");
    panel.querySelector(".dp-name").textContent = t.label;
    panel.querySelector(".dp-path").textContent = i.path;
    panel.querySelector(".dp-text").textContent = i.text;
    if (!reduced) panel.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.23,1,.32,1)" });
  }
  function hot(on) {
    target.el.classList.toggle("is-hot", on);
    for (let t = target; t.parent; t = t.parent) t.wire.classList.toggle("is-hot", on);
  }

  // ---- the script: open one item at a time, rest on the function, then start again
  let i = 0, timer = 0, running = !reduced, inView = true;
  const press = (t) => { const b = t.el.querySelector(".mm-open"); if (b) { b.classList.add("is-press"); setTimeout(() => b.classList.remove("is-press"), 180); } };
  function next() {
    clearTimeout(timer);
    if (i < path.length) {
      const t = path[i++];
      press(t);
      setTimeout(() => {
        t.open = true;
        t.el.querySelector(".mm-open").classList.add("is-open");
        show(t);
        tween(t, 720);
      }, 200);
      timer = setTimeout(tick, 2300);
    } else if (i === path.length) {
      i++;
      hot(true);
      show(target);
      timer = setTimeout(tick, 4200);
    } else {
      i = 0;
      hot(false);
      path.forEach((t) => { t.open = false; t.el.querySelector(".mm-open").classList.remove("is-open"); });
      show(root);
      tween(root, 720);
      timer = setTimeout(tick, 2000);
    }
  }
  function tick() { if (running && inView && !document.hidden) next(); else timer = setTimeout(tick, 400); }

  measure();
  if (reduced) {
    // a finished still: the whole path open, resting on the function
    path.forEach((t) => { t.open = true; t.el.querySelector(".mm-open").classList.add("is-open"); });
    tween(path[path.length - 1], 0);
    hot(true);
    show(target);
    if (pauseBtn) pauseBtn.hidden = true;
  } else {
    show(root);
    tween(root, 0);
    timer = setTimeout(tick, 1400);
    new IntersectionObserver((es) => { inView = es[0].isIntersecting; }).observe(frame);
  }
  pauseBtn && pauseBtn.addEventListener("click", () => {
    running = !running;
    pauseBtn.setAttribute("aria-pressed", String(!running));
    pauseBtn.setAttribute("aria-label", running ? "Pause the demo" : "Play the demo");
    pauseBtn.querySelector("span").textContent = running ? "Pause" : "Play";
    pauseBtn.querySelector("svg").innerHTML = running
      ? '<path d="M8 6v12M16 6v12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
      : '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>';
  });
  let rw = view.clientWidth;
  new ResizeObserver(() => {
    if (view.clientWidth === rw) return;
    rw = view.clientWidth;
    measure();
    const open = [...path].reverse().find((t) => t.open) || root;
    tween(open, 0);
  }).observe(view);
})();
