import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { CATEGORIES, ENTITY_TYPES, RETENTION_DAYS } from "../lib/config.js";
import * as data from "./data.js";
import { NODE_TYPES, expand, neighborhood, parseNodeId, type NodeType } from "./graph.js";
import { BadRequest, parseCategory, parseIntParam, parseList, parseSince, textQuery } from "./params.js";
import { rateLimit } from "./ratelimit.js";

export const app = new Hono();

/** CDN cache lifetime for successful GETs: the main shield against traffic spikes. */
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS ?? 120);

app.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));
app.use("/v1/*", rateLimit({ perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60) }));
app.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && c.res.status === 200 && !c.res.headers.get("Cache-Control")) {
    c.header("Cache-Control", `public, max-age=60, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=600`);
  }
});

app.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: "bad_request", message: err.message }, 400);
  console.error(err);
  return c.json({ error: "internal_error", message: "Something went wrong." }, 500);
});
app.notFound((c) => c.json({ error: "not_found", message: "Unknown endpoint. GET / lists all endpoints." }, 404));

function listFilters(c: Context, defLimit = 20) {
  return {
    text: textQuery(c.req.query("q"), parseList(c.req.query("keywords"))),
    categories: parseCategory(c.req.query("category")),
    languages: parseList(c.req.query("language")),
    sources: parseList(c.req.query("source")),
    since: parseSince(c.req.query("since")),
    until: parseSince(c.req.query("until")),
    minImportance: parseIntParam(c.req.query("min_importance"), 1, 1, 5, "min_importance"),
    limit: parseIntParam(c.req.query("limit"), defLimit, 1, 100, "limit"),
    offset: parseIntParam(c.req.query("offset"), 0, 0, 2000, "offset"),
  };
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequest("id must be a positive integer");
  return id;
}

// ---------------------------------------------------------------- discovery

app.get("/", (c) =>
  c.json({
    service: "News for Agents",
    description:
      "Pre-fetched, AI-summarized Sri Lankan news (sources in Sinhala, Tamil and English; all summaries in English) " +
      "organized as a graph of stories, articles and entities. Read-only JSON. Free, no key needed; please cache and stay under the rate limit.",
    coverage: { country: "Sri Lanka", retention_days: RETENTION_DAYS, note: "Ongoing stories keep their full history beyond the retention window." },
    rate_limit: `${process.env.RATE_LIMIT_PER_MINUTE ?? 60} requests/minute per IP`,
    tips: [
      "Start with GET /v1/digest for a briefing, or GET /v1/stories?since=24h to poll for updates.",
      "Stories group articles about the same event across outlets and languages; prefer them over raw articles.",
      "Follow links with GET /v1/graph/neighbors?node=story:<id> to explore related stories, people and organizations.",
      "Use since=<duration|ISO> (e.g. 6h, 2d) when polling so you only get new items.",
    ],
    endpoints: {
      "GET /v1/digest": "Top stories ranked by importance, coverage and recency. Params: since (default 24h), limit (≤50).",
      "GET /v1/stories": "List stories. Params: q, keywords (comma list, any match), category, language, source, status (developing|ongoing|concluded), since, until, min_importance (1-5), community, sort (recent|importance), limit (≤100), offset.",
      "GET /v1/stories/{id}": "One story: summary, timeline of articles (newest first), entities, related stories. Params: timeline_limit (≤100).",
      "GET /v1/news": "List articles (one per source report). Params: same filters as /v1/stories (without status/sort).",
      "GET /v1/articles/{id}": "One article with entities and a link to the original.",
      "GET /v1/search": "Search. Params: q (required), type (stories|articles), mode (keyword|semantic|hybrid), since, limit.",
      "GET /v1/entities": "People, organizations, locations, events, topics. Params: q, type, limit, offset.",
      "GET /v1/entities/{id}": "An entity and the stories involving it.",
      "GET /v1/graph/node/{node}": "A node and its direct neighbors and edges. node = story:<id> | article:<id> | entity:<id> | source:<id>.",
      "GET /v1/graph/neighbors": "Subgraph around a node via breadth-first traversal. Params: node (required), depth (1-3, default 1), types (comma list of story,article,entity,source; default story,entity), max_nodes (≤150).",
      "GET /v1/sources": "Configured news sources.",
      "GET /v1/status": "Counts and data freshness.",
    },
    enums: { category: CATEGORIES, entity_type: ENTITY_TYPES, language: ["si", "ta", "en"], importance: "1=trivial … 5=critical national" },
    semantic_search: data.semanticAvailable(),
  }),
);

