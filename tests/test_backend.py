"""Fast checks that need no network and no model: URL parsing, layering on a small hand-made graph, and the API."""
import pytest

from repo_atlas import ingest, layering


def sym(i, label, path, line, cls=False):
    n = {"id": i, "label": label, "file_type": "code", "source_file": path, "source_location": f"L{line}", "_callable": True}
    if cls:
        n["_callable_class"] = True
    return n


def file_node(i, path):
    return {"id": i, "label": path.split("/")[-1], "file_type": "code", "source_file": path, "source_location": "L1"}


def link(a, b, rel):
    return {"source": a, "target": b, "relation": rel}


GRAPH = {
    "nodes": [
        file_node("app_main", "app/main.py"), sym("dispatch", "dispatch()", "app/main.py", 3),
        file_node("auth_service", "app/auth/service.py"), sym("login", "login()", "app/auth/service.py", 5),
        sym("check", "check_pw()", "app/auth/service.py", 20),
        sym("Auth", "Auth", "app/auth/service.py", 30, cls=True), sym("Auth_ok", ".ok()", "app/auth/service.py", 32),
        file_node("store_users", "app/store/users.py"), sym("get_user", "get_user()", "app/store/users.py", 2),
        file_node("t_auth", "tests/test_auth.py"), sym("test_login", "test_login()", "tests/test_auth.py", 4),
        *[file_node(f"filler{i}", path) for i, path in enumerate(  # enough files for the app area to be split
            ["app/auth/tokens.py", "app/auth/routes.py", "app/auth/hash.py", "app/store/orders.py", "app/store/db.py"])],
        {"id": "sqlalchemy", "label": "sqlalchemy", "file_type": "concept", "source_file": "", "external": True, "type": "external"},
        {"id": "cfg", "label": "name", "file_type": "code", "source_file": "ci.yml", "source_location": "L1"},
        {"id": "r1", "label": "Checks the password hash.", "file_type": "rationale", "source_file": "app/auth/service.py", "source_location": "L21"},
    ],
    "links": [
        link("dispatch", "login", "calls"), link("login", "check", "calls"), link("check", "get_user", "calls"),
        link("test_login", "login", "calls"), link("store_users", "sqlalchemy", "imports"),
        link("Auth", "Auth_ok", "method"), link("r1", "check", "rationale_for"),
        link("auth_service", "login", "contains"),
    ],
}


@pytest.fixture(scope="module")
def built():
    return layering.build(GRAPH)


def by_id(built):
    return {n["id"]: n for n in built["nodes"]}


def test_parse_url_accepts_the_usual_forms():
    for u in ("https://github.com/pallets/flask", "https://github.com/pallets/flask.git", "github.com/pallets/flask/tree/main/src",
              "pallets/flask", "https://github.com/pallets/flask?tab=readme-ov-file", "https://github.com/pallets/flask#readme",
              "https://github.com/pallets/flask.git?x=1"):
        assert ingest.parse_url(u) == ("pallets", "flask")


@pytest.mark.parametrize("bad", ["", "https://gitlab.com/a/b", "https://github.com/a", "--upload-pack=x", "a/b/c", "file:///etc"])
def test_parse_url_rejects_everything_else(bad):
    with pytest.raises(ValueError):
        ingest.parse_url(bad)


def test_levels_and_containment(built):
    n = by_id(built)
    assert built["stats"]["levels"] == {"0": 7, "1": 9, "2": 4, "3": 4, "4": 3}
    assert "f:ci.yml" not in n                              # config files are not part of the map
    assert n["s:check"]["parent"] == "f:app/auth/service.py"
    assert n["f:app/auth/service.py"]["parent"] == "m:app/auth"
    assert n["s:check"]["anc"][2:] == ["m:app/auth", "c:app/auth", "a:app:app"]
    assert n["s:test_login"]["role"] == "tests" and n["s:login"]["role"] == "app"
    assert n["s:check"]["doc"] == "Checks the password hash."
    assert n["s:Auth_ok"]["label"] == "Auth.ok()" and n["s:Auth_ok"]["kind"] == "method"
    assert n["s:Auth"]["meta"]["members"] == ["s:Auth_ok"]
    assert n["s:login"]["end_line"] == 19


