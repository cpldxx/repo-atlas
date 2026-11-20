"""RAG check against fastapi/full-stack-fastapi-template with the local Ollama model.
Each answer key comes from reading the source: facts are groups of words, one of which must appear in the answer.
Questions about things the repository does not contain must be answered with "not in the code"."""
import json, re, sys, time, urllib.request
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:47831"
import os
RID = os.environ.get("RID", "fastapi__full-stack-fastapi-template")
L = "s:backend_app_api_routes_login_login_access_token"
CASES = [
  dict(q="How does login create the access token?", facts=[["authenticate"], ["create_access_token"]], expect=[L, "s:backend_app_core_security_create_access_token"]),
  dict(q="How are user passwords hashed?", facts=[["argon2"]], expect=["s:backend_app_core_security_get_password_hash", "f:backend/app/core/security.py"]),
  dict(q="Which algorithm signs the access tokens?", facts=[["hs256"]], expect=["s:backend_app_core_security_create_access_token", "f:backend/app/core/security.py"]),
  dict(q="How does the backend find the current user from a request?", facts=[["decode"], ["secret_key", "secret key"]], expect=["s:backend_app_api_deps_get_current_user", "f:backend/app/api/deps.py"]),
  dict(q="What happens when an inactive user makes a request?", facts=[["400"], ["inactive"]], expect=["s:backend_app_api_deps_get_current_user", "f:backend/app/api/deps.py"]),
  dict(q="Who is allowed to delete an item?", facts=[["superuser"], ["owner"]], expect=["s:backend_app_api_routes_items_delete_item"]),
  dict(q="Which routers does the API include, and which one is only added in development?", facts=[["login"], ["items"], ["private"]], expect=["f:backend/app/api/main.py"]),
  dict(q="How does password recovery avoid revealing whether an email is registered?", facts=[["same", "always", "regardless"], ["enumeration", "registered", "exists", "exist"]], expect=["s:backend_app_api_routes_login_recover_password"]),
  dict(q="How is the database engine created?", facts=[["create_engine"], ["database_url"]], expect=["f:backend/app/core/db.py"]),
  dict(q="Which frontend component lets an admin add a new user?", facts=[["adduser"]], expect=["f:frontend/src/components/Admin/AddUser.tsx", "s:frontend_src_components_admin_adduser_adduser"]),
  dict(q="What does this return?", node=L, facts=[["token"], ["access_token", "access token"]], expect=[L]),
  dict(q="How does this project use Redis for caching?", negative=True),
  dict(q="Where is the GraphQL schema defined?", negative=True),
  dict(q="How is the current user loaded from the token?", then="And what happens if that user has been deactivated?",
       facts=[["400"], ["inactive"]], expect=["s:backend_app_api_deps_get_current_user"]),
]
if RID == "pallets__itsdangerous":
    CASES = [
      dict(q="Which hash function does a Signer use by default?", facts=[["sha1", "sha-1"]], expect=[]),
      dict(q="How is a signature checked so that timing attacks don't work?", facts=[["compare_digest"]], expect=[]),
      dict(q="What is the default key derivation?", facts=[["django-concat"]], expect=[]),
      dict(q="When does the URL-safe serializer compress the payload?", facts=[["zlib"], ["shorter", "smaller", "less than", "fewer", "only if", "only when"]], expect=[]),
      dict(q="Which error is raised when a timed signature is too old?", facts=[["signatureexpired"]], expect=[]),
      dict(q="How does itsdangerous store sessions in a database?", negative=True),
    ]
NEG = re.compile(r"\b(no|not|doesn't|does not|isn't|is not|none|nothing|cannot find|can't find|no mention|no evidence|don't|do not)\b", re.I)

def ask(question, node=None, history=None):
    body = {"question": question, "stream": False}
    if node: body["node"] = node
    if history: body["history"] = history
    req = urllib.request.Request(f"{BASE}/api/repos/{RID}/ask", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    out["seconds"] = round(time.time() - t, 1)
    return out

rows = []
for c in CASES:
    a = ask(c["q"], c.get("node"))
    if c.get("then"):
        a = ask(c["then"], history=[{"role": "user", "content": c["q"]}, {"role": "assistant", "content": a["answer"]}])
    text = a["answer"]; low = text.lower()
    src_ids = [s["id"] for s in a["sources"]]
    cited_ids = [s["id"] for s in a["sources"] if s["n"] in a["cited"]]
    marks = [int(m) for m in re.findall(r"\[(\d+)\]", text)]
    row = {"q": c["q"] + (f"  → then: {c['then']}" if c.get("then") else ""), "s": a["seconds"], "model": a["model"]}
    if c.get("negative"):
        row.update(kind="not in repo", ok=bool(NEG.search(text)), found=None, cited=None, facts=None)
    else:
        facts_ok = all(any(w in low for w in grp) for grp in c["facts"])
        row.update(kind="fact", found=any(e in src_ids for e in c["expect"]) if c["expect"] else None, cited=any(e in cited_ids for e in c["expect"]) if c["expect"] else None,
                   facts=facts_ok, ok=facts_ok)
    row["marks"] = len(marks); row["bad_marks"] = len([m for m in marks if m not in {s["n"] for s in a["sources"]}])
    row["answer"] = text.strip()
    rows.append(row)
    print(f"{'PASS' if row['ok'] else 'FAIL'}  {row['s']:>5}s  {row['q'][:70]}", flush=True)
json.dump(rows, open(sys.argv[2] if len(sys.argv) > 2 else "answers.json", "w"), indent=1, ensure_ascii=False)
facts = [r for r in rows if r["kind"] == "fact"]; neg = [r for r in rows if r["kind"] != "fact"]
print(json.dumps({
  "model": rows[0]["model"],
  "fact_questions": len(facts), "facts_correct": sum(r["facts"] for r in facts),
  "right_code_found": sum(bool(r["found"]) for r in facts), "right_code_cited": sum(bool(r["cited"]) for r in facts),
  "answers_with_citations": sum(r["marks"] > 0 for r in facts), "citations_to_nonexistent_sources": sum(r["bad_marks"] for r in rows),
  "not_in_repo_questions": len(neg), "said_not_found": sum(r["ok"] for r in neg),
  "median_seconds": sorted(r["s"] for r in rows)[len(rows) // 2],
}, indent=1))