// ---------------------------------------------------------------- v1

app.get("/v1/status", async (c) => c.json(await data.status()));
app.get("/v1/sources", async (c) => c.json({ results: await data.sources() }));

app.get("/v1/digest", async (c) => {
  const since = parseSince(c.req.query("since") ?? "24h")!;
  const limit = parseIntParam(c.req.query("limit"), 15, 1, 50, "limit");
  return c.json({ since, results: await data.digest(since, limit) });
});

app.get("/v1/stories", async (c) => {
  const sort = c.req.query("sort") ?? "recent";
  if (sort !== "recent" && sort !== "importance") throw new BadRequest("sort must be recent or importance");
  const community = c.req.query("community");
  return c.json(
    await data.listStories({
      ...listFilters(c),
      statuses: parseList(c.req.query("status")),
      community: community === undefined ? undefined : parseIntParam(community, 0, 0, 1e9, "community"),
      sort,
    }),
  );
});

app.get("/v1/stories/:id", async (c) => {
  const story = await data.getStory(idParam(c), parseIntParam(c.req.query("timeline_limit"), 30, 1, 100, "timeline_limit"));
  return story ? c.json(story) : c.json({ error: "not_found", message: "Story not found (it may have expired)." }, 404);
});

app.get("/v1/news", async (c) => c.json(await data.listArticles(listFilters(c))));

app.get("/v1/articles/:id", async (c) => {
  const article = await data.getArticle(idParam(c));
  return article ? c.json(article) : c.json({ error: "not_found", message: "Article not found (it may have expired)." }, 404);
});

app.get("/v1/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) throw new BadRequest("q is required");
  const type = c.req.query("type") ?? "stories";
  if (type !== "stories" && type !== "articles") throw new BadRequest("type must be stories or articles");
  const mode = c.req.query("mode") ?? "hybrid";
  if (mode !== "keyword" && mode !== "semantic" && mode !== "hybrid") throw new BadRequest("mode must be keyword, semantic or hybrid");
  return c.json(
    await data.search({
      q: q.slice(0, 300),
      type,
      mode,
      since: parseSince(c.req.query("since")),
      limit: parseIntParam(c.req.query("limit"), 20, 1, 50, "limit"),
    }),
  );
});

app.get("/v1/entities", async (c) =>
  c.json(
    await data.listEntities({
      q: c.req.query("q")?.trim().slice(0, 100) || null,
      types: parseList(c.req.query("type")),
      limit: parseIntParam(c.req.query("limit"), 20, 1, 100, "limit"),
      offset: parseIntParam(c.req.query("offset"), 0, 0, 2000, "offset"),
    }),
  ),
);

app.get("/v1/entities/:id", async (c) => {
  const entity = await data.getEntity(idParam(c), parseIntParam(c.req.query("limit"), 30, 1, 100, "limit"));
  return entity ? c.json(entity) : c.json({ error: "not_found", message: "Entity not found." }, 404);
});

app.get("/v1/graph/node/:node", async (c) => {
  const id = c.req.param("node");
  parseNodeId(id);
  const res = await expand(id);
  return res.node ? c.json(res) : c.json({ error: "not_found", message: `Node ${id} not found.` }, 404);
});

app.get("/v1/graph/neighbors", async (c) => {
  const node = c.req.query("node");
  if (!node) throw new BadRequest("node is required, e.g. node=story:12");
  parseNodeId(node);
  const types = parseList(c.req.query("types") ?? "story,entity");
  for (const t of types) if (!(NODE_TYPES as readonly string[]).includes(t)) throw new BadRequest(`Unknown node type "${t}"`);
  const res = await neighborhood(node, {
    depth: parseIntParam(c.req.query("depth"), 1, 1, 3, "depth"),
    types: types as NodeType[],
    maxNodes: parseIntParam(c.req.query("max_nodes"), 60, 1, 150, "max_nodes"),
  });
  return res ? c.json(res) : c.json({ error: "not_found", message: `Node ${node} not found.` }, 404);
});
