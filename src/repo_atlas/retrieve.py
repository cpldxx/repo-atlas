"""Search and questions over the stored graph (graph RAG).

Search mixes two signals: keyword match on names, paths and docstrings, and
embedding similarity (so a Korean question still finds English code). A
question then pulls the best matches, follows the graph one step to their
callers and callees, reads the actual code for those nodes, and gives only
that to the local model. Every answer comes back with the nodes it used.
"""
from __future__ import annotations

import json

import math
import re
from collections import Counter
from collections.abc import Iterator

import httpx
import numpy as np

from . import config, llm, query, store

MAX_INDEXED = 8000
_cache: dict[str, dict] = {}
SPLIT = re.compile(r"[^A-Za-z0-9가-힣]+")
SUB = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|[가-힣]+")

SYSTEM = {
    "ko": ("너는 새로 합류한 팀원에게 코드베이스를 설명하는 안내자다. 아래 [자료]에 있는 내용만 근거로 한국어로 답한다. "
           "자료에 없는 것은 추측하지 말고 자료에 없다고 말한다. 근거가 된 자료 번호를 문장 끝에 [1]처럼 붙이고, "
           "근거 번호를 붙일 수 없는 문장은 쓰지 않는다. "
           "파일과 함수 이름은 원문 그대로 쓰고, 짧고 구체적으로 답한다."),
    "en": ("You help someone understand a codebase. Answer in English using only the [sources] below. "
           "If something is not in the sources, say so instead of guessing. Put the source number at the end of "
           "each sentence it supports, like [1], and leave out any sentence you cannot back with a source. Keep file and function names exactly as written. Be short and concrete."),
}
NO_MODEL = {
    "ko": "지금은 답을 써 줄 로컬 모델이 없어서, 질문과 가장 관련 있는 코드 위치만 찾아 드립니다.",
    "en": "No local model is available to write an answer, so here are the most relevant places in the code.",
}


def tokens(text: str) -> list[str]:
    out: list[str] = []
    for part in SPLIT.split(text or ""):
        if not part:
            continue
        out.append(part.lower())
        subs = SUB.findall(part)
        if len(subs) > 1:
            out += [s.lower() for s in subs]
    return out


def _text(n: dict, kids: list[str], code: str = "") -> str:
    bits = [n["label"], n["path"] or "", n["title"] or "", n["summary"] or "", n["doc"] or "", " ".join(kids), code]
    return " ".join(b for b in bits if b)


def _code(rid: str, n: dict) -> str:
    """The code a node stands for, so search matches what it does and not only its name: a function's body (with its
    comments), or a file's top-level statements (settings, wiring, constants)."""
    if n["level"] == 0:
        snip = query.snippet(rid, n, 40)
        return snip["text"][:1500] if snip else ""
    if n["level"] == 1:
        return query.top_level(rid, n, 60)[:1500]
    return ""


def _corpus(rid: str) -> tuple[list[dict], list[str]]:
    nodes = store.all_nodes(rid)
    kids: dict[str, list[str]] = {}
    for n in sorted(nodes, key=lambda n: -(n["deg_in"] + n["deg_out"])):
        if n["parent"]:
            kids.setdefault(n["parent"], [])
            if len(kids[n["parent"]]) < 15:
                kids[n["parent"]].append(n["label"])
    nodes.sort(key=lambda n: (n["level"] == 0, -(n["deg_in"] + n["deg_out"])))
    nodes = nodes[:MAX_INDEXED]
    return nodes, [_text(n, kids.get(n["id"], []), _code(rid, n)) for n in nodes]


def build_index(rid: str) -> int:
    """Embed every node once and store the vectors. Returns how many were embedded."""
    nodes, texts = _corpus(rid)
    rich = ["search_document: " + t[:1800] for t in texts]   # names, descriptions and the code itself
    vecs = llm.embed(rich)
    _cache.pop(rid, None)
    if not vecs:
        return 0
    arr = np.asarray(vecs, dtype=np.float32)
    arr /= np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
    store.save_vecs(rid, [(n["id"], arr[i].tobytes()) for i, n in enumerate(nodes)])
    return len(nodes)


