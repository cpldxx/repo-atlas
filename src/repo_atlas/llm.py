"""Model access. Each person connects their own: a local Ollama model, or Claude with their own API key.

Settings live in <data>/config.json (written only from the Settings screen or by hand). An ANTHROPIC_API_KEY in
the environment works too and is never written to disk. With no model at all the rest of the app still works:
maps and search stay available, and questions return their sources without a written answer.

Embeddings (meaning-based search) come from Ollama when an embedding model is installed; otherwise search falls
back to names and words only.
"""
from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator

import httpx

from . import config

PROVIDERS = ("auto", "ollama", "anthropic", "none")
CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
DEFAULTS = {"provider": "auto", "ollama_url": "", "ollama_model": "", "anthropic_model": CLAUDE_MODELS[0],
            "anthropic_api_key": ""}
NUM_CTX = 16384  # one context size for every Ollama call, so the model is never reloaded between calls

_models_cache: list[str] | None = None
_think: dict[str, bool] = {}   # Ollama model -> whether it accepts "think": false


# ---- settings ---------------------------------------------------------------------------------------------------
def settings() -> dict:
    s = dict(DEFAULTS)
    try:
        s.update({k: v for k, v in json.loads(config.SETTINGS_PATH.read_text()).items() if k in DEFAULTS})
    except (OSError, ValueError):
        pass
    if s["provider"] not in PROVIDERS:
        s["provider"] = "auto"
    return s


def save_settings(changes: dict) -> dict:
    s = settings()
    for k, v in changes.items():
        if k in DEFAULTS and isinstance(v, str):
            s[k] = v.strip()
    config.DATA.mkdir(parents=True, exist_ok=True)
    tmp = config.SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2))
    os.chmod(tmp, 0o600)   # it may hold an API key
    tmp.replace(config.SETTINGS_PATH)
    global _models_cache
    _models_cache = None
    return s


def ollama_url() -> str:
    return (settings()["ollama_url"] or config.OLLAMA_URL).rstrip("/")


def anthropic_key() -> tuple[str, str]:
    """(key, where it came from). The environment wins over a saved key."""
    env = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if env:
        return env, "env"
    saved = settings()["anthropic_api_key"]
    return (saved, "saved") if saved else ("", "")


def provider() -> str:
    """The provider actually in use: 'anthropic', 'ollama' or 'none'."""
    choice = settings()["provider"]
    if choice == "anthropic":
        return "anthropic" if anthropic_key()[0] else "none"
    if choice == "ollama":
        return "ollama" if _ollama_chat_model() else "none"
    if choice == "none":
        return "none"
    if anthropic_key()[0]:
        return "anthropic"
    return "ollama" if _ollama_chat_model() else "none"


# ---- Ollama -----------------------------------------------------------------------------------------------------
def models(refresh: bool = False) -> list[str]:
    """Models installed in Ollama (empty when Ollama is not running)."""
    global _models_cache
    if _models_cache is None or refresh:
        try:
            r = httpx.get(f"{ollama_url()}/api/tags", timeout=3)
            _models_cache = [m["name"] for m in r.json().get("models", [])]
        except Exception:
            _models_cache = []
    return _models_cache


def _ollama_chat_model() -> str | None:
    have = [m for m in models() if "embed" not in m]
    want = settings()["ollama_model"] or config.CHAT_MODEL
    if want:
        return want if want in have else None
    for m in config.CHAT_PREFERENCE:
        if m in have:
            return m
    return have[0] if have else None


def embed_model() -> str | None:
    for m in models():
        if m == config.EMBED_MODEL or m.split(":")[0] == config.EMBED_MODEL:
            return m
    return None


def _can_disable_thinking(model: str) -> bool:
    """Some Ollama models think before answering, which costs a minute per reply. Ask once whether this one lets us
    turn that off."""
    if model not in _think:
        try:
            r = httpx.post(f"{ollama_url()}/api/chat", timeout=120, json={
                "model": model, "messages": [{"role": "user", "content": "ok"}], "stream": False, "think": False,
                "options": {"num_predict": 1, "num_ctx": NUM_CTX}})
            _think[model] = r.status_code == 200
        except httpx.HTTPError:
            return False
    return _think[model]


def _ollama_body(model: str, messages: list[dict], stream: bool, temperature: float) -> dict:
    body = {"model": model, "messages": messages, "stream": stream,
            "options": {"temperature": temperature, "num_ctx": NUM_CTX}}
    if _can_disable_thinking(model):
        body["think"] = False
    return body


# ---- Claude -----------------------------------------------------------------------------------------------------
def _claude_client():
    import anthropic
    return anthropic.Anthropic(api_key=anthropic_key()[0])


def _claude_model() -> str:
    m = settings()["anthropic_model"]
    return m if m in CLAUDE_MODELS else CLAUDE_MODELS[0]


