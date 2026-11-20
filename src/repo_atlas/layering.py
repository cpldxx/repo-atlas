"""Turn a Graphify graph.json into five abstraction levels.

    L0 symbol     functions, methods, classes (Graphify's AST pass, unchanged)
    L1 file       source files
    L2 module     directories
    L3 component  groups of directories (a directory-tree split)
    L4 area       top-level parts of the repo, plus one node for external libraries

L0-L2 are facts read straight from the code. L3-L4 are a grouping heuristic, so
callers should present them as an interpretation.

Arrows at every level are real: an edge A -> B at level N exists only because
some symbol or file inside A calls or uses something inside B.
"""
from __future__ import annotations

import os
import re
from collections import Counter, defaultdict

import networkx as nx

CODE_EXT = {
    ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs", ".java",
    ".kt", ".kts", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift",
    ".scala", ".m", ".mm", ".lua", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".zig",
    ".sh", ".bash", ".vue", ".svelte", ".r", ".jl", ".pl", ".sql",
}
TEST_SEG = {"tests", "test", "__tests__", "spec", "specs", "e2e", "testing", "__mocks__", "fixtures"}
EXAMPLE_SEG = {
    "examples", "example", "samples", "sample", "demo", "demos", "docs", "doc",
    "tutorial", "tutorials", "benchmarks", "benchmark",
}
TOOL_SEG = {"scripts", "script", "tools", "tool", ".github", "ci", "build", "hack", "bin", ".circleci", "devtools"}
ROLE_LABEL = {"tests": "tests", "examples": "examples & docs", "tooling": "tooling"}

# Graphify relation -> our two kinds of dependency.
FLOW = {
    "calls": "calls", "indirect_call": "calls",
    "uses": "uses", "references": "uses", "inherits": "uses", "extends": "uses",
    "imports": "uses", "imports_from": "uses",
}
EXTERNAL = "a:external"
TEST_FILE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test|[^/]*\.(test|spec))\.[a-z]+$", re.I)


def _line(loc: str | None) -> int | None:
    m = re.match(r"L(\d+)", loc or "")
    return int(m.group(1)) if m else None


def role_of(dir_path: str) -> str:
    """tests can sit anywhere; examples and tooling only count near the top of the tree."""
    segs = [s.lower() for s in dir_path.split("/") if s and s != "."]
    if set(segs) & TEST_SEG:
        return "tests"
    head = set(segs[:2])
    if head & EXAMPLE_SEG:
        return "examples"
    if head & TOOL_SEG or (segs and segs[0].startswith(".")):
        return "tooling"
    return "app"


def _lca(dirs: list[str]) -> str:
    parts = [d.split("/") if d != "." else [] for d in dirs]
    pre = os.path.commonprefix(parts) if parts else []
    return "/".join(pre) or "."


def split_components(dirs: dict[str, int], tmin: int, tmax: int, cap: int = 14) -> list[dict]:
    """Cut a set of module directories into components along the directory tree.

    `dirs` maps a module directory to its file count. Returns items
    {dir, kind, members} where kind is 'tree' (a whole subtree), 'direct'
    (only the files directly in `dir`) or 'bucket' (several small siblings).
    Keeps splitting the biggest subtree until there are at least `tmin`
    components and none holds more than half the files (up to `tmax`).
    """
    total = sum(dirs.values()) or 1

    def size(it: dict) -> int:
        return sum(dirs[m] for m in it["members"])

    def parts_of(it: dict) -> list[dict]:
        d = it["dir"]
        kids: dict[str, list[str]] = defaultdict(list)
        direct: list[str] = []
        for m in it["members"]:
            if m == d:
                direct.append(m)
                continue
            rest = m if d == "." else m[len(d) + 1:]
            head = rest.split("/")[0]
            kids[head if d == "." else f"{d}/{head}"].append(m)
        parts = [{"dir": k, "kind": "tree", "members": v} for k, v in sorted(kids.items())]
        if direct:
            parts.append({"dir": d, "kind": "direct", "members": direct})
        return parts

    def descend(it: dict) -> dict:
        while it["kind"] == "tree":
            p = parts_of(it)
            if len(p) != 1:
                break
            it = p[0]
        return it

    cut = [descend({"dir": _lca(list(dirs)), "kind": "tree", "members": sorted(dirs)})]
    while True:
        n = len(cut)
        big = max(cut, key=size)
        need = n < tmin or (size(big) > 0.5 * total and n < tmax)
        trees = [it for it in cut if it["kind"] == "tree"]
        if not need or not trees:
            break
        it = max(trees, key=size)
        if n >= tmin and it is not big:
            break
        parts = [descend(p) for p in parts_of(it)]
        room = cap - (n - 1)
        if len(parts) > room:
            parts.sort(key=size, reverse=True)
            keep = max(room - 1, 1)
            rest = parts[keep:]
            parts = parts[:keep] + [
                {"dir": it["dir"], "kind": "bucket", "members": [m for p in rest for m in p["members"]]}
            ]
        cut.remove(it)
        cut.extend(parts)
    return cut


