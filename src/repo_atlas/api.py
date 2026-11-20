"""HTTP API and the screen. Started by `repo-atlas` (see __main__.py)."""
from __future__ import annotations

import json
import re

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, config, describe, ingest, llm, query, retrieve, store

app = FastAPI(title="Repo Atlas", version=__version__)
store.init()

LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\]|testserver)(:\d+)?$")
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")


@app.middleware("http")
async def local_only(request: Request, call_next):
    """This server runs git and can hold an API key, so only pages it serves itself may call it.

    A Host check stops DNS-rebinding pages; an Origin check stops other websites in the same browser from
    posting to it.
    """
    host = request.headers.get("host", "")
    origin = request.headers.get("origin")
    if not LOCAL_HOST.match(host) or (origin and origin != "null" and not LOCAL_ORIGIN.match(origin)):
        return JSONResponse({"detail": "forbidden"}, status_code=403)
    response = await call_next(request)
    # The page's files come out of the installed package with old timestamps, so without this a browser may keep
    # showing the previous version's screens after an update. "no-cache" still lets it reuse a file that hasn't changed.
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


class RepoIn(BaseModel):
    url: str
    refresh: bool = False
    lang: str | None = Field(default=None, pattern="^(ko|en)$")


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    node: str | None = None
    level: int | None = Field(default=None, ge=0, le=4)
    lang: str | None = Field(default=None, pattern="^(ko|en)$")
    history: list[dict] | None = None
    stream: bool = True


def _ready(rid: str) -> dict:
    repo = store.repo(rid)
    if not repo:
        raise HTTPException(404, "repository not found")
    if repo["status"] != "ready" and not store.count_at(rid, 1):
        raise HTTPException(409, f"repository is not ready yet (status: {repo['status']}, stage: {repo['stage']})")
    return repo


def _found(value, what: str = "node"):
    if value is None:
        raise HTTPException(404, f"{what} not found")
    return value


class SettingsIn(BaseModel):
    provider: str | None = Field(default=None, pattern="^(auto|ollama|anthropic|none)$")
    ollama_url: str | None = Field(default=None, max_length=300)
    ollama_model: str | None = Field(default=None, max_length=200)
    anthropic_model: str | None = Field(default=None, max_length=100)
    anthropic_api_key: str | None = Field(default=None, max_length=300)


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "data": str(config.DATA), "model": llm.status()}


@app.get("/api/settings")
def get_settings():
    """Model settings. A saved API key is never sent back, only a hint of its last characters."""
    return llm.status()


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    changes = body.model_dump(exclude_none=True)
    if "ollama_url" in changes and changes["ollama_url"] and not re.match(r"^https?://[\w.\-\[\]:]+/?$", changes["ollama_url"]):
        raise HTTPException(422, "Ollama address should look like http://127.0.0.1:11434")
    if "anthropic_model" in changes and changes["anthropic_model"] not in llm.CLAUDE_MODELS:
        raise HTTPException(422, "unknown Claude model")
    llm.save_settings(changes)
    return llm.status()


@app.post("/api/settings/check")
def check_settings():
    return llm.check()


@app.get("/api/repos")
def list_repos():
    return store.repos()


@app.post("/api/repos", status_code=202)
def add_repo(body: RepoIn):
    try:
        rid = ingest.start(body.url, refresh=body.refresh, lang=body.lang)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return store.repo(rid)


@app.get("/api/repos/{rid}")
def get_repo(rid: str):
    return _found(query.overview(rid), "repository")


@app.delete("/api/repos/{rid}", status_code=204)
def delete_repo(rid: str):
    """Forget a repository: its stored graph and its local clone."""
    import re
    import shutil
    if not store.repo(rid) or not re.fullmatch(r"[a-z0-9_.-]+", rid):
        raise HTTPException(404, "repository not found")
    store.delete_repo(rid)
    target = (config.REPOS / rid).resolve()
    if target.parent == config.REPOS.resolve() and target.is_dir():
        shutil.rmtree(target)


@app.get("/api/repos/{rid}/layers/{level}")
def get_layer(rid: str, level: int, limit: int = Query(300, ge=1, le=2000), offset: int = Query(0, ge=0),
              under: str | None = None):
    _ready(rid)
    return _found(query.layer(rid, level, limit, offset, under), "layer")


@app.get("/api/repos/{rid}/focus")
def get_focus(rid: str, node: str, cap: int = Query(18, ge=1, le=80), cross: int = Query(8, ge=0, le=30)):
    _ready(rid)
    return _found(query.focus(rid, node, cap, cross))


@app.get("/api/repos/{rid}/branch")
def get_branch(rid: str, rel: str = Query(pattern="^(inside|calls|callers)$"), node: str | None = None,
               limit: int = Query(12, ge=1, le=200), offset: int = Query(0, ge=0)):
    _ready(rid)
    return _found(query.branch(rid, node or None, rel, limit, offset))


@app.get("/api/repos/{rid}/node")
def get_node(rid: str, node: str):
    _ready(rid)
    return _found(query.detail(rid, node))


@app.post("/api/repos/{rid}/explain")
def explain(rid: str, node: str, lang: str | None = Query(None, pattern="^(ko|en)$")):
    repo = _ready(rid)
    return _found(describe.explain(rid, node, lang or repo.get("lang") or "en"))


@app.get("/api/repos/{rid}/search")
def search(rid: str, q: str = Query(min_length=1, max_length=300), k: int = Query(12, ge=1, le=50),
           level: int | None = Query(None, ge=0, le=4)):
    _ready(rid)
    hits = retrieve.search(rid, q, k, levels={level} if level is not None else None)
    return [{**query.card(h), "score": h["score"]} for h in hits]


@app.get("/api/repos/{rid}/tour")
def tour(rid: str):
    _ready(rid)
    return _found(query.tour(rid), "repository")


@app.post("/api/repos/{rid}/ask")
def ask(rid: str, body: AskIn):
    _ready(rid)
    if body.node and not store.node(rid, body.node):
        raise HTTPException(404, "node not found")
    events = retrieve.ask(rid, body.question, body.node, body.level, body.lang, body.history)
    if body.stream:
        def sse():
            for ev in events:
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    out = {"answer": "", "sources": [], "cited": [], "model": None}
    for ev in events:
        if ev["type"] == "sources":
            out["sources"] = ev["sources"]
        elif ev["type"] == "delta":
            out["answer"] += ev["text"]
        elif ev["type"] == "error":
            out["error"] = ev["message"]
        elif ev["type"] == "done":
            out["cited"], out["model"] = ev["cited"], ev["model"]
    return out


# The screen: static files shipped inside the package, served last so every /api route above wins.
if config.WEB.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=config.WEB, html=True), name="web")
