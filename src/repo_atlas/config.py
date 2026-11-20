"""Paths and settings. Everything can be overridden with environment variables."""
from __future__ import annotations

import os
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
WEB = PACKAGE / "web"
# Everything the app stores (maps, clones, settings) lives in one folder per user.
DATA = Path(os.environ.get("ATLAS_DATA", Path.home() / ".repo-atlas")).expanduser()
DB_PATH = DATA / "atlas.db"
REPOS = DATA / "repos"
SETTINGS_PATH = DATA / "config.json"

DEFAULT_PORT = int(os.environ.get("ATLAS_PORT", "47821"))
OLLAMA_URL = os.environ.get("ATLAS_OLLAMA_URL", os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
if not OLLAMA_URL.startswith("http"):
    OLLAMA_URL = "http://" + OLLAMA_URL
# Empty means "pick the best installed model" (see llm.py).
CHAT_MODEL = os.environ.get("ATLAS_CHAT_MODEL", "")
EMBED_MODEL = os.environ.get("ATLAS_EMBED_MODEL", "nomic-embed-text-v2-moe")
CHAT_PREFERENCE = [
    "qwen3.6:35b",
    "qwen2.5-coder:32b",
    "qwen2.5:32b",
    "ministral-3:8b",
    "qwen2.5-coder:7b",
]

DEFAULT_LANG = os.environ.get("ATLAS_LANG", "en")
LEVEL_NAMES = {0: "symbol", 1: "file", 2: "module", 3: "component", 4: "area"}


def repo_paths(rid: str) -> tuple[Path, Path]:
    """(cloned source, Graphify output) for one repository."""
    base = REPOS / rid
    return base / "src", base / "graph"
