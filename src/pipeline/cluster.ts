/**
 * Story clustering: attach each analyzed article to an existing story or start a new one,
 * then refresh running story summaries.
 */
import { query, toVector } from "../lib/db.js";
import { RETENTION_DAYS } from "../lib/config.js";
import type { LLM } from "./llm/index.js";
import { normalize } from "./llm/index.js";
import { MATCH_SYSTEM, STORY_SYSTEM, StoryMatchSchema, StorySummarySchema, matchPrompt, storyPrompt, type StorySummary } from "./prompts.js";
import type { Logger } from "./log.js";

/** Cosine similarity at/above which an article joins a story without asking the LLM. */
const AUTO_JOIN = Number(process.env.STORY_AUTO_JOIN ?? 0.9);
/** Candidates at/above this similarity (or sharing enough entities) are shown to the LLM. */
const CANDIDATE_MIN = Number(process.env.STORY_CANDIDATE_MIN ?? 0.72);
/** Without an LLM, join when similarity is at least this. */
const HEURISTIC_JOIN = Number(process.env.STORY_HEURISTIC_JOIN ?? 0.85);

interface UnassignedArticle {
  id: number;
  title: string;
  summary: string;
  category: string | null;
  keywords: string[];
  importance: number | null;
  published_at: Date;
  embedding: string | null;
}

interface Candidate {
  id: number;
  title: string;
  summary: string;
  sim: number; // cosine similarity (0 when no embeddings)
  shared: number; // shared non-location entities
}

export function parseVector(v: string | null): number[] | null {
  return v ? (JSON.parse(v) as number[]) : null;
}

async function findCandidates(a: UnassignedArticle): Promise<Candidate[]> {
  const byId = new Map<number, Candidate>();
  if (a.embedding) {
    const rows = await query<{ id: number; title: string; summary: string; sim: number }>(
      `select id::int, title, summary, 1 - (embedding <=> $1::vector) as sim
         from stories
        where embedding is not null and last_updated_at > now() - make_interval(days => $2)
        order by embedding <=> $1::vector
        limit 5`,
      [a.embedding, RETENTION_DAYS],
    );
    for (const r of rows) byId.set(r.id, { ...r, sim: Number(r.sim), shared: 0 });
  }
  const shared = await query<{ id: number; title: string; summary: string; shared: number }>(
    `select s.id::int, s.title, s.summary, count(distinct ae2.entity_id)::int as shared
       from article_entities ae1
       join entities e on e.id = ae1.entity_id and e.type <> 'location'
       join article_entities ae2 on ae2.entity_id = ae1.entity_id and ae2.article_id <> ae1.article_id
       join articles a2 on a2.id = ae2.article_id
       join stories s on s.id = a2.story_id
      where ae1.article_id = $1 and s.last_updated_at > now() - make_interval(days => $2)
      group by s.id
      order by shared desc
      limit 5`,
    [a.id, RETENTION_DAYS],
  );
  for (const r of shared) {
    const c = byId.get(r.id);
    if (c) c.shared = r.shared;
    else byId.set(r.id, { ...r, sim: 0, shared: r.shared });
  }
  return [...byId.values()].sort((x, y) => y.sim - x.sim || y.shared - x.shared);
}

/** Decide which story (if any) an article joins. Exported for tests. */
export async function chooseStory(
  a: { title: string; summary: string },
  candidates: Candidate[],
  llm: LLM | null,
): Promise<number | null> {
  if (!candidates.length) return null;
  const best = candidates[0];
  if (best.sim >= AUTO_JOIN) return best.id;
  const plausible = candidates.filter((c) => c.sim >= CANDIDATE_MIN || c.shared >= 2).slice(0, 5);
  if (!plausible.length) return null;
  if (!llm) {
    // Without an LLM: strong similarity, or good similarity backed by a shared entity, or many shared entities.
    const h = plausible.find((c) => c.sim >= HEURISTIC_JOIN || (c.sim >= HEURISTIC_JOIN - 0.05 && c.shared >= 1) || c.shared >= 3);
    return h?.id ?? null;
  }
  const { story_id } = await llm.generateJSON({ system: MATCH_SYSTEM, prompt: matchPrompt(a, plausible), schema: StoryMatchSchema });
  return story_id !== null && plausible.some((c) => c.id === story_id) ? story_id : null;
}

async function createStory(a: UnassignedArticle): Promise<number> {
  const [row] = await query<{ id: number }>(
    `insert into stories (title, summary, category, keywords, importance, article_count, source_count,
                          first_seen_at, last_updated_at, embedding, search)
     values ($1,$2,$3,$4,$5,0,0,$6,$6,$7::vector,
             setweight(to_tsvector('simple', $1), 'A') || setweight(to_tsvector('english', $2), 'B'))
     returning id::int`,
    [a.title, a.summary, a.category, a.keywords, a.importance ?? 2, a.published_at, a.embedding],
  );
  return row.id;
}