def _load(rid: str) -> dict:
    repo = store.repo(rid)
    stamp = repo["updated_at"] if repo else 0
    hit = _cache.get(rid)
    if hit and hit["stamp"] == stamp:
        return hit
    nodes, texts = _corpus(rid)
    toks = [Counter(tokens(t)) for t in texts]
    df: Counter = Counter()
    for t in toks:
        df.update(t.keys())
    vec_by_id = dict(store.load_vecs(rid))
    mat = None
    if vec_by_id and all(n["id"] in vec_by_id for n in nodes):
        mat = np.vstack([np.frombuffer(vec_by_id[n["id"]], dtype=np.float32) for n in nodes])
    idx = {"stamp": stamp, "nodes": nodes, "toks": toks, "df": df, "mat": mat,
           "avg": (sum(sum(t.values()) for t in toks) / len(toks)) if toks else 1.0,
           "pos": {n["id"]: i for i, n in enumerate(nodes)}}
    _cache[rid] = idx
    return idx


def _query_vector(q: str, dim: int) -> np.ndarray | None:
    """The query's embedding, or None when it can't be compared with the stored vectors: Ollama stopped or failed, or
    the embedding model changed since the repository was indexed. Search then ranks by words alone."""
    try:
        qv = llm.embed(["search_query: " + q])
    except (httpx.HTTPError, KeyError, ValueError):
        return None
    if not qv:
        return None
    v = np.asarray(qv[0], dtype=np.float32)
    if v.shape != (dim,):
        return None
    return v / (np.linalg.norm(v) + 1e-9)


def search(rid: str, q: str, k: int = 12, scope: set[str] | None = None, levels: set[int] | None = None) -> list[dict]:
    """Best-matching nodes for a query. Each result is a node dict with a 'score'."""
    idx = _load(rid)
    nodes = idx["nodes"]
    cand = [i for i, n in enumerate(nodes)
            if (scope is None or n["id"] in scope) and (levels is None or n["level"] in levels)]
    if not cand:
        return []
    qt = set(tokens(q))
    n_docs = len(nodes)
    kw: dict[int, float] = {}
    for i in cand:
        t = idx["toks"][i]
        dl = sum(t.values())
        s = 0.0
        for w in qt:
            f = t.get(w)
            if f:
                idf = math.log(1 + (n_docs - idx["df"][w] + 0.5) / (idx["df"][w] + 0.5))
                s += idf * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * dl / idx["avg"]))
        if s > 0:
            kw[i] = s
    vec: dict[int, float] = {}
    if idx["mat"] is not None:
        v = _query_vector(q, idx["mat"].shape[1])
        if v is not None:
            sims = idx["mat"][cand] @ v
            vec = {cand[j]: float(sims[j]) for j in range(len(cand))}
    fused: Counter = Counter()
    for ranking in (sorted(kw, key=kw.get, reverse=True)[:60], sorted(vec, key=vec.get, reverse=True)[:60]):
        for r, i in enumerate(ranking):
            fused[i] += 1.0 / (60 + r)
    for i in fused:  # main code before tests, examples and tooling when the match is otherwise similar
        if nodes[i]["role"] != "app":
            fused[i] *= 0.75
    return [{**nodes[i], "score": round(s, 5)} for i, s in fused.most_common(k)]


