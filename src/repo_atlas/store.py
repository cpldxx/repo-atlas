"""SQLite storage: one database, every repo's graph kept by repo id."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS repos(
  id TEXT PRIMARY KEY, url TEXT, owner TEXT, name TEXT, commit_sha TEXT,
  status TEXT, stage TEXT, error TEXT, stats TEXT, lang TEXT, created_at REAL, updated_at REAL);
CREATE TABLE IF NOT EXISTS nodes(
  repo_id TEXT, id TEXT, level INTEGER, kind TEXT, role TEXT, label TEXT, title TEXT, summary TEXT, doc TEXT,
  parent TEXT, path TEXT, line INTEGER, end_line INTEGER, rank INTEGER, flow REAL,
  deg_in INTEGER, deg_out INTEGER, children INTEGER, entry INTEGER, meta TEXT,
  anc1 TEXT, anc2 TEXT, anc3 TEXT, anc4 TEXT,
  PRIMARY KEY(repo_id, id));
CREATE INDEX IF NOT EXISTS nodes_level ON nodes(repo_id, level);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(repo_id, parent);
CREATE INDEX IF NOT EXISTS nodes_anc3 ON nodes(repo_id, anc3, level);
CREATE INDEX IF NOT EXISTS nodes_anc2 ON nodes(repo_id, anc2, level);
CREATE TABLE IF NOT EXISTS edges(
  repo_id TEXT, level INTEGER, src TEXT, dst TEXT, calls INTEGER, uses INTEGER, weight INTEGER,
  PRIMARY KEY(repo_id, level, src, dst));
CREATE INDEX IF NOT EXISTS edges_dst ON edges(repo_id, level, dst);
CREATE TABLE IF NOT EXISTS vecs(repo_id TEXT, id TEXT, vec BLOB, PRIMARY KEY(repo_id, id));
"""
NODE_COLS = (
    "id level kind role label title summary doc parent path line end_line rank flow "
    "deg_in deg_out children entry meta anc1 anc2 anc3 anc4"
).split()


@contextmanager
def db():
    config.DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    with db() as c:
        c.executescript(SCHEMA)