async function attach(storyId: number, a: UnassignedArticle): Promise<void> {
  await query(`update articles set story_id = $2 where id = $1`, [a.id, storyId]);
  const [s] = await query<{ embedding: string | null; article_count: number }>(
    `select embedding::text, article_count from stories where id = $1`,
    [storyId],
  );
  // Running mean of member embeddings (the story centroid).
  let centroid: number[] | null = parseVector(s.embedding);
  const v = parseVector(a.embedding);
  if (v) {
    const n = s.article_count;
    centroid = centroid && n > 0 ? normalize(centroid.map((x, i) => (x * n + v[i]) / (n + 1))) : v;
  }
  await query(
    `update stories set
        article_count = article_count + 1,
        source_count = (select count(distinct source_id) from articles where story_id = $1),
        first_seen_at = least(first_seen_at, $2),
        last_updated_at = greatest(last_updated_at, $2),
        importance = greatest(importance, coalesce($3, importance)),
        embedding = coalesce($4::vector, embedding),
        summary_stale = article_count + 1 > 1
      where id = $1`,
    [storyId, a.published_at, a.importance, toVector(centroid)],
  );
}

export async function assignStories(opts: { llm: LLM | null; log: Logger }): Promise<{ joined: number; created: number }> {
  const rows = await query<UnassignedArticle>(
    `select id::int, title, summary, category, keywords, importance,
            coalesce(published_at, fetched_at) as published_at, embedding::text
       from articles
      where status = 'analyzed' and story_id is null
      order by coalesce(published_at, fetched_at) asc`,
  );
  const stats = { joined: 0, created: 0 };
  for (const a of rows) {
    let storyId: number | null = null;
    try {
      storyId = await chooseStory(a, await findCandidates(a), opts.llm);
    } catch (e) {
      opts.log(`  article ${a.id}: story match failed (${(e as Error).message}); starting new story`);
    }
    if (storyId === null) {
      storyId = await createStory(a);
      stats.created++;
    } else {
      stats.joined++;
    }
    await attach(storyId, a);
  }
  return stats;
}

// ---------------------------------------------------------------- story summaries

export interface StaleStory {
  id: number;
  articles: { published_at: string | null; source: string; title: string; summary: string }[];
}

export async function loadStaleStories(limit: number): Promise<StaleStory[]> {
  const stories = await query<{ id: number }>(
    `select id::int from stories where summary_stale order by last_updated_at desc limit $1`,
    [limit],
  );
  const out: StaleStory[] = [];
  for (const { id } of stories) {
    // The latest 20 reports, oldest first.
    const articles = await query<StaleStory["articles"][number]>(
      `select * from (
         select to_char(a.published_at at time zone 'Asia/Colombo', 'YYYY-MM-DD HH24:MI') as published_at,
                s.name as source, a.title, a.summary, a.published_at as ts
           from articles a join sources s on s.id = a.source_id
          where a.story_id = $1 order by a.published_at desc limit 20) t
       order by ts asc`,
      [id],
    );
    out.push({ id, articles: articles.map(({ published_at, source, title, summary }) => ({ published_at, source, title, summary })) });
  }
  return out;
}

export async function saveStorySummary(storyId: number, s: StorySummary): Promise<void> {
  await query(
    `update stories set title = $2, summary = $3, status = $4, keywords = $5, summary_stale = false,
        category = coalesce((select category from articles where story_id = $1 and category is not null
                             group by category order by count(*) desc limit 1), category),
        search = setweight(to_tsvector('simple', $2), 'A')
              || setweight(to_tsvector('simple', array_to_string($5::text[], ' ')), 'A')
              || setweight(to_tsvector('english', $3), 'B')
      where id = $1`,
    [storyId, s.title, s.summary, s.status, s.keywords.map((k) => k.toLowerCase())],
  );
}

export async function summarizeStories(opts: { llm: LLM | null; limit?: number; log: Logger }): Promise<{ summarized: number }> {
  const stale = await loadStaleStories(opts.limit ?? 100);
  let summarized = 0;
  for (const story of stale) {
    try {
      if (opts.llm) {
        const s = await opts.llm.generateJSON({ system: STORY_SYSTEM, prompt: storyPrompt(story.articles), schema: StorySummarySchema });
        await saveStorySummary(story.id, s);
      } else {
        // No LLM: keep the first title and use the latest report as the summary. The story stays
        // stale so an LLM run or `export stories` can write a proper summary later.
        const latest = story.articles[story.articles.length - 1];
        await query(
          `update stories set summary = $2, status = 'ongoing' where id = $1`,
          [story.id, latest ? `Latest: ${latest.summary}` : ""],
        );
      }
      summarized++;
    } catch (e) {
      opts.log(`  story ${story.id}: summary failed (${(e as Error).message})`);
    }
  }
  return { summarized };
}
