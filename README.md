# News for Agents 🇱🇰

Sri Lankan news for AI agents, without the token cost of browsing news sites.

A pipeline (run by the admin, locally or anywhere) fetches news from configured Sinhala, Tamil and
English sources, uses an LLM to turn each article into compact English JSON (summary, category,
entities, importance), groups reports about the same event into **stories**, and links stories,
articles and entities into a **graph**. A read-only REST API on Vercel lets any agent poll for
news and traverse the graph.

```
                 admin machine / any agent                              Vercel (free)            agents
 ┌──────────────────────────────────────────────────────────┐        ┌───────────────┐
 │ fetch ─► analyze (LLM) ─► cluster ─► link (graphology) ─► prune │ ─► Neon ◄─│  REST API     │ ◄── GET /v1/...
 │  RSS/HTML   Gemini/Claude/   stories    entity + similarity     │  Postgres  │  CDN-cached   │
 │             any agent                  edges, communities      │  +pgvector │  rate-limited │
 └──────────────────────────────────────────────────────────┘        └───────────────┘
                     │ lead images (optional)
                     └────────────► Cloudflare R2
```

- **API reference for agents:** [docs/API.md](docs/API.md). The live API also describes itself at `GET /`.
- **Runbook for the admin's agent (updating the news):** [AGENTS.md](AGENTS.md)

## Data model

| Node | What it is |
|---|---|
| `story` | One real-world event or developing situation, built from many articles across outlets and languages. Has a running summary, a status (`developing`, `ongoing` or `concluded`), an importance score and a Louvain `community` grouping related stories. |
| `article` | One report from one source: an English title and summary, plus a link to the original and an image URL. |
| `entity` | A person, organization, location, event or topic, with a canonical English name. |
| `source` | A configured outlet. |

Edges: `article -part_of-> story`, `article -mentions-> entity`, `story -involves-> entity`,
`story -related- story` (from IDF-weighted shared entities and embedding similarity, with the shared entity names kept on the edge),
`article -published_by-> source`.

**Retention:** a story and all of its articles are kept while the story keeps receiving new
articles. A story is deleted `RETENTION_DAYS` (30) days after its last update, so long-running stories keep
their full history. Articles that never joined a story expire 30 days after publication.

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and an LLM provider
npm run db:migrate
npm run news -- sources     # sync config/sources.yaml and list sources
npm run news -- run         # fetch → analyze → images → cluster → link → prune
npm run dev                 # local API at http://localhost:3000
```

### Neon (database)
1. Create a free project at neon.tech. Postgres 16+ is fine, and pgvector is built in.
2. Copy the **pooled** connection string into `DATABASE_URL`, both in `.env` and in Vercel.
3. Run `npm run db:migrate`.

Free tier: 0.5 GB of storage. 30 days of Sri Lankan news uses about 50–100 MB, because the full article
text is dropped after analysis and only the summaries are kept.

### Vercel (API)
1. Import this GitHub repo in Vercel. No build settings are needed: `api/index.ts` is the only function.
2. Set the environment variable `DATABASE_URL`. For semantic search, also set
   `EMBEDDING_PROVIDER=gemini` and `GEMINI_API_KEY`. The query embedding model must match the one the pipeline used.
3. Optional: in Vercel Firewall, add a rate-limit rule on `/v1/*` for extra protection.

Abuse and DDoS protection is layered:
- Every response is CDN-cacheable (`s-maxage=120`), so repeated requests never reach Neon.
- Vercel's platform DDoS mitigation is always on.
- There is a per-IP limit of 60 requests per minute per function instance.
- Every parameter (`limit`, `depth`, `offset`) has a hard cap.

### Google Cloud (LLM with your credits)
```bash
gcloud auth application-default login
gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT
# .env: LLM_PROVIDER=gemini, EMBEDDING_PROVIDER=gemini, GOOGLE_CLOUD_PROJECT=YOUR_PROJECT
```
Gemini on Vertex AI is billed to the project, so the credits apply. The default model is `gemini-flash-latest`;
pin a specific version with `GEMINI_MODEL`. Analysis takes one call per article, up to about 6k characters of
input, plus an occasional call for story matching or summarizing.

**Other LLMs:** use `LLM_PROVIDER=anthropic` or `openai` (any OpenAI-compatible endpoint, including local
Ollama), or use no API at all. In that case, `npm run news -- export articles` writes a self-describing
work file that any agent can fill in, and `npm run news -- import <file>` loads the results (see [AGENTS.md](AGENTS.md)).

### Cloudflare R2 (optional image mirror)
Without R2, the API returns the publishers' original image URLs. With R2, lead images are copied
to your bucket (free tier: 10 GB, no egress fees), so the URLs keep working:
1. Create an R2 bucket and enable its public `r2.dev` URL, or attach a custom domain.
2. Create an R2 API token with Object Read & Write on that bucket.
3. Set the `R2_*` variables in `.env`. Only the pipeline needs them, not Vercel.

## Sources

Sources are defined in [config/sources.yaml](config/sources.yaml); edit that file to add or disable one.
Supported kinds are `rss`, `html` (link discovery by regex), `youtube` and `reddit`.
Test a single source without touching the database:
```bash
npm run news -- test-source divaina
```
Some sites block datacenter IPs with 403 errors or captchas but work from a home connection. The
`enabled` flags reflect a probe from a cloud IP.

## Development
```bash
npm run typecheck
npm test                                             # unit tests
TEST_DATABASE_URL=postgres://…/news_test npm test    # + end-to-end pipeline/API test (wipes that DB)
```