def _node(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    d.pop("repo_id", None)
    d["meta"] = json.loads(d["meta"] or "{}")
    d["entry"] = bool(d["entry"])
    return d


def _repo(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    d["stats"] = json.loads(d["stats"] or "{}")
    return d


# ---- repos -------------------------------------------------------------------
def upsert_repo(rid: str, **fields) -> None:
    now = time.time()
    with db() as c:
        if c.execute("SELECT 1 FROM repos WHERE id=?", (rid,)).fetchone() is None:
            c.execute("INSERT INTO repos(id, created_at, updated_at, status) VALUES(?,?,?,?)", (rid, now, now, "new"))
        if "stats" in fields:
            fields["stats"] = json.dumps(fields["stats"], ensure_ascii=False)
        fields["updated_at"] = now
        sets = ", ".join(f"{k}=?" for k in fields)
        c.execute(f"UPDATE repos SET {sets} WHERE id=?", (*fields.values(), rid))


def repo(rid: str) -> dict | None:
    with db() as c:
        return _repo(c.execute("SELECT * FROM repos WHERE id=?", (rid,)).fetchone())


def repos() -> list[dict]:
    with db() as c:
        return [_repo(r) for r in c.execute("SELECT * FROM repos ORDER BY updated_at DESC")]


# ---- graph -------------------------------------------------------------------
def replace_graph(rid: str, nodes: list[dict], edges: list[dict]) -> None:
    """Swap in a freshly built graph. Titles and summaries written earlier are kept by node id."""
    with db() as c:
        old = {r["id"]: (r["title"], r["summary"]) for r in c.execute(
            "SELECT id, title, summary FROM nodes WHERE repo_id=? AND (title IS NOT NULL OR summary IS NOT NULL)", (rid,))}
        c.execute("DELETE FROM nodes WHERE repo_id=?", (rid,))
        c.execute("DELETE FROM edges WHERE repo_id=?", (rid,))
        rows = []
        for n in nodes:
            anc = n.get("anc") or [None] * 5
            title, summary = old.get(n["id"], (n.get("title"), n.get("summary")))
            rows.append((
                rid, n["id"], n["level"], n["kind"], n["role"], n["label"], title, summary, n.get("doc"),
                n.get("parent"), n.get("path"), n.get("line"), n.get("end_line"), n["rank"], n["flow"],
                n["deg_in"], n["deg_out"], n["children"], int(n["entry"]),
                json.dumps(n.get("meta") or {}, ensure_ascii=False), anc[1], anc[2], anc[3], anc[4],
            ))
        c.executemany(f"INSERT INTO nodes VALUES({','.join('?' * 24)})", rows)
        c.executemany(
            "INSERT INTO edges VALUES(?,?,?,?,?,?,?)",
            [(rid, e["level"], e["src"], e["dst"], e["calls"], e["uses"], e["weight"]) for e in edges],
        )


def node(rid: str, nid: str) -> dict | None:
    with db() as c:
        return _node(c.execute("SELECT * FROM nodes WHERE repo_id=? AND id=?", (rid, nid)).fetchone())


def nodes_by_ids(rid: str, ids: list[str]) -> list[dict]:
    out: list[dict] = []
    with db() as c:
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            q = f"SELECT * FROM nodes WHERE repo_id=? AND id IN ({','.join('?' * len(chunk))})"
            out += [_node(r) for r in c.execute(q, (rid, *chunk))]
    return out


def nodes_at(rid: str, level: int, *, under: str | None = None, under_level: int | None = None,
             limit: int | None = None, offset: int = 0) -> list[dict]:
    """Nodes of one level, most connected first. `under` restricts to one ancestor's subtree."""
    q, args = "SELECT * FROM nodes WHERE repo_id=? AND level=?", [rid, level]
    if under is not None:
        q += f" AND anc{int(under_level)}=?"
        args.append(under)
    q += " ORDER BY (deg_in + deg_out) DESC, id"
    if limit is not None:
        q += " LIMIT ? OFFSET ?"
        args += [limit, offset]
    with db() as c:
        return [_node(r) for r in c.execute(q, args)]


def count_at(rid: str, level: int, under: str | None = None, under_level: int | None = None) -> int:
    q, args = "SELECT COUNT(*) FROM nodes WHERE repo_id=? AND level=?", [rid, level]
    if under is not None:
        q += f" AND anc{int(under_level)}=?"
        args.append(under)
    with db() as c:
        return c.execute(q, args).fetchone()[0]


def children(rid: str, nid: str) -> list[dict]:
    with db() as c:
        return [_node(r) for r in c.execute(
            "SELECT * FROM nodes WHERE repo_id=? AND parent=? ORDER BY (deg_in + deg_out) DESC, id", (rid, nid))]


def all_nodes(rid: str) -> list[dict]:
    with db() as c:
        return [_node(r) for r in c.execute("SELECT * FROM nodes WHERE repo_id=?", (rid,))]


def edges_among(rid: str, level: int, ids: list[str], limit: int = 600) -> list[dict]:
    if not ids:
        return []
    keep = set(ids)
    with db() as c:
        rows = c.execute("SELECT src, dst, calls, uses, weight FROM edges WHERE repo_id=? AND level=? ORDER BY weight DESC",
                         (rid, level)).fetchall()
    out = [dict(r) for r in rows if r["src"] in keep and r["dst"] in keep]
    return out[:limit]


def crossing(rid: str, level: int, owner: str, owner_level: int, direction: str, limit: int = 10) -> list[dict]:
    """Strongest edges at `level` that cross the boundary of `owner`'s subtree.

    direction 'out': from inside the subtree to outside. 'in': from outside to inside.
    """
    col = "id" if int(owner_level) == 0 else f"anc{int(owner_level)}"
    inside, outside = ("s", "d") if direction == "out" else ("d", "s")
    q = f"""
      SELECT e.src, e.dst, e.calls, e.uses, e.weight FROM edges e
      JOIN nodes s ON s.repo_id=e.repo_id AND s.id=e.src
      JOIN nodes d ON d.repo_id=e.repo_id AND d.id=e.dst
      WHERE e.repo_id=? AND e.level=? AND {inside}.{col}=? AND ({outside}.{col} IS NULL OR {outside}.{col}!=?)
      ORDER BY e.weight DESC LIMIT ?"""
    with db() as c:
        return [dict(r) for r in c.execute(q, (rid, level, owner, owner, limit))]


def neighbors(rid: str, level: int, nid: str, limit: int = 12) -> tuple[list[dict], list[dict]]:
    """(incoming, outgoing) edges of one node at its own level, heaviest first."""
    with db() as c:
        inc = [dict(r) for r in c.execute(
            "SELECT src, dst, calls, uses, weight FROM edges WHERE repo_id=? AND level=? AND dst=? ORDER BY weight DESC LIMIT ?",
            (rid, level, nid, limit))]
        out = [dict(r) for r in c.execute(
            "SELECT src, dst, calls, uses, weight FROM edges WHERE repo_id=? AND level=? AND src=? ORDER BY weight DESC LIMIT ?",
            (rid, level, nid, limit))]
    return inc, out


def link_counts(rid: str, level: int, ids: list[str]) -> dict[str, tuple[int, int]]:
    """How many distinct callers and callees each node has at its own level: {id: (callers, callees)}."""
    out = {i: [0, 0] for i in ids}
    with db() as c:
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            marks = ",".join("?" * len(chunk))
            for r in c.execute(f"SELECT dst, COUNT(*) FROM edges WHERE repo_id=? AND level=? AND dst IN ({marks}) GROUP BY dst",
                               (rid, level, *chunk)):
                out[r[0]][0] = r[1]
            for r in c.execute(f"SELECT src, COUNT(*) FROM edges WHERE repo_id=? AND level=? AND src IN ({marks}) GROUP BY src",
                               (rid, level, *chunk)):
                out[r[0]][1] = r[1]
    return {k: (v[0], v[1]) for k, v in out.items()}


def set_text(rid: str, nid: str, title: str | None = None, summary: str | None = None) -> None:
    with db() as c:
        if title is not None:
            c.execute("UPDATE nodes SET title=? WHERE repo_id=? AND id=?", (title, rid, nid))
        if summary is not None:
            c.execute("UPDATE nodes SET summary=? WHERE repo_id=? AND id=?", (summary, rid, nid))


# ---- vectors -----------------------------------------------------------------
def save_vecs(rid: str, items: list[tuple[str, bytes]]) -> None:
    with db() as c:
        c.execute("DELETE FROM vecs WHERE repo_id=?", (rid,))
        c.executemany("INSERT INTO vecs VALUES(?,?,?)", [(rid, i, v) for i, v in items])


def load_vecs(rid: str) -> list[tuple[str, bytes]]:
    with db() as c:
        return [(r["id"], r["vec"]) for r in c.execute("SELECT id, vec FROM vecs WHERE repo_id=?", (rid,))]


def delete_repo(rid: str) -> None:
    with db() as c:
        for table in ("nodes", "edges", "vecs"):
            c.execute(f"DELETE FROM {table} WHERE repo_id=?", (rid,))
        c.execute("DELETE FROM repos WHERE id=?", (rid,))