def test_higher_level_arrows_come_from_real_calls(built):
    e = {(x["level"], x["src"], x["dst"]): x for x in built["edges"]}
    assert e[(0, "s:login", "s:check")]["calls"] == 1
    assert (3, "c:app", "c:app/auth") in e and (3, "c:app/auth", "c:app/store") in e
    assert (3, "c:app/store", "c:app/auth") not in e           # nothing in store calls auth
    assert e[(4, "a:app:app", "a:external")]["uses"] == 1
    assert e[(4, "a:tests", "a:app:app")]["calls"] == 1
    assert (1, "f:app/auth/service.py", "f:app/auth/service.py") not in e


def test_left_to_right_order_follows_the_calls(built):
    n = by_id(built)
    assert n["c:app"]["rank"] < n["c:app/auth"]["rank"] < n["c:app/store"]["rank"]
    assert n["s:dispatch"]["rank"] < n["s:login"]["rank"] < n["s:check"]["rank"] < n["s:get_user"]["rank"]
    assert n["s:dispatch"]["entry"] and not n["s:login"]["entry"]


def test_split_components_breaks_up_a_dominant_folder():
    dirs = {"src/a": 10, "src/b": 10, "src/c/x": 30, "src/c/y": 30}
    cut = layering.split_components(dirs, 2, 6)
    assert sorted(it["dir"] for it in cut) == ["src/a", "src/b", "src/c/x", "src/c/y"]
    many = {f"pkg/p{i}": 1 for i in range(40)}
    assert len(layering.split_components(many, 2, 8)) <= 14


def test_code_of_a_function_without_an_end_line_stops_at_the_next_one():
    from repo_atlas import query
    src = ("def first(a):", "    if a:", "        return 1", "", "    return 2", "", "def second():", "    pass",
           "class K:", "    def m(self):", "        x = call(", "            1,", "        )", "        return x", "    def n(self):", "        pass")
    assert query._block_end(src, 1) == 5        # stops before `def second`, skipping the blank line
    assert query._block_end(src, 10) == 14      # a method: a closing bracket at a shallower depth doesn't end it
    assert query._block_end(src, 7) == 8


def test_code_of_a_function_keeps_going_through_a_multi_line_string():
    from repo_atlas import query
    src = ("def usage():", '    text = """', "Usage: tool [options]", "", "  -h  help", '"""', "    return text", "",
           "def after():", "    return '\"\"\"'", "",
           "def sql():", "    q = '''", "SELECT 1", "'''  # it's done", "    return q", "", "X = 1")
    assert query._block_end(src, 1) == 7        # column-0 lines inside the triple-quoted string don't end it
    assert query._block_end(src, 9) == 10       # triple quotes inside an ordinary string open nothing
    assert query._block_end(src, 12) == 16      # the string closes mid-line; the next column-0 line still ends it


def test_top_level_code_and_constants_survive_odd_lines(monkeypatch):
    from repo_atlas import query
    src = ("import x", "(async () => {", "  await main()", "})()", 'PATTERN = r"[("', "LIMIT = 3")
    monkeypatch.setattr(query, "_source_lines", lambda rid, n: src)
    assert query.top_level("r", {"path": "a.js"}).splitlines()[0] == "import x"   # a line opening with "(" used to crash
    assert query.constants_used("r", {"path": "a.js"}, "re.match(PATTERN) and LIMIT") == ['PATTERN = r"[("', "LIMIT = 3"]