# ---- questions -----------------------------------------------------------------
def _block(rid: str, repo: dict, n: dict) -> dict:
    """One numbered source: the facts and code the model is allowed to use for this node."""
    kind = n["kind"] if n["level"] == 0 else config.LEVEL_NAMES[n["level"]]
    where = n["path"] + (f":{n['line']}" if n.get("line") else "") if n.get("path") else ""
    head = f"{kind} {n['label']}" + (f" — {where}" if where else "")
    body: list[str] = []
    if n.get("title") or n.get("summary"):
        body.append(" ".join(x for x in (n.get("title"), n.get("summary")) if x))
    if n.get("doc"):
        body.append("doc: " + n["doc"])
    members = n.get("meta", {}).get("members")
    if members:
        body.append("methods: " + ", ".join(m["label"].split(".")[-1] for m in store.nodes_by_ids(rid, members[:30])))
    if n["level"] >= 1:
        kids = store.children(rid, n["id"])[:25]
        if kids:
            body.append("contains: " + ", ".join(k["title"] or k["label"] for k in kids))
    inc, out = store.neighbors(rid, n["level"], n["id"], 6)
    near = {x["id"]: x for x in store.nodes_by_ids(rid, [e["src"] for e in inc] + [e["dst"] for e in out])}
    if out:
        body.append("calls/uses: " + ", ".join(near[e["dst"]]["label"] for e in out if e["dst"] in near))
    if inc:
        body.append("called/used by: " + ", ".join(near[e["src"]]["label"] for e in inc if e["src"] in near))
    snip = query.snippet(rid, n, 48) if n["level"] == 0 else None
    if snip:
        consts = query.constants_used(rid, n, snip["text"])
        if consts:   # values the code refers to by name, defined at the top of its file
            body.append("constants in this file: " + "; ".join(consts))
        body.append(f"code (lines {snip['start']}-{snip['end']}):\n{snip['text'][:2000]}")
    elif n["level"] == 1:
        top = query.top_level(rid, n, 40)
        if top:
            body.append(f"top-level code of the file:\n{top[:1800]}")
    return {"id": n["id"], "level": n["level"], "kind": n["kind"], "label": n["label"], "title": n.get("title"),
            "path": n.get("path"), "line": n.get("line"), "url": query.github_url(repo, n),
            "text": head + "\n" + "\n".join(body)}


def repo_map(rid: str) -> str:
    """A short table of contents of the repository, given to the model as background (not a citable source)."""
    comps: dict[str, list[dict]] = {}
    for c in store.nodes_at(rid, 3):
        comps.setdefault(c["parent"], []).append(c)
    lines = []
    for a in sorted(store.nodes_at(rid, 4), key=lambda n: (query.ROLE_ORDER.get(n["role"], 9), n["rank"])):
        if a["kind"] == "external":
            continue
        lines.append(f"- {a['title'] or a['label']} ({a['path']}): {a['summary'] or ''}")
        for c in sorted(comps.get(a["id"], []), key=lambda n: n["rank"])[:8]:
            lines.append(f"    - {c['title'] or c['label']} ({c['path']}): {c['summary'] or ''}")
    return "\n".join(lines)[:1800]


def gather(rid: str, question: str, node_id: str | None = None, level: int | None = None) -> list[dict]:
    """Pick the sources for a question: the selected node or layer first, then search hits and their neighbours."""
    repo = store.repo(rid)
    picked: list[dict] = []
    seen: set[str] = set()

    def take(n: dict | None) -> None:
        if n and n["id"] not in seen and len(picked) < 9:
            seen.add(n["id"])
            picked.append(n)

    scope = None
    focus = store.node(rid, node_id) if node_id else None
    if focus:
        take(focus)
        scope = {focus["id"]}
        for lv in range(focus["level"] - 1, -1, -1):
            scope |= {n["id"] for n in store.nodes_at(rid, lv, under=focus["id"], under_level=focus["level"])}
        inc, out = store.neighbors(rid, focus["level"], focus["id"], 6)
        scope |= {e["src"] for e in inc} | {e["dst"] for e in out}
    elif level is not None:
        for n in store.nodes_at(rid, level, limit=6):
            take(n)

    hits = search(rid, question, k=8, scope=scope) if scope else []
    hits += [h for h in search(rid, question, k=6 if scope else 9) if h["id"] not in {x["id"] for x in hits}]
    for h in hits[:3]:
        take(h)
    for h in [h for h in hits[:2] if h["level"] == 0]:  # follow the call chain around the best matches
        inc, out = store.neighbors(rid, 0, h["id"], 2)
        for n in store.nodes_by_ids(rid, [e["dst"] for e in out] + [e["src"] for e in inc[:1]]):
            take(n)
    for h in [h for h in hits[:3] if h["kind"] == "class"]:  # a class answer usually lives in its methods
        members = set(h.get("meta", {}).get("members", []))
        for m in search(rid, question, k=3, scope=members) if members else []:
            take(m)
    for h in hits[3:]:
        take(h)

    blocks, used = [], 0
    for n in picked:
        b = _block(rid, repo, n)
        if used + len(b["text"]) > 15000 and blocks:
            break
        used += len(b["text"])
        b["n"] = len(blocks) + 1
        blocks.append(b)
    return blocks


