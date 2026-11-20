"""Model settings, the local-only guard, and the Claude provider's request shape (against a fake API server)."""
import json
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def env(tmp_path, monkeypatch):
    from repo_atlas import config, llm, store
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "atlas.db")
    monkeypatch.setattr(config, "REPOS", tmp_path / "repos")
    monkeypatch.setattr(config, "SETTINGS_PATH", tmp_path / "config.json")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(llm, "models", lambda refresh=False: [])
    store.init()
    from repo_atlas.api import app
    return TestClient(app), llm, tmp_path


def test_other_sites_and_rebinding_hosts_are_refused(env):
    c, _, _ = env
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/health", headers={"origin": "http://127.0.0.1:47821"}).status_code == 200
    assert c.post("/api/repos", json={"url": "a/b"}, headers={"origin": "https://evil.example"}).status_code == 403
    assert c.put("/api/settings", json={"provider": "none"}, headers={"origin": "http://localhost.evil.example"}).status_code == 403
    assert c.get("/api/health", headers={"host": "attacker.example:47821"}).status_code == 403


def test_settings_never_return_the_key_and_file_is_private(env):
    c, llm, tmp = env
    st = c.get("/api/settings").json()
    assert st["provider"] == "none" and st["chat_model"] is None and st["anthropic"]["key"] is False
    r = c.put("/api/settings", json={"provider": "anthropic", "anthropic_api_key": "sk-ant-test-123456789abcd"})
    body = r.json()
    assert r.status_code == 200 and "sk-ant-test" not in json.dumps(body)
    assert body["anthropic"] == {"key": True, "key_source": "saved", "key_hint": "…abcd", "model": "claude-opus-5-5",
                                 "models": llm.CLAUDE_MODELS}
    assert body["provider"] == "anthropic" and body["chat_model"] == "claude-opus-5-5"
    assert stat.S_IMODE(os.stat(tmp / "config.json").st_mode) == 0o600
    assert c.put("/api/settings", json={"anthropic_model": "gpt-4"}).status_code == 422
    assert c.put("/api/settings", json={"ollama_url": "file:///etc"}).status_code == 422
    assert c.put("/api/settings", json={"provider": "magic"}).status_code == 422


def test_environment_key_wins_and_is_not_saved(env, monkeypatch):
    c, llm, tmp = env
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-env-wxyz")
    st = c.get("/api/settings").json()
    assert st["provider"] == "anthropic" and st["anthropic"]["key_source"] == "env" and st["anthropic"]["key_hint"] == "…wxyz"
    assert not (tmp / "config.json").exists()


class FakeClaude(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # current SDKs send the key as a bearer token; older ones as x-api-key
        key = self.headers.get("x-api-key") or (self.headers.get("authorization") or "").removeprefix("Bearer ")
        FakeClaude.seen.append({"path": self.path, "key": key})
        if key != "sk-good":
            return self._send(401, json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}))
        self._send(200, json.dumps({"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                                    "created_at": "2026-01-01T00:00:00Z"}))

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        FakeClaude.seen.append({"path": self.path, "beta": self.headers.get("anthropic-beta"), "body": body})
        msg = {"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"], "stop_reason": None,
               "stop_sequence": None, "usage": {"input_tokens": 3, "output_tokens": 1}}
        if body.get("stream"):
            events = [("message_start", {"type": "message_start", "message": {**msg, "content": []}}),
                      ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                      ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Login is "}}),
                      ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "handled in auth.py [1]."}}),
                      ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                      ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 9}}),
                      ("message_stop", {"type": "message_stop"})]
            return self._send(200, "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events), "text/event-stream")
        text = 'Here you go:\n{"p1": {"title": "Auth", "summary": "Signs people in."}}'
        self._send(200, json.dumps({**msg, "content": [{"type": "text", "text": text}], "stop_reason": "end_turn"}))


@pytest.fixture
def fake_claude(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeClaude)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}")
    FakeClaude.seen = []
    yield FakeClaude.seen
    server.shutdown()


def test_claude_requests_have_the_right_shape(env, fake_claude, monkeypatch):
    c, llm, _ = env
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-good")
    msgs = [{"role": "system", "content": "You describe code."}, {"role": "user", "content": "Name p1."}]

    out = llm.chat(msgs, json_mode=True, temperature=0.1, effort="low")
    assert json.loads(out) == {"p1": {"title": "Auth", "summary": "Signs people in."}}
    req = fake_claude[-1]
    assert req["path"].startswith("/v1/messages") and req["beta"] == "server-side-fallback-2026-07-01"
    b = req["body"]
    assert b["model"] == "claude-opus-5-5" and b["fallbacks"] == "default" and b["output_config"] == {"effort": "low"}
    assert b["system"].startswith("You describe code.") and "JSON" in b["system"]
    assert b["messages"] == [{"role": "user", "content": "Name p1."}]
    assert "temperature" not in b and "thinking" not in b

    assert "".join(llm.chat_stream(msgs)) == "Login is handled in auth.py [1]."
    assert fake_claude[-1]["body"]["stream"] is True and fake_claude[-1]["body"]["max_tokens"] == 64000

    llm.save_settings({"anthropic_model": "claude-haiku-5-5"})
    llm.chat(msgs)
    assert "fallbacks" not in fake_claude[-1]["body"] and fake_claude[-1]["beta"] is None   # Haiku has no server-side fallback

    assert c.post("/api/settings/check").json() == {"ok": True, "message": "Connected to Claude (claude-haiku-5-5)."}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-bad")
    assert c.post("/api/settings/check").json() == {"ok": False, "message": "That API key was rejected."}