def test_class_code_runs_through_its_methods(tmp_path, monkeypatch):
    from repo_atlas import config, query
    monkeypatch.setattr(config, "REPOS", tmp_path / "repos")
    f = tmp_path / "repos" / "o__r" / "src" / "k.py"
    f.parent.mkdir(parents=True)
    f.write_text('class K:\n    """Doc."""\n    x = 1\n\n    def a(self):\n        return 1\n\n    def b(self):\n        return 2\n\ndef after():\n    pass\n')
    # the stored end line (4) stops where the first method starts; the code shown must still include the methods
    snip = query.snippet("o__r", {"level": 0, "path": "k.py", "line": 1, "end_line": 4, "kind": "class"})
    assert (snip["start"], snip["end"]) == (1, 9) and snip["text"].splitlines()[-1].strip() == "return 2"
    fn = query.snippet("o__r", {"level": 0, "path": "k.py", "line": 5, "end_line": 7, "kind": "method"})
    assert (fn["start"], fn["end"]) == (5, 7)   # anything else keeps its stored end line


def test_api_on_a_stored_graph(built, tmp_path, monkeypatch):
    from repo_atlas import config, llm, store
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "atlas.db")
    monkeypatch.setattr(config, "REPOS", tmp_path / "repos")
    monkeypatch.setattr(config, "SETTINGS_PATH", tmp_path / "config.json")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(llm, "models", lambda refresh=False: [])   # no model: everything else must still work
    store.init()
    store.upsert_repo("o__r", url="https://github.com/o/r", owner="o", name="r", commit_sha="abc", status="ready", stage="done")
    store.replace_graph("o__r", built["nodes"], built["edges"])
    src = tmp_path / "repos" / "o__r" / "src" / "app" / "auth"
    src.mkdir(parents=True)
    (src / "service.py").write_text("\n".join(f"line {i}" for i in range(1, 41)))

    from fastapi.testclient import TestClient
    from repo_atlas.api import app
    c = TestClient(app)
    assert c.get("/api/health").json()["ok"] is True
    page = c.get("/")   # the page's files are always checked for a newer version (old package timestamps)
    assert page.status_code == 200 and page.headers["cache-control"] == "no-cache"
    assert [l["count"] for l in c.get("/api/repos/o__r").json()["layers"]] == [3, 4, 4, 9, 7]
    lay = c.get("/api/repos/o__r/layers/3").json()
    assert {n["id"] for n in lay["nodes"]} == {"c:app", "c:app/auth", "c:app/store", "c:tests:tests"}
    assert any(l["source"] == "c:app/auth" and l["target"] == "c:app/store" for l in lay["links"])

    f = c.get("/api/repos/o__r/focus", params={"node": "c:app/auth"}).json()
    rows = {r["level"]: {i["id"]: i["relation"] for i in r["items"]} for r in f["levels"]}
    assert rows[4] == {"a:app:app": "ancestor"}
    assert rows[3] == {"c:app": "caller", "c:tests:tests": "caller", "c:app/auth": "self", "c:app/store": "callee"}
    assert rows[0]["s:login"] == "descendant" and rows[0]["s:dispatch"] == "caller" and rows[0]["s:get_user"] == "callee"
    shown = {i for r in rows.values() for i in r}
    assert all(l["source"] in shown and l["target"] in shown for l in f["links"])
    assert {"source": "c:app/auth", "target": "m:app/auth", "kind": "contains", "level": 2} in f["links"]

    d = c.get("/api/repos/o__r/node", params={"node": "s:login"}).json()
    assert d["url"] == "https://github.com/o/r/blob/abc/app/auth/service.py#L5-L19"
    assert d["snippet"]["text"].splitlines()[0] == "line 5" and d["snippet"]["end"] == 19
    assert [x["id"] for x in d["calls"]] == ["s:check"] and {x["id"] for x in d["called_by"]} == {"s:dispatch", "s:test_login"}

    top = c.get("/api/repos/o__r/branch", params={"rel": "inside"}).json()
    assert top["node"] is None and top["total"] == 3 and top["items"][0]["id"] == "a:app:app"
    assert top["items"][0]["counts"]["inside"] > 0
    calls = c.get("/api/repos/o__r/branch", params={"rel": "calls", "node": "s:login"}).json()
    assert [i["id"] for i in calls["items"]] == ["s:check"] and calls["items"][0]["counts"] == {"inside": 0, "calls": 1, "callers": 1}
    callers = c.get("/api/repos/o__r/branch", params={"rel": "callers", "node": "s:login", "limit": 1}).json()
    assert callers["total"] == 2 and len(callers["items"]) == 1
    # a part whose only child repeats its name is stepped through: component app/auth -> folder auth -> its files
    inside = c.get("/api/repos/o__r/branch", params={"rel": "inside", "node": "c:app/auth"}).json()
    assert {i["id"] for i in inside["items"]} == {"f:app/auth/hash.py", "f:app/auth/routes.py", "f:app/auth/service.py", "f:app/auth/tokens.py"}
    tests_area = next(i for i in top["items"] if i["id"] == "a:tests")
    assert tests_area["counts"]["inside"] == 1   # tests -> tests -> tests -> test_auth.py
    assert [i["id"] for i in c.get("/api/repos/o__r/branch", params={"rel": "inside", "node": "a:tests"}).json()["items"]] == ["f:tests/test_auth.py"]
    store_comp = c.get("/api/repos/o__r/branch", params={"rel": "inside", "node": "a:app:app"}).json()
    assert {i["id"] for i in store_comp["items"]} == {"c:app", "c:app/auth", "c:app/store"}   # three children: nothing to step through
    assert c.get("/api/repos/o__r/branch", params={"rel": "calls"}).status_code == 404
    assert c.get("/api/repos/o__r/branch", params={"rel": "sideways", "node": "s:login"}).status_code == 422

    hits = c.get("/api/repos/o__r/search", params={"q": "check password"}).json()
    assert hits[0]["id"] == "s:check"
    a = c.post("/api/repos/o__r/ask", json={"question": "login", "node": "c:app/auth", "stream": False}).json()
    assert a["model"] is None and a["sources"][0]["id"] == "c:app/auth" and a["answer"]
    assert c.get("/api/repos/nope/focus", params={"node": "x"}).status_code == 404
    assert c.get("/api/repos/o__r/focus", params={"node": "missing"}).status_code == 404
    assert c.post("/api/repos", json={"url": "https://example.com/x/y"}).status_code == 422


