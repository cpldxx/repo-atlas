"""Human names and one-line descriptions for the two interpreted layers (L4 areas, L3 components).

Written once per repository by the local model and stored. Lower layers get a
description on demand (`explain`), also stored, so each node costs one model
call at most.
"""
from __future__ import annotations

import json

from . import config, llm, query, store

LANG = {"ko": "Korean", "en": "English"}
EXT_TEXT = {
    "ko": ("외부 라이브러리", "이 레포가 가져다 쓰는 바깥 패키지입니다. 가장 많이 쓰는 것: {top}."),
    "en": ("External libraries", "Packages this repository imports from outside. Most used: {top}."),
}


def _readme(rid: str) -> str:
    src = config.repo_paths(rid)[0]
    for name in ("README.md", "README.rst", "README.txt", "README"):
        p = src / name
        if p.is_file():
            return p.read_text(errors="replace")[:1500]
    return ""


def _part(rid: str, n: dict, names: dict[str, str]) -> str:
    """A compact fact sheet about one node, built only from the stored graph."""
    kids = store.children(rid, n["id"])[:12]
    lines = [f"path: {n['path'] or '(several)'} · role: {n['role']} · {n['children']} children"]
    if kids:
        lines.append("contains: " + ", ".join((k["title"] or k["label"]) for k in kids))
    if n["level"] == 3:
        syms = store.nodes_at(rid, 0, under=n["id"], under_level=3, limit=10)
        if syms:
            lines.append("main symbols: " + "; ".join(
                s["label"] + (f" — {s['doc'][:70]}" if s["doc"] else "") for s in syms))
    inc, out = store.neighbors(rid, n["level"], n["id"], 5)
    if out:
        lines.append("depends on: " + ", ".join(names.get(e["dst"], e["dst"]) for e in out))
    if inc:
        lines.append("used by: " + ", ".join(names.get(e["src"], e["src"]) for e in inc))
    return "\n  ".join(lines)


def _ask(repo: dict, readme: str, parts: dict[str, str], lang: str, what: str) -> dict:
    listing = "\n".join(f"[{k}] {v}" for k, v in parts.items())
    prompt = f"""Repository: {repo['owner']}/{repo['name']}
README excerpt:
{readme or '(none)'}

Below are {what} of this repository. For each one write:
- "title": a short human name in {LANG.get(lang, 'English')} (2-4 words) that says what it is for, not its folder name
  (every title must be different from the others)
- "summary": one sentence in {LANG.get(lang, 'English')} saying what it does, for someone who just joined the team

Use only what is shown here. Never guess what an unfamiliar name or abbreviation means: describe the part by
what its files and main symbols do, and if that is still unclear say plainly what it contains.

{listing}

Return JSON only, shaped like {{"{next(iter(parts))}": {{"title": "...", "summary": "..."}}, ...}} with every key above."""
    raw = llm.chat([
        {"role": "system", "content": "You describe parts of a codebase for someone getting to know it. Reply with JSON only."},
        {"role": "user", "content": prompt},
    ], json_mode=True, temperature=0.1, effort="low")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def describe_repo(rid: str, lang: str = "en") -> int:
    """Name and describe every area and component. Returns how many were written (0 without a model)."""
    repo = store.repo(rid)
    ext = store.node(rid, "a:external")
    if ext:
        title, tmpl = EXT_TEXT.get(lang, EXT_TEXT["en"])
        top = ", ".join(t["name"] for t in ext["meta"].get("top", [])[:6]) or "-"
        store.set_text(rid, ext["id"], title, tmpl.format(top=top))
    if not llm.pick_chat_model():
        return 0
    readme = _readme(rid)
    done = 0
    for level, what in ((3, "components (groups of folders)"), (4, "top-level areas")):
        nodes = [n for n in store.nodes_at(rid, level) if n["kind"] != "external"]
        names = {n["id"]: (n["title"] or n["label"]) for n in store.nodes_at(rid, level)}
        chunks = [nodes[i:i + 8] for i in range(0, len(nodes), 8)]
        for attempt in range(2):  # second pass only for the ones the model skipped
            if attempt:
                left = [n for n in nodes if not store.node(rid, n["id"])["title"]]
                chunks = [left[i:i + 8] for i in range(0, len(left), 8)]
            done += _describe_chunks(rid, repo, readme, chunks, names, lang, what)
    return done


def _describe_chunks(rid, repo, readme, chunks, names, lang, what) -> int:
    done = 0
    for chunk in chunks:
        keys = {f"p{j + 1}": n for j, n in enumerate(chunk)}
        try:
            got = _ask(repo, readme, {k: _part(rid, n, names) for k, n in keys.items()}, lang, what)
        except Exception:
            continue
        for k, n in keys.items():
            v = got.get(k)
            if isinstance(v, dict) and isinstance(v.get("title"), str) and isinstance(v.get("summary"), str):
                store.set_text(rid, n["id"], v["title"].strip()[:60], v["summary"].strip()[:400])
                done += 1
    return done


def explain(rid: str, nid: str, lang: str = "en") -> dict | None:
    """One-sentence description of any node, generated on first request and then stored."""
    n = store.node(rid, nid)
    if not n:
        return None
    if n["summary"]:
        return {"id": nid, "summary": n["summary"], "cached": True}
    if not llm.pick_chat_model():
        return {"id": nid, "summary": n["doc"], "cached": False, "model": None}
    facts = [f"{config.LEVEL_NAMES[n['level']]} {n['label']} ({n['path']})"]
    if n["doc"]:
        facts.append("docstring: " + n["doc"])
    kids = store.children(rid, nid)[:20]
    if kids:
        facts.append("contains: " + ", ".join(k["label"] for k in kids))
    snip = query.snippet(rid, n, 60)
    if snip:
        facts.append("code:\n" + snip["text"][:2400])
    text = llm.chat([
        {"role": "system", "content": f"You explain code to someone getting to know the codebase. Answer in {LANG.get(lang, 'English')} "
                                      "with one plain sentence, no preamble."},
        {"role": "user", "content": "\n".join(facts) + "\n\nWhat does this do?"},
    ], temperature=0.1, effort="low").strip()
    store.set_text(rid, nid, summary=text[:400])
    return {"id": nid, "summary": text[:400], "cached": False}