def _rank(ids: list[str], weights: dict[tuple[str, str], int]) -> dict[str, int]:
    """Left-to-right column for each node: callers sit left of what they call.

    Edges between different cycles-groups are always kept. Only inside a real
    cycle (A calls B calls A) is an edge dropped, and then the one that runs
    against the dominant direction: each node is scored by how much it is
    called versus how much it calls (0 = only calls others, 1 = only gets
    called). What is left has no cycles and is layered by longest path.
    """
    keep = set(ids)
    inw: Counter = Counter()
    outw: Counter = Counter()
    pairs = [(a, b, w) for (a, b), w in weights.items() if a in keep and b in keep and a != b]
    for a, b, w in pairs:
        outw[a] += w
        inw[b] += w
    key = {n: ((inw[n] / (inw[n] + outw[n])) if inw[n] + outw[n] else 0.0, n) for n in ids}
    full = nx.DiGraph()
    full.add_nodes_from(ids)
    full.add_edges_from((a, b) for a, b, _ in pairs)
    group = {n: i for i, comp in enumerate(nx.strongly_connected_components(full)) for n in comp}
    g = nx.DiGraph()
    g.add_nodes_from(ids)
    g.add_edges_from((a, b) for a, b, _ in pairs if group[a] != group[b] or key[a] < key[b])
    r: dict[str, int] = {}
    for n in nx.topological_sort(g):
        r[n] = max((r[p] + 1 for p in g.predecessors(n)), default=0)
    return r


