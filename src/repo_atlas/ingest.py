"""GitHub URL -> shallow clone -> Graphify (local AST, no model) -> layers -> SQLite.

A repository is read once. Coming back to it loads the stored graph; a refresh
only rebuilds when the commit changed, and Graphify's own cache re-parses only
the files that changed.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from . import config, describe, layering, retrieve, store

GITHUB = re.compile(
    r"^(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9][A-Za-z0-9_.-]*)/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$")
SHORT = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)/([A-Za-z0-9_.-]+)$")
_jobs: dict[str, threading.Thread] = {}
_lock = threading.Lock()


def parse_url(url: str) -> tuple[str, str]:
    """Accept https://github.com/owner/repo (with or without extra path, ?query or #fragment) or owner/repo."""
    url = (url or "").strip()
    m = GITHUB.match(url) or SHORT.match(url)
    if not m:
        raise ValueError("not a GitHub repository URL")
    owner, name = m.group(1), m.group(2)
    if name in (".", "..") or owner in (".", ".."):
        raise ValueError("not a GitHub repository URL")
    return owner, name


def repo_id(owner: str, name: str) -> str:
    return f"{owner}__{name}".lower()


def _git(*args: str, cwd: Path | None = None, timeout: int = 600) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    r = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", *args],
        cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else "git failed")
    return r.stdout.strip()


def clone(owner: str, name: str, dest: Path) -> str:
    """Shallow-clone (or update) the default branch and return the commit sha. Nothing from the repo is executed."""
    url = f"https://github.com/{owner}/{name}.git"
    if (dest / ".git").exists():
        _git("fetch", "--depth", "1", "--no-recurse-submodules", "origin", "HEAD", cwd=dest)
        _git("reset", "--hard", "FETCH_HEAD", cwd=dest)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        _git("clone", "--depth", "1", "--single-branch", "--no-recurse-submodules", "--", url, str(dest))
    return _git("rev-parse", "HEAD", cwd=dest)


def run_graphify(src: Path, out: Path) -> dict:
    """Run Graphify's code-only extraction (tree-sitter, no model, nothing leaves the machine)."""
    out.mkdir(parents=True, exist_ok=True)
    exe = Path(sys.executable).parent / "graphify"
    cmd = [str(exe) if exe.exists() else "graphify", "extract", str(src), "--code-only", "--out", str(out)]
    r = subprocess.run(cmd, env={**os.environ, "GRAPHIFY_BACKEND": "none"}, capture_output=True, text=True, timeout=1800)
    graph_path = out / "graphify-out" / "graph.json"
    if r.returncode != 0 or not graph_path.exists():
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        raise RuntimeError("graphify failed: " + " | ".join(tail))
    return json.loads(graph_path.read_text())


def paths(rid: str) -> tuple[Path, Path]:
    return config.repo_paths(rid)


def ingest(url: str, *, refresh: bool = False, with_model: bool = True, lang: str | None = None) -> str:
    """Run the whole pipeline in the calling thread. Returns the repo id."""
    owner, name = parse_url(url)
    rid = repo_id(owner, name)
    store.init()
    lang = lang or config.DEFAULT_LANG
    prev = store.repo(rid)
    store.upsert_repo(rid, url=f"https://github.com/{owner}/{name}", owner=owner, name=name,
                      status="working", stage="clone", error=None, lang=lang)
    try:
        src, out = paths(rid)
        sha = clone(owner, name, src)
        if prev and prev["status"] == "ready" and prev["commit_sha"] == sha and not refresh:
            store.upsert_repo(rid, status="ready", stage="done")
            return rid

        store.upsert_repo(rid, stage="graph", commit_sha=sha)
        graph = run_graphify(src, out)

        store.upsert_repo(rid, stage="layers")
        built = layering.build(graph)
        if not any(n["level"] == 1 for n in built["nodes"]):
            raise RuntimeError("no source files that Graphify can read were found in this repository")
        store.replace_graph(rid, built["nodes"], built["edges"])
        stats = built["stats"]
        store.upsert_repo(rid, stats=stats)

        if with_model:
            store.upsert_repo(rid, stage="describe")
            stats["described"] = describe.describe_repo(rid, lang=lang)
            store.upsert_repo(rid, stage="index", stats=stats)
            stats["indexed"] = retrieve.build_index(rid)
        store.upsert_repo(rid, status="ready", stage="done", stats=stats)
    except Exception as e:  # the job must always end in a visible state
        store.upsert_repo(rid, status="error", error=str(e)[:500])
        raise
    return rid


def start(url: str, *, refresh: bool = False, lang: str | None = None) -> str:
    """Start ingest in the background and return the repo id right away."""
    owner, name = parse_url(url)
    rid = repo_id(owner, name)
    store.init()
    with _lock:
        t = _jobs.get(rid)
        if t and t.is_alive():
            return rid
        store.upsert_repo(rid, url=f"https://github.com/{owner}/{name}", owner=owner, name=name,
                          status="working", stage="queued", error=None)

        def work():
            try:
                ingest(url, refresh=refresh, lang=lang)
            except Exception:
                pass  # already recorded on the repo row

        t = threading.Thread(target=work, name=f"ingest-{rid}", daemon=True)
        _jobs[rid] = t
        t.start()
    return rid
