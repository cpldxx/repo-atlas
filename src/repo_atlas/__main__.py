"""Command line.

    repo-atlas                      start the app and open it in the browser
    repo-atlas serve [--port N] [--no-open]
    repo-atlas ingest <github-url>  read a repository without the UI
    repo-atlas ask <repo-id> "question"
    repo-atlas status               show the model connection and stored repositories
"""
from __future__ import annotations

import argparse
import shutil
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

from . import __version__, config

BOLD, DIM, RESET = ("\033[1m", "\033[2m", "\033[0m") if sys.stdout.isatty() else ("", "", "")


def free_port(start: int, host: str = "127.0.0.1") -> int:
    for port in range(start, start + 30):
        with socket.socket() as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port between {start} and {start + 29}. Pass --port.")


def serve(port: int | None, open_browser: bool) -> int:
    import uvicorn

    from . import llm

    if not shutil.which("git"):
        print("Repo Atlas needs git to download repositories. Install git, then run this again.", file=sys.stderr)
        return 1
    port = free_port(port or config.DEFAULT_PORT)
    url = f"http://127.0.0.1:{port}"
    model = llm.pick_chat_model()
    where = {"anthropic": "Claude", "ollama": "Ollama"}.get(llm.provider(), "")
    print(f"\n  {BOLD}Repo Atlas {__version__}{RESET}\n")
    print(f"  Open   {BOLD}{url}{RESET}")
    print(f"  Model  {f'{where} · {model}' if model else 'none yet (maps and search still work) · connect one in Settings'}")
    home = str(config.DATA).replace(str(Path.home()), "~", 1) if str(config.DATA).startswith(str(Path.home())) else config.DATA
    print(f"  Data   {home}")
    print(f"\n  {DIM}Press Ctrl+C to stop.{RESET}\n", flush=True)
    if open_browser:
        def opener():
            for _ in range(50):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            webbrowser.open(url)
        threading.Thread(target=opener, daemon=True).start()
    from .api import app
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="repo-atlas", description="Explore a GitHub repository as five layers, a mind map, and answers from the code.")
    p.add_argument("--version", action="version", version=f"repo-atlas {__version__}")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="start the app (the default)")
    s.add_argument("--port", type=int)
    s.add_argument("--no-open", action="store_true", help="don't open the browser")
    a = sub.add_parser("ingest", help="read a GitHub repository without the UI")
    a.add_argument("url")
    a.add_argument("--refresh", action="store_true", help="rebuild even if the commit is unchanged")
    a.add_argument("--no-model", action="store_true", help="skip names, descriptions and embeddings")
    a.add_argument("--lang", choices=["en", "ko"])
    q = sub.add_parser("ask", help="ask a question about a repository you have read")
    q.add_argument("repo")
    q.add_argument("question")
    q.add_argument("--node")
    q.add_argument("--level", type=int)
    q.add_argument("--lang", choices=["en", "ko"])
    sub.add_parser("status", help="show the model connection and stored repositories")
    args = p.parse_args(argv)

    if args.cmd in (None, "serve"):
        return serve(getattr(args, "port", None), not getattr(args, "no_open", False))
    from . import ingest, llm, retrieve, store
    store.init()
    if args.cmd == "ingest":
        t = time.time()
        rid = ingest.ingest(args.url, refresh=args.refresh, with_model=not args.no_model, lang=args.lang)
        r = store.repo(rid)
        print(f"{rid}: {r['status']} in {time.time() - t:.1f}s  commit {r['commit_sha'][:10]}")
        print("levels", r["stats"].get("levels"), "described", r["stats"].get("described"), "indexed", r["stats"].get("indexed"))
    elif args.cmd == "ask":
        for ev in retrieve.ask(args.repo, args.question, args.node, args.level, args.lang):
            if ev["type"] == "sources":
                for src in ev["sources"]:
                    print(f"  [{src['n']}] L{src['level']} {src['label']}  {src['path'] or ''}{':' + str(src['line']) if src['line'] else ''}")
                print()
            elif ev["type"] == "delta":
                sys.stdout.write(ev["text"])
                sys.stdout.flush()
            elif ev["type"] == "error":
                print("\n! " + ev["message"])
            elif ev["type"] == "done":
                print(f"\n\n(model: {ev['model']}, cited: {ev['cited']})")
    elif args.cmd == "status":
        st = llm.status()
        print(f"model: {st['provider']} · {st['chat_model'] or 'none'}  (embeddings: {st['embed_model'] or 'none'})")
        print(f"data:  {config.DATA}")
        for r in store.repos():
            print(f"  {r['id']:<40} {r['status']:<8} {r['stats'].get('levels')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
