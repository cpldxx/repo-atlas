"""Read side: overview, one layer, the focus map around one node, node detail, the reading-order tour."""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from . import config, store

ROLE_ORDER = {"app": 0, "tests": 1, "examples": 2, "tooling": 3, "external": 4}
CARD = ("id level kind role label title summary doc parent path line end_line rank flow "
        "deg_in deg_out children entry").split()


def card(n: dict) -> dict:
    c = {k: n.get(k) for k in CARD}
    if n.get("meta", {}).get("is_test"):
        c["is_test"] = True
    return c


def _flow(e: dict, level: int) -> dict:
    return {"source": e["src"], "target": e["dst"], "kind": "flow", "level": level,
            "weight": e["weight"], "calls": e["calls"], "uses": e["uses"]}


def github_url(repo: dict, n: dict) -> str | None:
    if not repo.get("url") or not repo.get("commit_sha") or n["kind"] == "external":
        return None
    base, sha, path = repo["url"], repo["commit_sha"], (n.get("path") or "")
    if n["level"] <= 1:
        anchor = ""
        if n["level"] == 0 and n.get("line"):
            anchor = f"#L{n['line']}" + (f"-L{n['end_line']}" if n.get("end_line") else "")
        return f"{base}/blob/{sha}/{path}{anchor}"
    return f"{base}/tree/{sha}/{'' if path in ('.', '') else path}".rstrip("/")


@lru_cache(maxsize=512)
def _lines(path: str, mtime: float) -> tuple[str, ...]:
    return tuple(Path(path).read_text(errors="replace").splitlines())


def _block_end(lines: tuple[str, ...], start: int) -> int:
    """Last line of the definition starting at `start` (1-based) when the graph has no end line for it: the line
    before the next one indented no deeper than the definition itself (closing brackets excepted)."""
    first = lines[start - 1] if 0 < start <= len(lines) else ""
    indent = len(first) - len(first.lstrip())
    end = start
    for i in range(start, len(lines)):
        text = lines[i]
        if text.strip() and len(text) - len(text.lstrip()) <= indent and not text.lstrip().startswith((")", "]", "}")):
            break
        if text.strip():
            end = i + 1
    return end


def _source_lines(rid: str, n: dict) -> tuple[str, ...]:
    if not n.get("path"):
        return ()
    src = config.repo_paths(rid)[0].resolve()
    p = (src / n["path"]).resolve()
    if src not in p.parents or not p.is_file():
        return ()
    return _lines(str(p), p.stat().st_mtime)


def top_level(rid: str, n: dict, max_lines: int = 60) -> str:
    """A file's statements outside any function or class (imports, settings, wiring like include_router(...)),
    which no symbol in the graph covers but which often answer "where is X set up"."""
    out: list[str] = []
    inside = False
    for line in _source_lines(rid, n):
        if not line.strip():
            continue
        if line[0] not in " \t)]}":
            first = line.split("(")[0].split()   # empty for a line that opens with "(", like `(async () => {`
            word = first[0] if first else ""
            inside = word in ("def", "async", "class", "function", "export") and ("def " in line or "class " in line or "function " in line)
            if not inside and not line.startswith("@"):
                out.append(line)
        elif not inside and out:
            out.append(line)   # the rest of a statement that spans lines
        if len(out) >= max_lines:
            break
    return "\n".join(out)


_CONST = re.compile(r"^(?:export\s+)?(?:const\s+|let\s+|var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*(\S.{0,100})$")


def _depth(text: str) -> int:
    """How many brackets a line leaves open, not counting the ones inside quoted strings."""
    bare = re.sub(r"\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'", "", text)
    return sum(bare.count(o) for o in "([{") - sum(bare.count(c) for c in ")]}")


