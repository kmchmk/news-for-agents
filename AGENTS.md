# Runbook for agents operating this repo

This file is for an AI agent that the admin asks to **update the news** (run the pipeline) or to
work on the code. If you are an agent that wants to *read* news, use the API instead
([docs/API.md](docs/API.md)).

## Update the news

Prerequisites: `npm install`, and a `.env` with `DATABASE_URL`. Check what is configured:

```bash
npm run news -- stats
```

### Option A: built-in LLM provider (preferred when `.env` has one)
```bash
npm run news -- run
```
This runs fetch → analyze → images → cluster → link → prune in one command. It is idempotent and safe to re-run.
Override the provider for one run with `--llm gemini|anthropic|openai` and `--embedding gemini|openai|none`.

### Option B: you are the LLM (no API key needed)
Use this when no provider is configured, or when the admin asks you to do the analysis yourself.

1. `npm run news -- fetch`
2. `npm run news -- export articles --limit 25 --out work/articles.json`
3. Read `work/articles.json`. For every entry in `items`, follow `instructions` and produce an object
   matching `result_schema`. Put them in `results` as `[{"id": <item id>, "analysis": {...}}]` and
   set `"model"` to your model name. Rules:
   - Sinhala and Tamil articles must be translated faithfully into the English title and summary. Do not invent facts.
   - Mark ads, sponsored content, horoscopes, gossip and religious sermons `"relevant": false`.
   - Use canonical English entity names, so the same person or organization gets the same name every time.
4. `npm run news -- import work/articles.json`. This embeds your summaries with `EMBEDDING_PROVIDER` from `.env`;
   if none is configured, add `--embedding none`.
5. Repeat steps 2–4 until `export` returns no items.
6. `npm run news -- cluster --llm none`. Stories are matched by embeddings and shared entities, without LLM calls.
7. Optionally write story summaries yourself: `npm run news -- export stories --out work/stories.json`,
   fill in `results` as `[{"id": <story id>, "summary": {...}}]`, then `npm run news -- import work/stories.json`.
8. `npm run news -- link` and then `npm run news -- prune`.

Don't commit anything under `work/`; it is gitignored.

## Troubleshooting
- `npm run news -- sources` shows `last_error` for each source. A `403`, `429` or "Not a feed … bot
  protection" error means the site blocked this IP; it usually works from a residential connection.
- To test one source without the database: `npm run news -- test-source <id>`.
- Articles that fail analysis 3 times are marked `failed` and are not retried.

## Code map
- `src/pipeline/`: CLI (`cli.ts`), fetching (`sources/`), LLM providers (`llm/`), analysis prompts and
  schemas (`prompts.ts`), story clustering (`cluster.ts`), graph building with graphology (`link.ts`),
  retention (`prune.ts`), R2 images (`images.ts`), external-agent export/import (`agent-io.ts`).
- `src/api/`: Hono REST API (`app.ts`), queries (`data.ts`), graph traversal (`graph.ts`).
- `api/index.ts`: the Vercel entry point. `db/schema.sql`: the schema. `config/sources.yaml`: the sources.