def test_search_falls_back_to_words_when_the_query_cannot_be_embedded(built, tmp_path, monkeypatch):
    import httpx
    import numpy as np
    from repo_atlas import config, llm, retrieve, store
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "atlas.db")
    monkeypatch.setattr(config, "REPOS", tmp_path / "repos")
    monkeypatch.setattr(config, "SETTINGS_PATH", tmp_path / "config.json")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(retrieve, "_cache", {})
    monkeypatch.setattr(llm, "models", lambda refresh=False: [])   # no chat model: the question returns its sources
    store.init()
    store.upsert_repo("o__v", url="https://github.com/o/v", owner="o", name="v", status="ready", stage="done")
    store.replace_graph("o__v", built["nodes"], built["edges"])
    one = np.ones(4, dtype=np.float32) / 2   # the repository was indexed with a 4-number embedding model
    store.save_vecs("o__v", [(n["id"], one.tobytes()) for n in store.all_nodes("o__v")])

    def stopped(texts):
        raise httpx.ConnectError("connection refused")
    for embed in (stopped, lambda texts: [[0.1] * 8]):   # Ollama went away / the embedding model changed since then
        monkeypatch.setattr(llm, "embed", embed)
        assert retrieve.search("o__v", "check password")[0]["id"] == "s:check"
        events = list(retrieve.ask("o__v", "check password"))
        assert events[0]["type"] == "sources" and events[-1]["type"] == "done"