def build(graph: dict) -> dict:
    """Return {'nodes': [...], 'edges': [...], 'stats': {...}} for a Graphify graph."""
    gnodes = {n["id"]: n for n in graph.get("nodes", [])}
    links = graph.get("links") or graph.get("edges") or []

    fileset = sorted({
        n["source_file"] for n in gnodes.values()
        if n.get("file_type") == "code" and n.get("source_file")
        and os.path.splitext(n["source_file"])[1].lower() in CODE_EXT
    })
    files = set(fileset)

    sym = {
        gid: n for gid, n in gnodes.items()
        if n.get("file_type") == "code" and n.get("source_file") in files
        and n.get("type") != "package" and (n.get("_callable") or n.get("_callable_class"))
    }

    def home(gid: str) -> str | None:
        n = gnodes.get(gid)
        if n is None:
            return None
        if gid in sym:
            return "s:" + gid
        if n.get("external") or n.get("type") == "external":
            return EXTERNAL
        if n.get("file_type") == "code" and n.get("source_file") in files:
            return "f:" + n["source_file"]
        return None

    owner: dict[str, str] = {}
    doc: dict[str, str] = {}
    for e in links:
        rel, s, t = e.get("relation"), e.get("source"), e.get("target")
        if rel in ("method", "contains") and s in sym and t in sym:
            owner.setdefault(t, s)
        elif rel == "rationale_for" and t in sym and s in gnodes:
            doc.setdefault(t, gnodes[s].get("label") or "")

    nodes: dict[str, dict] = {}

    def mk(id_, level, kind, label, parent, path, **kw):
        nodes[id_] = {
            "id": id_, "level": level, "kind": kind, "label": label, "parent": parent, "path": path,
            "line": None, "end_line": None, "role": "app", "title": None, "summary": None, "doc": None,
            "rank": 0, "flow": 0.0, "deg_in": 0, "deg_out": 0, "children": 0, "entry": False, "meta": {},
            **kw,
        }
        return nodes[id_]

    # ---- L1 files, L2 modules -------------------------------------------------
    mod_files: dict[str, int] = Counter()
    for p in fileset:
        d = os.path.dirname(p) or "."
        mod_files[d] += 1
        f = mk("f:" + p, 1, "file", os.path.basename(p), "m:" + d, p)
        if TEST_FILE.search(p):
            f["meta"]["is_test"] = True
    for d in mod_files:
        mk("m:" + d, 2, "module", "(root)" if d == "." else d.split("/")[-1], None, d)

    # ---- L0 symbols -----------------------------------------------------------
    by_file: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for gid, n in sym.items():
        label = (n.get("label") or gid).strip()
        own = owner.get(gid)
        kind = "class" if n.get("_callable_class") else "function"
        if own:
            label = f"{(gnodes[own].get('label') or '').rstrip('()')}.{label.lstrip('.')}"
            if gnodes[own].get("_callable_class") and kind == "function":
                kind = "method"
        s = mk("s:" + gid, 0, kind, label, "f:" + n["source_file"], n["source_file"])
        s["line"] = _line(n.get("source_location"))
        s["doc"] = doc.get(gid) or None
        if own:
            s["meta"]["owner"] = "s:" + own
        if s["line"]:
            by_file[n["source_file"]].append((s["line"], s["id"]))
    for sid, n in list(nodes.items()):
        own = n["meta"].get("owner")
        if own in nodes:
            nodes[own]["meta"].setdefault("members", []).append(sid)
    for items in by_file.values():
        items.sort()
        for (ln, sid), nxt in zip(items, items[1:] + [(None, None)]):
            if nxt[0] and nxt[0] > ln:
                nodes[sid]["end_line"] = nxt[0] - 1

    # ---- L4 areas, L3 components ---------------------------------------------
    area_mods: dict[str, dict[str, int]] = defaultdict(dict)
    area_info: dict[str, tuple[str, str]] = {}
    for d, cnt in mod_files.items():
        role = role_of(d)
        if role == "app":
            top = d.split("/")[0]
            aid, label = "a:app:" + top, ("root files" if top == "." else top)
        else:
            aid, label = "a:" + role, ROLE_LABEL[role]
        area_mods[aid][d] = cnt
        area_info[aid] = (role, label)

    app_areas = sorted((a for a in area_mods if area_info[a][0] == "app"), key=lambda a: -sum(area_mods[a].values()))
    if len(app_areas) > 6:
        for aid in app_areas[5:]:
            area_mods["a:app:*"].update(area_mods.pop(aid))
            area_info.pop(aid)
        area_info["a:app:*"] = ("app", "other folders")

    for aid, mods in area_mods.items():
        role, label = area_info[aid]
        mk(aid, 4, "area", label, None, _lca(list(mods)))["role"] = role
        n_files = sum(mods.values())
        if role == "app":
            tmin = 1 if n_files < 8 else min(8, max(2, n_files // 15))
            tmax = min(12, max(tmin, n_files // 6))
        else:
            tmin, tmax = 1, 3
        for it in split_components(mods, tmin, tmax):
            prefix = "c:" if role == "app" else f"c:{role}:"
            cid = prefix + it["dir"] + ("/*" if it["kind"] == "bucket" else "")
            folders = {m.split("/")[len(it["dir"].split("/")) if it["dir"] != "." else 0] for m in it["members"] if m != it["dir"]}
            clabel = "root files" if it["dir"] == "." and it["kind"] != "bucket" else "/".join(it["dir"].split("/")[-2:])
            if it["kind"] == "bucket":
                clabel = f"{'' if it['dir'] == '.' else it['dir'] + '/'}… ({len(folders)} folders)"
            c = mk(cid, 3, "component", clabel, aid, it["dir"])
            c["role"] = role
            c["meta"]["split"] = it["kind"]
            for m in it["members"]:
                nodes["m:" + m]["parent"] = cid

    ext = mk(EXTERNAL, 4, "external", "external libraries", None, "")
    ext["role"] = "external"

    # ---- ancestors, roles -----------------------------------------------------
    chain: dict[str, list[str | None]] = {}
    for nid, n in nodes.items():
        c: list[str | None] = [None] * 5
        cur: dict | None = n
        while cur is not None:
            c[cur["level"]] = cur["id"]
            cur = nodes.get(cur["parent"]) if cur["parent"] else None
        chain[nid] = c
        n["anc"] = c
        if c[4]:
            n["role"] = nodes[c[4]]["role"]
    for n in nodes.values():
        if n["parent"]:
            nodes[n["parent"]]["children"] += 1

    # ---- edges at every level -------------------------------------------------
    agg: list[dict[tuple[str, str], Counter]] = [defaultdict(Counter) for _ in range(5)]
    ext_use: Counter = Counter()
    for e in links:
        kind = FLOW.get(e.get("relation"))
        if not kind:
            continue
        a, b = home(e.get("source")), home(e.get("target"))
        if not a or not b or a == EXTERNAL:
            continue
        if b == EXTERNAL:
            name = (gnodes[e["target"]].get("label") or e["target"]).removeprefix("ref_")
            if name.count("_") <= 2:  # longer ones are Graphify ids of unresolved internal paths, not packages
                ext_use[name] += 1
            agg[4][(chain[a][4], EXTERNAL)][kind] += 1
            continue
        for lv in range(5):
            x, y = chain[a][lv], chain[b][lv]
            if x and y and x != y:
                agg[lv][(x, y)][kind] += 1
    ext["meta"]["top"] = [{"name": k, "uses": v} for k, v in ext_use.most_common(20)]

    edges = []
    for lv in range(5):
        for (a, b), c in agg[lv].items():
            w = c["calls"] + c["uses"]
            edges.append({"level": lv, "src": a, "dst": b, "calls": c["calls"], "uses": c["uses"], "weight": w})
            nodes[a]["deg_out"] += w
            nodes[b]["deg_in"] += w

    # ---- left-to-right rank, per level, app code first ------------------------
    for lv in range(5):
        weights = {k: c["calls"] + c["uses"] for k, c in agg[lv].items()}
        at = [n for n in nodes.values() if n["level"] == lv]
        for group in ("app", "tests", "examples", "tooling"):
            ids = [n["id"] for n in at if n["role"] == group]
            if not ids:
                continue
            r = _rank(ids, weights)
            top = max(r.values()) or 1
            inside = set(ids)
            has_in = {b for a, b in weights if a in inside and b in inside}
            for nid in ids:
                nodes[nid]["rank"] = r[nid]
                nodes[nid]["flow"] = round(r[nid] / top, 4)
                nodes[nid]["entry"] = nid not in has_in and nodes[nid]["deg_out"] > 0
    app_top = max((n["rank"] for n in nodes.values() if n["level"] == 4 and n["role"] == "app"), default=0)
    ext["rank"], ext["flow"] = app_top + 1, 1.0

    langs = Counter(os.path.splitext(p)[1].lower() for p in fileset)
    stats = {
        "levels": {str(lv): sum(1 for n in nodes.values() if n["level"] == lv) for lv in range(5)},
        "edges": {str(lv): len(agg[lv]) for lv in range(5)},
        "languages": dict(langs.most_common(8)),
        "external": ext["meta"]["top"][:10],
        "graphify": {"nodes": len(gnodes), "links": len(links), "version": (graph.get("graph") or {}).get("graphify_version")},
    }
    return {"nodes": list(nodes.values()), "edges": edges, "stats": stats}