def _claude_request(messages: list[dict], effort: str | None, max_tokens: int, json_mode: bool) -> dict:
    """Shared request fields. System messages go to the top-level `system` field."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    if json_mode:
        system += "\n\nReply with a single JSON object and nothing else."
    req = {"model": _claude_model(), "max_tokens": max_tokens,
           "messages": [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] != "system"]}
    if system.strip():
        req["system"] = system.strip()
    if effort:
        req["output_config"] = {"effort": effort}
    # If a safety classifier declines, let the API retry on its recommended model. Haiku has no server-side fallback.
    if not req["model"].startswith("claude-haiku"):
        req["betas"] = ["server-side-fallback-2026-07-01"]
        req["fallbacks"] = "default"
    return req


def _json_object(text: str) -> str:
    """The JSON object inside a reply, tolerating a sentence or a code fence around it."""
    m = re.search(r"\{.*\}", text, re.S)
    return m.group(0) if m else text


# ---- the calls the rest of the app uses ---------------------------------------------------------------------------
def pick_chat_model() -> str | None:
    """Name of the model that will answer, or None when no model is connected."""
    p = provider()
    if p == "anthropic":
        return _claude_model()
    if p == "ollama":
        return _ollama_chat_model()
    return None


def status() -> dict:
    models(refresh=True)
    key, source = anthropic_key()
    s = settings()
    return {
        "provider": provider(), "choice": s["provider"], "chat_model": pick_chat_model(), "embed_model": embed_model(),
        "ollama": {"running": bool(models()), "url": ollama_url(), "models": [m for m in models() if "embed" not in m],
                   "model": s["ollama_model"]},
        "anthropic": {"key": bool(key), "key_source": source, "key_hint": f"…{key[-4:]}" if key else "",
                      "model": _claude_model(), "models": CLAUDE_MODELS},
    }


def chat(messages: list[dict], *, json_mode: bool = False, temperature: float = 0.2, effort: str | None = None,
         timeout: float = 600) -> str:
    p = provider()
    if p == "anthropic":
        req = _claude_request(messages, effort, 16000, json_mode)
        client = _claude_client().with_options(timeout=timeout)
        msg = client.beta.messages.create(**req) if "betas" in req else client.messages.create(**req)
        if msg.stop_reason == "refusal":
            raise RuntimeError("Claude declined this request")
        text = "".join(b.text for b in msg.content if b.type == "text")
        return _json_object(text) if json_mode else text
    model = _ollama_chat_model() if p == "ollama" else None
    if not model:
        raise RuntimeError("no chat model is connected")
    body = _ollama_body(model, messages, False, temperature)
    if json_mode:
        body["format"] = "json"
    r = httpx.post(f"{ollama_url()}/api/chat", json=body, timeout=timeout)
    r.raise_for_status()
    return r.json()["message"]["content"]


def chat_stream(messages: list[dict], *, temperature: float = 0.2, effort: str | None = None,
                timeout: float = 600) -> Iterator[str]:
    p = provider()
    if p == "anthropic":
        req = _claude_request(messages, effort, 64000, False)
        client = _claude_client().with_options(timeout=timeout)
        streamer = client.beta.messages.stream(**req) if "betas" in req else client.messages.stream(**req)
        with streamer as stream:
            for text in stream.text_stream:
                yield text
            if stream.get_final_message().stop_reason == "refusal":
                raise RuntimeError("Claude declined this request")
        return
    model = _ollama_chat_model() if p == "ollama" else None
    if not model:
        raise RuntimeError("no chat model is connected")
    body = _ollama_body(model, messages, True, temperature)
    with httpx.stream("POST", f"{ollama_url()}/api/chat", json=body, timeout=timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            part = json.loads(line)
            text = (part.get("message") or {}).get("content")
            if text:
                yield text
            if part.get("done"):
                break


def check() -> dict:
    """Try the connection the Settings screen describes, without spending tokens where possible."""
    p = provider()
    if p == "anthropic":
        import anthropic
        try:
            _claude_client().with_options(timeout=20, max_retries=0).models.retrieve(_claude_model())
            return {"ok": True, "message": f"Connected to Claude ({_claude_model()})."}
        except anthropic.AuthenticationError:
            return {"ok": False, "message": "That API key was rejected."}
        except anthropic.PermissionDeniedError:
            return {"ok": False, "message": "This API key can't use that model."}
        except anthropic.NotFoundError:
            return {"ok": False, "message": "That model isn't available to this key."}
        except anthropic.APIConnectionError:
            return {"ok": False, "message": "Couldn't reach the Claude API. Check your internet connection."}
        except anthropic.APIStatusError as e:
            return {"ok": False, "message": f"The Claude API answered with an error ({e.status_code})."}
    if p == "ollama":
        model = _ollama_chat_model()
        try:
            r = httpx.post(f"{ollama_url()}/api/chat", timeout=180, json=_ollama_body(
                model, [{"role": "user", "content": "Say ok."}], False, 0.0) | {"options": {"num_predict": 4, "num_ctx": NUM_CTX}})
            r.raise_for_status()
            return {"ok": True, "message": f"Connected to Ollama ({model})."}
        except httpx.HTTPError:
            return {"ok": False, "message": f"Ollama is running but {model} didn't answer."}
    choice = settings()["provider"]
    if choice == "anthropic":
        return {"ok": False, "message": "Add a Claude API key, or set ANTHROPIC_API_KEY before starting."}
    if choice == "ollama" or (choice == "auto" and not models()):
        return {"ok": False, "message": f"Ollama isn't reachable at {ollama_url()}." if not models()
                else "Ollama has no chat model installed. Try: ollama pull qwen2.5-coder:7b"}
    return {"ok": False, "message": "No model is connected."}


def embed(texts: list[str], batch: int = 64, timeout: float = 300) -> list[list[float]] | None:
    """Embed texts with Ollama. Returns None when no embedding model is installed."""
    model = embed_model()
    if not model:
        return None
    out: list[list[float]] = []
    for i in range(0, len(texts), batch):
        r = httpx.post(f"{ollama_url()}/api/embed", json={"model": model, "input": texts[i:i + batch]}, timeout=timeout)
        r.raise_for_status()
        out += r.json()["embeddings"]
    return out
