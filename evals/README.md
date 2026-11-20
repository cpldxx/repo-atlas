# Checks

Two scripts that measure Repo Atlas against real repositories. Neither is part of the app.

## Is the graph right? `graph_accuracy.py`

For every function-to-function link in a stored repository, checks that the caller's code really mentions what it
is said to call (precision), and for calls written in the code to functions defined once in the repository, checks
that the graph has them (recall).

```bash
uv run python evals/graph_accuracy.py fastapi__full-stack-fastapi-template
```

## Are the answers right? `answers.py`

Asks a running Repo Atlas questions whose answers were checked by reading the source, plus questions about things
the repository doesn't contain, and a follow-up question. Scores the facts in each answer, whether the right code
was found and cited, whether the "not in this repository" questions were answered that way, and whether any answer
cites a source number that doesn't exist.

```bash
uv run repo-atlas serve --no-open            # in another terminal, with the repository already read
python3 evals/answers.py http://127.0.0.1:47821
RID=pallets__itsdangerous python3 evals/answers.py http://127.0.0.1:47821
```

## Results (2026-11-20, local Ollama `qwen3.6:35b`, embeddings `nomic-embed-text-v2-moe`)

| | fastapi/full-stack-fastapi-template | pallets/itsdangerous |
|---|---|---|
| Graph links confirmed in the source | 766 / 768 (99.7%) | 178 / 178 (100%) |
| Calls in the code found in the graph | 194 / 194 (100%) | 48 / 52 (92%) |
| Answers with the right facts | 11 / 12 | 5 / 5 |
| Right code found and cited | 12 / 12 | not scored |
| "Not in this repository" answered that way | 2 / 2 | 1 / 1 |
| Citations to sources that don't exist | 0 | 0 |
| Median time per answer | 13 s | 14 s |

The one fact miss: asked how the backend finds the current user, the answer was right (decode the JWT, look up the
user, check it is active) but didn't name `SECRET_KEY`, which the answer key requires.
