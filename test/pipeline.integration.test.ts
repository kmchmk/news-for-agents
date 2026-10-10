/**
 * End-to-end pipeline + API test against a real Postgres (with pgvector).
 * Runs only when TEST_DATABASE_URL is set; the database is wiped.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/news_test npm test
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("pipeline + API (integration)", () => {
  let db: typeof import("../src/lib/db.js");
  let app: typeof import("../src/api/app.js")["app"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = await import("../src/lib/db.js");
    await db.query(`drop table if exists pipeline_runs, story_links, story_entities, article_entities, entities, articles, stories, sources cascade`);
    await db.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    await db.query(`insert into sources (id, name, kind, url, language) values
      ('src-en','English Daily','rss','https://en.example.lk/rss','en'),
      ('src-si','Sinhala Daily','rss','https://si.example.lk/rss','si')`);
    app = (await import("../src/api/app.js")).app;
  });

  afterAll(async () => {
    await db?.closePool();
  });

  it("analyzes, clusters, links, serves and prunes", async () => {
    const { saveAnalysis } = await import("../src/pipeline/analyze.js");
    const { assignStories, summarizeStories } = await import("../src/pipeline/cluster.js");
    const { rebuildGraph } = await import("../src/pipeline/link.js");
    const { prune } = await import("../src/pipeline/prune.js");
    const { mockEmbedder } = await import("../src/pipeline/llm/index.js");
    const log = () => {};
    const embedder = mockEmbedder();

    const insert = async (source: string, url: string, hoursAgo: number) => {
      const [r] = await db.query<{ id: number }>(
        `insert into articles (source_id, url, raw_text, published_at) values ($1,$2,'text', now() - make_interval(hours => $3)) returning id::int`,
        [source, url, hoursAgo],
      );
      return r.id;
    };
    const flood = (title: string) => ({
      relevant: true,
      language: "en" as const,
      title,
      summary: "Heavy rain caused floods in Ratnapura district; the Disaster Management Centre issued warnings.",
      category: "weather_disaster" as const,
      keywords: ["floods", "ratnapura", "rain"],
      entities: [
        { name: "Disaster Management Centre", type: "organization" as const },
        { name: "Ratnapura", type: "location" as const },
      ],
      importance: 4,
    });

    const a1 = await insert("src-en", "https://en.example.lk/flood-1", 5);
    const a2 = await insert("src-si", "https://si.example.lk/flood-2", 2);
    const a3 = await insert("src-en", "https://en.example.lk/cricket", 1);
    const a4 = await insert("src-en", "https://en.example.lk/ad", 1);
    await saveAnalysis(a1, flood("Floods in Ratnapura district"), "test", embedder);
    await saveAnalysis(a2, { ...flood("Ratnapura floods: Disaster Management Centre warns"), language: "si" }, "test", embedder);
    await saveAnalysis(
      a3,
      {
        relevant: true,
        language: "en",
        title: "Sri Lanka beat Pakistan in Colombo ODI",
        summary: "Sri Lanka won the second ODI against Pakistan at R. Premadasa Stadium by five wickets.",
        category: "sports",
        keywords: ["cricket", "odi"],
        entities: [{ name: "Sri Lanka Cricket", type: "organization" }],
        importance: 2,
      },
      "test",
      embedder,
    );
    await saveAnalysis(a4, { ...flood("Buy now"), relevant: false }, "test", embedder);

    // A fake LLM that confirms the first candidate story and writes summaries.
    const llm: import("../src/pipeline/llm/index.js").LLM = {
      id: "fake",
      async generateJSON(req: any): Promise<any> {
        if ("story_id" in req.schema.shape) return { story_id: Number(/\[(\d+)\]/.exec(req.prompt)![1]) };
        return { title: "Ratnapura floods", summary: "Floods continue in Ratnapura.", status: "developing", keywords: ["floods"] };
      },
    };
    const assigned = await assignStories({ llm, log });
    expect(assigned).toEqual({ joined: 1, created: 2 });
    expect((await summarizeStories({ llm, log })).summarized).toBe(1);
    await rebuildGraph({ log });

    const get = async (path: string) => {
      const res = await app.request(path);
      return { status: res.status, body: (await res.json()) as any };
    };

    const stories = await get("/v1/stories?since=1d");
    expect(stories.status).toBe(200);
    expect(stories.body.results).toHaveLength(2);
    const floodStory = stories.body.results.find((s: any) => s.title === "Ratnapura floods");
    expect(floodStory.article_count).toBe(2);
    expect(floodStory.source_count).toBe(2);

    const detail = await get(`/v1/stories/${floodStory.id}`);
    expect(detail.body.timeline).toHaveLength(2);
    expect(detail.body.timeline[0].source).toBe("src-si"); // newest first
    expect(detail.body.entities.map((e: any) => e.name)).toContain("Disaster Management Centre");

    const news = await get("/v1/news?keywords=floods&language=si");
    expect(news.body.results.map((a: any) => a.id)).toEqual([a2]);

    const search = await get("/v1/search?q=ratnapura&type=articles&mode=keyword");
    expect(search.body.results).toHaveLength(2);

    const digest = await get("/v1/digest");
    expect(digest.body.results[0].id).toBe(floodStory.id);

    const graph = await get(`/v1/graph/neighbors?node=story:${floodStory.id}&depth=2&types=story,entity,article`);
    const ids = graph.body.nodes.map((n: any) => n.id);
    expect(ids[0]).toBe(`story:${floodStory.id}`);
    expect(ids).toContain(`article:${a1}`);
    expect(ids).toContain(`entity:${detail.body.entities[0].id}`);

    const entity = await get(`/v1/entities/${detail.body.entities[0].id}`);
    expect(entity.body.stories[0].id).toBe(floodStory.id);

    expect((await get("/v1/articles/" + a4)).status).toBe(404); // irrelevant items are not served
    expect((await get("/v1/stories?limit=1000")).status).toBe(400);

    // Retention: an old story is pruned unless it is still being updated.
    await db.query(`update stories set last_updated_at = now() - interval '40 days' where id <> $1`, [floodStory.id]);
    await db.query(`update articles set published_at = now() - interval '45 days' where id = $1`, [a1]);
    const pruned = await prune({ log });
    expect(pruned.stories).toBe(1); // the cricket story
    const kept = await get(`/v1/stories/${floodStory.id}`);
    expect(kept.body.timeline).toHaveLength(2); // old article kept because its story is ongoing
  });
});
