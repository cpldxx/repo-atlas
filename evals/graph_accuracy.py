"""Check the stored call graph against the source: does each caller's code really mention what it is said to call?
And, the other way, how many calls written in the code made it into the graph?"""
import re, sqlite3, sys, random, json
from pathlib import Path
from repo_atlas import config

rid = sys.argv[1]
src_root = config.repo_paths(rid)[0]
c = sqlite3.connect(config.DB_PATH); c.row_factory = sqlite3.Row
nodes = {r["id"]: dict(r) for r in c.execute("select * from nodes where repo_id=?", (rid,))}
files = {}
def lines(path):
    if path not in files:
        p = src_root / path
        files[path] = p.read_text(errors="replace").splitlines() if p.is_file() else []
    return files[path]
def body(n):
    """The symbol's code: to its recorded end line, or (when none is recorded) until the next line indented no deeper
    than its own first line, the way Python and most JS/TS code is laid out."""
    if not n.get("path") or not n.get("line"): return None
    ls = lines(n["path"])
    if not ls: return None
    a = n["line"] - 1
    if n.get("end_line") and n["end_line"] > n["line"] and n.get("kind") != "class":   # a class runs on through its methods
        return "\n".join(ls[a:n["end_line"]])
    ind = len(ls[a]) - len(ls[a].lstrip())
    b = a + 1
    while b < len(ls) and b - a < 400:
        t = ls[b]
        if t.strip() and (len(t) - len(t.lstrip())) <= ind and not t.lstrip().startswith((")", "]", "}")):
            break
        b += 1
    return "\n".join(ls[a:b])
def name(n):
    lab = n["label"].strip()
    lab = lab[:-2] if lab.endswith("()") else lab
    return lab.split(".")[-1].lstrip(".")

sym = {k: n for k, n in nodes.items() if n["level"] == 0 and n["kind"] != "external"}
edges = [dict(r) for r in c.execute("select src,dst,calls,uses,weight from edges where repo_id=? and level=0", (rid,))]
checked = found = 0; misses = []; no_body = 0
for e in edges:
    a, b = nodes.get(e["src"]), nodes.get(e["dst"])
    if not a or not b or a["level"] != 0 or b["level"] != 0: continue
    text = body(a)
    if text is None: no_body += 1; continue
    nm = name(b)
    if not nm or not re.match(r"^[A-Za-z_]\w*$", nm): continue
    checked += 1
    if re.search(r"\b" + re.escape(nm) + r"\b", text): found += 1
    else: misses.append(f"{a['label']} ({a['path']}:{a['line']}) -> {b['label']}")

# the other way: calls written in a function's body to a name defined exactly once in the repo
by_name = {}
for k, n in sym.items():
    if n.get("path") and n.get("line"): by_name.setdefault(name(n), []).append(k)
unique = {nm: ks[0] for nm, ks in by_name.items() if len(ks) == 1 and len(nm) > 3}
have = {(e["src"], e["dst"]) for e in edges}
call_re = re.compile(r"(?<![\w.])([A-Za-z_]\w*)\s*\(")
want = got = 0; missing = []
for k, n in sym.items():
    if not n["label"].endswith("()"): continue
    text = body(n)
    if not text: continue
    first = text.split("\n", 1)[1] if "\n" in text else ""   # skip the def line itself
    for m in set(call_re.findall(first)):
        t = unique.get(m)
        if not t or t == k: continue
        want += 1
        if (k, t) in have: got += 1
        else: missing.append(f"{n['label']} ({n['path']}) calls {m}()")
print(json.dumps({
  "repo": rid, "symbols": len(sym), "edges_L0": len(edges),
  "precision": {"checked": checked, "confirmed_in_source": found, "rate": round(found / max(1, checked), 3), "skipped_no_source": no_body},
  "recall_estimate": {"calls_in_source_to_unique_names": want, "in_graph": got, "rate": round(got / max(1, want), 3)},
  "not_confirmed_examples": misses[:8], "missing_examples": random.Random(1).sample(missing, min(8, len(missing))),
}, indent=1))