def code_words(question: str) -> str:
    """Words the code that answers a question likely contains (function names, library calls), so a question asked in
    plain words still finds that code. One short model call; without a model, or on any problem, nothing is added."""
    if not llm.pick_chat_model():
        return ""
    try:
        raw = llm.chat([
            {"role": "system", "content": "You help search a codebase. Reply with JSON only."},
            {"role": "user", "content": f"A question about a codebase: {question[:600]!r}\n"
                                        "List up to 6 short words or identifiers likely to appear in the code that answers it "
                                        "(function or method names, library calls, keywords). Reply as {\"terms\": [\"...\"]}."},
        ], json_mode=True, temperature=0, effort="low", timeout=15)   # optional: never hold the answer up for long
        data = json.loads(raw) if isinstance(raw, str) else raw
        terms = data.get("terms", []) if isinstance(data, dict) else []
        return " ".join(str(t)[:40] for t in terms[:6] if isinstance(t, (str, int)))
    except Exception:
        return ""


def ask(rid: str, question: str, node_id: str | None = None, level: int | None = None,
        lang: str | None = None, history: list[dict] | None = None) -> Iterator[dict]:
    """Answer a question. Yields events: sources, then text deltas, then done."""
    repo = store.repo(rid)
    lang = lang or (repo or {}).get("lang") or config.DEFAULT_LANG
    # A follow-up ("and what if it's inactive?") is searched together with the question before it, and a question in
    # plain words also with the code words its answer likely contains ("timing attack" -> compare_digest).
    earlier = [h["content"] for h in (history or []) if h.get("role") == "user" and isinstance(h.get("content"), str)]
    wanted = ((earlier[-1][:300] + " ") if earlier else "") + question
    blocks = gather(rid, (wanted + " " + code_words(wanted)).strip(), node_id, level)
    yield {"type": "sources", "sources": [{k: b[k] for k in ("n", "id", "level", "kind", "label", "title", "path", "line", "url")}
                                          for b in blocks]}
    model = llm.pick_chat_model()
    if not model:
        yield {"type": "delta", "text": NO_MODEL.get(lang, NO_MODEL["en"])}
        yield {"type": "done", "model": None, "cited": [b["n"] for b in blocks[:5]]}
        return
    context = "\n\n".join(f"[{b['n']}] {b['text']}" for b in blocks)
    about = ""
    if node_id and blocks:
        about = f"\n(The person is looking at: {blocks[0]['label']}, source [1].)"
    elif level is not None:
        about = f"\n(The person is looking at the {config.LEVEL_NAMES.get(level, '')} layer.)"
    messages = [{"role": "system", "content": SYSTEM.get(lang, SYSTEM["en"])}]
    for h in (history or [])[-4:]:
        if h.get("role") in ("user", "assistant") and isinstance(h.get("content"), str):
            messages.append({"role": h["role"], "content": h["content"][:2000]})
    messages.append({"role": "user", "content":
                     f"[repository map — background only, do not cite]\n{repo_map(rid)}\n\n"
                     f"[sources]\n{context}\n\n[question]{about}\n{question}"})
    full = []
    try:
        for piece in llm.chat_stream(messages):
            full.append(piece)
            yield {"type": "delta", "text": piece}
    except Exception as e:
        yield {"type": "error", "message": f"model call failed: {e}"}
    valid = {b["n"] for b in blocks}
    cited = sorted({int(m) for m in re.findall(r"\[(\d+)\]", "".join(full)) if int(m) in valid})
    yield {"type": "done", "model": model, "cited": cited}