def constants_used(rid: str, n: dict, code: str, limit: int = 6) -> list[str]:
    """Top-level constants of the symbol's file that its code refers to (`ALGORITHM = "HS256"`), so an answer can
    give the value instead of guessing it."""
    found: list[str] = []
    names: set[str] = set()
    lines = _source_lines(rid, n)
    for i, line in enumerate(lines):
        if not line or line[0] in " \t" or line.lstrip().startswith(("def ", "class ", "import ", "from ", "#", "//")):
            continue
        m = _CONST.match(line.rstrip())
        if not m or m.group(1) in names or not re.search(r"\b" + re.escape(m.group(1)) + r"\b", code):
            continue
        # a value written over several lines (`x = Thing(\n  a,\n  b,\n)`) is joined into one
        text, j = line.strip(), i
        depth = _depth(text)
        while depth > 0 and j + 1 < len(lines) and j - i < 8:
            j += 1
            part = lines[j].strip()
            text += ("" if text.endswith(("(", "[", "{")) else " ") + part
            depth += _depth(part)
        names.add(m.group(1))
        found.append(text if len(text) <= 220 else text[:217] + "...")
        if len(found) >= limit:
            break
    return found


def snippet(rid: str, n: dict, max_lines: int = 80) -> dict | None:
    """The code behind a symbol or the top of a file, read from the local clone."""
    if n["level"] > 1 or not n.get("path"):
        return None
    src = config.repo_paths(rid)[0].resolve()
    p = (src / n["path"]).resolve()
    if src not in p.parents or not p.is_file():
        return None
    lines = _lines(str(p), p.stat().st_mtime)
    if n["level"] == 0:
        start = n.get("line") or 1
        # the stored end line is where the next symbol starts, so a class would stop before its own methods
        known = (n.get("end_line") or 0) > start and n.get("kind") != "class"
        last = n["end_line"] if known else _block_end(lines, start)
        end = min(last, start + max_lines - 1, len(lines))
        whole = last <= end
    else:
        start, end = 1, min(len(lines), max_lines)
        whole = len(lines) <= max_lines
    return {"start": start, "end": end, "total": len(lines), "truncated": not whole,
            "text": "\n".join(lines[start - 1:end])}


def overview(rid: str) -> dict | None:
    repo = store.repo(rid)
    if not repo:
        return None
    layers = []
    for lv in range(4, -1, -1):
        layers.append({"level": lv, "name": config.LEVEL_NAMES[lv], "count": store.count_at(rid, lv)})
    return {"repo": repo, "layers": layers}


def layer(rid: str, level: int, limit: int = 300, offset: int = 0, under: str | None = None) -> dict | None:
    """One layer as a flat 2D map: its nodes (most connected first when cut off) and the arrows among them."""
    if not store.repo(rid) or level not in config.LEVEL_NAMES:
        return None
    under_level = None
    if under:
        owner = store.node(rid, under)
        if not owner or owner["level"] <= level:
            return None
        under_level = owner["level"]
    total = store.count_at(rid, level, under, under_level)
    nodes = store.nodes_at(rid, level, under=under, under_level=under_level, limit=limit, offset=offset)
    nodes.sort(key=lambda n: (ROLE_ORDER.get(n["role"], 9), n["rank"], -(n["deg_in"] + n["deg_out"]), n["id"]))
    ids = [n["id"] for n in nodes]
    parents = store.nodes_by_ids(rid, sorted({n["parent"] for n in nodes if n["parent"]}))
    return {
        "level": level, "name": config.LEVEL_NAMES[level], "total": total, "offset": offset,
        "nodes": [card(n) for n in nodes],
        "links": [_flow(e, level) for e in store.edges_among(rid, level, ids)],
        "groups": [card(p) for p in parents],
    }


