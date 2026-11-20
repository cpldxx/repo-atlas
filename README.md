# Repo Atlas

Paste a GitHub URL. Repo Atlas reads the repository once into a knowledge graph, shows it as five layers from the
big picture down to single functions, lets you open it branch by branch as a mind map (what is inside, what it
calls, what calls it), and answers questions about any part of it from the code itself. For anyone who wants to see
what a repository is, how it fits together and where to start reading.

Website: https://repo-atlas-677.pages.dev

## Install and run

```bash
npm create repo-atlas
```

That's it: the first run downloads the app (through [uv](https://docs.astral.sh/uv/), which it offers to install
if you don't have it), starts it on http://127.0.0.1:47821 and opens your browser. Later runs start in seconds.

Needs git (to download repositories). No account, no server: everything runs and stays on your computer, in
`~/.repo-atlas`.

### Connect a model (optional)

Names, descriptions and answers are written by a model you choose in **Settings** (the gear at the top right):

- **Ollama**, running locally. Any chat model works; `nomic-embed-text-v2-moe` adds search by meaning.
- **Claude**, with your own API key from console.anthropic.com. Paste it in Settings or start with
  `ANTHROPIC_API_KEY` set. Usage is billed to your Anthropic account.

Without a model, maps and search still work, and questions return the related code locations.

### Command line

```bash
npm create repo-atlas -- serve --port 8080 --no-open
npm create repo-atlas -- ingest https://github.com/pallets/flask
npm create repo-atlas -- ask pallets__flask "What happens when a request comes in?"
npm create repo-atlas -- status
```

## How it works

Graphify ([Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify), open source) parses the code locally
into a knowledge graph. Repo Atlas turns it into five layers and stores them in SQLite; the model only writes the
names and descriptions of the top two layers and answers questions from the code it is given.

## API (default port 47821)

| Request | What it does |
|---|---|
| `GET /api/health` | Server and local model status |
| `GET /api/repos` · `POST /api/repos {url, refresh?, lang?}` · `DELETE /api/repos/{id}` | List, start reading (in the background), delete |
| `GET /api/repos/{id}` | Progress (`status`, `stage`) and counts per layer |
| `GET /api/repos/{id}/layers/{0-4}?limit&offset&under` | One layer's nodes and arrows |
| `GET /api/repos/{id}/branch?rel=inside\|calls\|callers&node=&limit&offset` | One branch of the mind map: what is inside a node, what it calls, or what calls it (no node: the top-level areas) |
| `GET /api/repos/{id}/focus?node=` | Everything connected to one node, level by level |
| `GET /api/repos/{id}/node?node=` | Description, code snippet, GitHub link, callers and callees |
| `POST /api/repos/{id}/explain?node=` | One-sentence description (generated once, then stored) |
| `GET /api/repos/{id}/search?q=&k=&level=` | Search by name and meaning |
| `GET /api/repos/{id}/tour` | Overview: the main parts in reading order, entry points, most used |
| `POST /api/repos/{id}/ask {question, node?, level?, history?, stream?}` | Answer. SSE by default: `sources` → `delta`… → `done {cited}` |

## Develop

```bash
uv run repo-atlas serve
```

```bash
uv run pytest -q
```

`src/repo_atlas/` is the Python package (the UI is in `src/repo_atlas/web/`, plain HTML/CSS/JS with no build step),
`npm/` is the `npx` launcher, `site/` is the landing page. `REPO_ATLAS_FROM=./dist/<wheel>` makes the launcher run a
local build. Set `ATLAS_LANG=ko` for Korean names and answers, `ATLAS_DATA` for another data folder.

## Credits

Built on [Graphify](https://github.com/Graphify-Labs/graphify) (Apache-2.0 / MIT).