def focus(rid: str, nid: str, cap: int = 18, cross: int = 8) -> dict | None:
    """Everything connected to one node, level by level, for the mind map.

    Above the node: what contains it. At its own level: who calls it and what it
    calls. Below: what is inside it, plus, at each lower level, the strongest
    connections that cross its boundary. Every link returned has both ends in
    the result, so the map can always draw it.
    """
    node = store.node(rid, nid)
    if not node:
        return None
    L = node["level"]
    items: dict[str, dict] = {}

    def add(n: dict, relation: str, weight: int | None = None) -> None:
        cur = items.get(n["id"])
        if cur:
            if {cur["relation"], relation} == {"caller", "callee"}:
                cur["relation"] = "both"
            if weight:
                cur["weight"] = cur.get("weight", 0) + weight
            return
        c = card(n)
        c["relation"] = relation
        if weight:
            c["weight"] = weight
        items[n["id"]] = c

    add(node, "self")
    cur = node
    while cur and cur["parent"]:
        cur = store.node(rid, cur["parent"])
        if cur:
            add(cur, "ancestor")

    totals: dict[int, int] = {}
    links: list[dict] = []
    for lv in range(L, -1, -1):
        if lv < L:
            totals[lv] = store.count_at(rid, lv, nid, L)
            for n in store.nodes_at(rid, lv, under=nid, under_level=L, limit=cap):
                add(n, "descendant")
        cin = store.crossing(rid, lv, nid, L, "in", cross)
        cout = store.crossing(rid, lv, nid, L, "out", cross)
        need = {e[k] for e in cin + cout for k in ("src", "dst")} - set(items)
        got = {n["id"]: n for n in store.nodes_by_ids(rid, sorted(need))}
        for e in cin:
            if e["dst"] in got:
                add(got[e["dst"]], "descendant")
            if e["src"] in got or e["src"] in items:
                add(got.get(e["src"]) or items[e["src"]], "caller", e["weight"])
        for e in cout:
            if e["src"] in got:
                add(got[e["src"]], "descendant")
            if e["dst"] in got or e["dst"] in items:
                add(got.get(e["dst"]) or items[e["dst"]], "callee", e["weight"])
        links += [_flow(e, lv) for e in cin + cout if e["src"] in items and e["dst"] in items]
        if lv < L:
            inner = [i for i, c in items.items() if c["level"] == lv and c["relation"] == "descendant"]
            links += [_flow(e, lv) for e in store.edges_among(rid, lv, inner, limit=40)]

    for c in items.values():
        if c["parent"] in items and c["relation"] in ("self", "ancestor", "descendant"):
            links.append({"source": c["parent"], "target": c["id"], "kind": "contains", "level": c["level"]})

    side = {"caller": 0, "self": 1, "ancestor": 1, "descendant": 1, "both": 1, "callee": 2}
    levels = []
    for lv in range(4, -1, -1):
        row = [c for c in items.values() if c["level"] == lv]
        row.sort(key=lambda c: (side[c["relation"]], c["rank"], -(c["deg_in"] + c["deg_out"]), c["id"]))
        levels.append({"level": lv, "name": config.LEVEL_NAMES[lv], "total": totals.get(lv), "items": row})
    seen = set()
    uniq = []
    for l in links:
        key = (l["source"], l["target"], l["kind"])
        if key not in seen:
            seen.add(key)
            uniq.append(l)
    return {"node": card(node), "levels": levels, "links": uniq}


BRANCHES = ("inside", "calls", "callers")


def _name_key(n: dict) -> str:
    return (n.get("title") or n.get("label") or "").strip().lower().rstrip("/").split("/")[-1]


def _through(rid: str, n: dict) -> dict:
    """Step through parts that only repeat themselves: an area whose one component has the same name, a component
    whose one folder has the same name. Opening the outer one shows what is inside the last of them."""
    for _ in range(4):
        if (n.get("children") or 0) != 1:
            break
        kids = store.children(rid, n["id"])
        if len(kids) != 1 or _name_key(kids[0]) != _name_key(n):
            break
        n = kids[0]
    return n


def branch(rid: str, nid: str | None, rel: str, limit: int = 12, offset: int = 0) -> dict | None:
    """One branch of the mind map: what is inside a node, what it calls, or what calls it.

    With no node, "inside" is the repository's top level (the L4 areas). Every item carries how many
    things are inside it, it calls and call it, so the map knows which items can be opened further.
    """
    if not store.repo(rid) or rel not in BRANCHES:
        return None
    node = store.node(rid, nid) if nid else None
    if nid and not node:
        return None
    weights: dict[str, int] = {}
    if rel == "inside":
        if node:
            kids = store.children(rid, _through(rid, node)["id"])
        else:
            kids = store.nodes_at(rid, 4)
            kids.sort(key=lambda n: (ROLE_ORDER.get(n["role"], 9), -(n["deg_in"] + n["deg_out"]), n["id"]))
        total, page = len(kids), kids[offset:offset + limit]
    else:
        if not node:
            return None
        inc, out = store.neighbors(rid, node["level"], nid, 100000)
        edges = inc if rel == "callers" else out
        key = "src" if rel == "callers" else "dst"
        total = len(edges)
        edges = edges[offset:offset + limit]
        weights = {e[key]: e["weight"] for e in edges}
        got = {n["id"]: n for n in store.nodes_by_ids(rid, list(weights))}
        page = [got[i] for i in weights if i in got]
    counts = store.link_counts(rid, page[0]["level"], [n["id"] for n in page]) if page else {}
    items = []
    for n in page:
        c = card(n)
        callers, calls = counts.get(n["id"], (0, 0))
        inside = _through(rid, n).get("children") or 0   # what opening it will show, whichever branch it is in
        c["counts"] = {"inside": inside, "calls": calls, "callers": callers}
        if n["id"] in weights:
            c["weight"] = weights[n["id"]]
        items.append(c)
    return {"node": card(node) if node else None, "rel": rel, "total": total, "offset": offset, "items": items}


def detail(rid: str, nid: str) -> dict | None:
    repo = store.repo(rid)
    node = store.node(rid, nid) if repo else None
    if not node:
        return None
    inc, out = store.neighbors(rid, node["level"], nid, 8)
    near = {n["id"]: n for n in store.nodes_by_ids(rid, [e["src"] for e in inc] + [e["dst"] for e in out])}
    path = []
    cur = node
    while cur and cur["parent"]:
        cur = store.node(rid, cur["parent"])
        if cur:
            path.append({"id": cur["id"], "level": cur["level"], "label": cur["title"] or cur["label"]})
    d = card(node)
    d.update({
        "meta": node["meta"],
        "url": github_url(repo, node),
        "snippet": snippet(rid, node),
        "breadcrumbs": list(reversed(path)),
        "children_preview": [card(c) for c in store.children(rid, nid)[:14]],
        "called_by": [{**card(near[e["src"]]), "weight": e["weight"]} for e in inc if e["src"] in near],
        "calls": [{**card(near[e["dst"]]), "weight": e["weight"]} for e in out if e["dst"] in near],
    })
    return d


def tour(rid: str) -> dict | None:
    """The overview: the main parts in reading order, where execution starts, what everything leans on."""
    if not store.repo(rid):
        return None
    areas = [n for n in store.nodes_at(rid, 4)]
    areas.sort(key=lambda n: (ROLE_ORDER.get(n["role"], 9), n["rank"], n["id"]))
    comps = [n for n in store.nodes_at(rid, 3) if n["role"] == "app"]
    area_pos = {a["id"]: i for i, a in enumerate(areas)}
    comps.sort(key=lambda n: (area_pos.get(n["parent"], 99), n["rank"], -(n["deg_in"] + n["deg_out"])))
    syms = [n for n in store.nodes_at(rid, 0, limit=4000) if n["role"] == "app"]
    entries = sorted((n for n in syms if n["entry"]), key=lambda n: -n["deg_out"])[:8]
    hubs = sorted(syms, key=lambda n: -n["deg_in"])[:8]
    return {
        "areas": [card(a) for a in areas],
        "reading_order": [card(c) for c in comps],
        "entry_points": [card(n) for n in entries],
        "hubs": [card(n) for n in hubs],
    }
