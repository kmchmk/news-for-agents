import { query, toVector } from "../lib/db.js";
import { createEmbedder, type Embedder } from "../pipeline/llm/index.js";
import { compact } from "./params.js";

export const ARTICLE_COLS = `a.id::int, a.title, a.summary, a.category, a.language, a.source_id as source, a.url,
  coalesce(nullif(a.image_cdn_url, ''), a.image_url) as image, a.published_at, a.story_id::int as story_id,
  a.importance, a.keywords`;

export const STORY_COLS = `s.id::int, s.title, s.summary, s.category, s.status, s.importance, s.article_count, s.source_count,
  s.first_seen_at, s.last_updated_at, s.keywords, s.community`;

const TSQUERY = `(websearch_to_tsquery('simple', $Q) || websearch_to_tsquery('english', $Q))`;
const tsq = (placeholder: string) => TSQUERY.replaceAll("$Q", placeholder);

export interface ListFilters {
  text: string | null;
  categories: string[];
  languages: string[];
  sources: string[];
  since: Date | null;
  until: Date | null;
  minImportance: number;
  limit: number;
  offset: number;
}

/** Builds a WHERE clause incrementally with numbered params. */
class Where {
  parts: string[] = [];
  params: unknown[] = [];
  add(sql: (p: (v: unknown) => string) => string) {
    this.parts.push(sql((v) => `$${this.params.push(v)}`));
  }
  get sql() {
    return this.parts.length ? `where ${this.parts.join(" and ")}` : "";
  }
  param(v: unknown) {
    return `$${this.params.push(v)}`;
  }
}

export async function listArticles(f: ListFilters & { storyId?: number }) {
  const w = new Where();
  w.add(() => `a.status = 'analyzed'`);
  if (f.text) w.add((p) => `a.search @@ ${tsq(p(f.text))}`);
  if (f.categories.length) w.add((p) => `a.category = any(${p(f.categories)})`);
  if (f.languages.length) w.add((p) => `a.language = any(${p(f.languages)})`);
  if (f.sources.length) w.add((p) => `a.source_id = any(${p(f.sources)})`);
  if (f.since) w.add((p) => `a.published_at >= ${p(f.since)}`);
  if (f.until) w.add((p) => `a.published_at < ${p(f.until)}`);
  if (f.minImportance > 1) w.add((p) => `a.importance >= ${p(f.minImportance)}`);
  if (f.storyId) w.add((p) => `a.story_id = ${p(f.storyId)}`);
  const rows = await query(
    `select ${ARTICLE_COLS} from articles a ${w.sql}
      order by a.published_at desc nulls last, a.id desc
      limit ${w.param(f.limit + 1)} offset ${w.param(f.offset)}`,
    w.params,
  );
  return page(rows.map(compact), f);
}

export async function listStories(f: ListFilters & { statuses: string[]; community?: number; sort: "recent" | "importance" }) {
  const w = new Where();
  if (f.text) w.add((p) => `s.search @@ ${tsq(p(f.text))}`);
  if (f.categories.length) w.add((p) => `s.category = any(${p(f.categories)})`);
  if (f.statuses.length) w.add((p) => `s.status = any(${p(f.statuses)})`);
  if (f.since) w.add((p) => `s.last_updated_at >= ${p(f.since)}`);
  if (f.until) w.add((p) => `s.first_seen_at < ${p(f.until)}`);
  if (f.minImportance > 1) w.add((p) => `s.importance >= ${p(f.minImportance)}`);
  if (f.languages.length || f.sources.length) {
    w.add(
      (p) =>
        `exists (select 1 from articles a where a.story_id = s.id` +
        (f.languages.length ? ` and a.language = any(${p(f.languages)})` : "") +
        (f.sources.length ? ` and a.source_id = any(${p(f.sources)})` : "") +
        `)`,
    );
  }
  if (f.community !== undefined) w.add((p) => `s.community = ${p(f.community)}`);
  const order =
    f.sort === "importance"
      ? `s.importance desc, s.source_count desc, s.last_updated_at desc`
      : `s.last_updated_at desc, s.id desc`;
  const rows = await query(
    `select ${STORY_COLS} from stories s ${w.sql} order by ${order}
      limit ${w.param(f.limit + 1)} offset ${w.param(f.offset)}`,
    w.params,
  );
  return page(rows.map(compact), f);
}

function page<T>(rows: T[], f: { limit: number; offset: number }) {
  const more = rows.length > f.limit;
  return { results: rows.slice(0, f.limit), next_offset: more ? f.offset + f.limit : null };
}

export async function getArticle(id: number) {
  const [a] = await query(
    `select ${ARTICLE_COLS}, a.original_title, s.name as source_name
       from articles a join sources s on s.id = a.source_id
      where a.id = $1 and a.status = 'analyzed'`,
    [id],
  );
  if (!a) return null;
  const entities = await query(
    `select e.id::int, e.name, e.type from article_entities ae join entities e on e.id = ae.entity_id where ae.article_id = $1`,
    [id],
  );
  return compact({ ...a, entities });
}

export async function getStory(id: number, timelineLimit: number) {
  const [s] = await query(`select ${STORY_COLS} from stories s where s.id = $1`, [id]);
  if (!s) return null;
  const timeline = await query(
    `select a.id::int, a.title, a.summary, a.source_id as source, a.language, a.url,
            coalesce(nullif(a.image_cdn_url, ''), a.image_url) as image, a.published_at
       from articles a where a.story_id = $1 order by a.published_at desc limit $2`,
    [id, timelineLimit],
  );
  const entities = await query(
    `select e.id::int, e.name, e.type, se.mentions from story_entities se join entities e on e.id = se.entity_id
      where se.story_id = $1 order by se.mentions desc, e.name limit 25`,
    [id],
  );
  const related = await relatedStories(id, 10);
  return compact({ ...s, timeline: timeline.map(compact), entities, related });
}

export async function relatedStories(id: number, limit: number) {
  const rows = await query(
    `select o.id::int, o.title, o.last_updated_at, l.relation, l.weight, l.shared
       from story_links l
       join stories o on o.id = case when l.story_a = $1 then l.story_b else l.story_a end
      where l.story_a = $1 or l.story_b = $1
      order by l.weight desc limit $2`,
    [id, limit],
  );
  return rows.map(compact);
}

export async function listEntities(opts: { q: string | null; types: string[]; limit: number; offset: number }) {
  const w = new Where();
  if (opts.q) w.add((p) => `(e.name ilike ${p(`%${opts.q}%`)} or e.name % ${p(opts.q)})`);
  if (opts.types.length) w.add((p) => `e.type = any(${p(opts.types)})`);
  const rows = await query(
    `select e.id::int, e.name, e.type, count(se.story_id)::int as story_count, max(s.last_updated_at) as last_seen_at
       from entities e
       left join story_entities se on se.entity_id = e.id
       left join stories s on s.id = se.story_id
       ${w.sql}
      group by e.id order by story_count desc, last_seen_at desc nulls last
      limit ${w.param(opts.limit + 1)} offset ${w.param(opts.offset)}`,
    w.params,
  );
  return page(rows.map(compact), opts);
}

export async function getEntity(id: number, limit: number) {
  const [e] = await query(`select id::int, name, type from entities where id = $1`, [id]);
  if (!e) return null;
  const stories = await query(
    `select ${STORY_COLS}, se.mentions from story_entities se join stories s on s.id = se.story_id
      where se.entity_id = $1 order by s.last_updated_at desc limit $2`,
    [id, limit],
  );
  return { ...e, stories: stories.map(compact) };
}

// ---------------------------------------------------------------- search

let embedder: Embedder | null | undefined;
const queryCache = new Map<string, number[]>();

export function semanticAvailable(): boolean {
  const p = process.env.EMBEDDING_PROVIDER;
  return !!p && p !== "none";
}

async function embedQuery(q: string): Promise<number[] | null> {
  if (!semanticAvailable()) return null;
  embedder ??= createEmbedder();
  if (!embedder) return null;
  const cached = queryCache.get(q);
  if (cached) return cached;
  const [v] = await embedder.embed([q], "query");
  if (queryCache.size > 500) queryCache.clear();
  queryCache.set(q, v);
  return v;
}

export async function search(opts: {
  q: string;
  type: "stories" | "articles";
  mode: "keyword" | "semantic" | "hybrid";
  since: Date | null;
  limit: number;
}) {
  let mode = opts.mode;
  const vec = mode === "keyword" ? null : await embedQuery(opts.q).catch(() => null);
  if (!vec) mode = "keyword";
  const table = opts.type === "stories" ? "stories s" : "articles a";
  const alias = opts.type === "stories" ? "s" : "a";
  const cols = opts.type === "stories" ? STORY_COLS : ARTICLE_COLS;
  const timeCol = opts.type === "stories" ? "s.last_updated_at" : "a.published_at";
  const base = opts.type === "articles" ? `a.status = 'analyzed'` : "true";
  const since = opts.since ?? new Date(0);
  let sql: string;
  let params: unknown[];
  if (mode === "keyword") {
    params = [opts.q, since, opts.limit];
    sql = `select ${cols}, round(ts_rank(${alias}.search, ${tsq("$1")})::numeric, 4)::float as score
             from ${table}
            where ${base} and ${timeCol} >= $2 and ${alias}.search @@ ${tsq("$1")}
            order by score desc, ${timeCol} desc limit $3`;
  } else {
    // Semantic: cosine similarity. Hybrid: similarity plus a bonus for keyword matches.
    // Every parameter must appear in the SQL (Postgres can't type an unused one).
    params = [toVector(vec), since, opts.limit];
    let kw = "";
    if (mode === "hybrid") {
      params.push(opts.q);
      kw = ` + case when ${alias}.search @@ ${tsq("$4")} then 0.1 else 0 end`;
    }
    sql = `select ${cols}, round((1 - (${alias}.embedding <=> $1::vector)${kw})::numeric, 4)::float as score
             from ${table}
            where ${base} and ${timeCol} >= $2 and ${alias}.embedding is not null
            order by score desc limit $3`;
  }
  const rows = await query(sql, params);
  return { mode, results: rows.map(compact) };
}

// ---------------------------------------------------------------- digest / meta

export async function digest(since: Date, limit: number) {
  // Rank by importance, breadth of coverage and recency.
  const rows = await query(
    `select ${STORY_COLS},
            (s.importance * 2 + least(s.source_count, 5) + least(s.article_count, 10) * 0.3
             - extract(epoch from (now() - s.last_updated_at)) / 86400.0) as rank
       from stories s where s.last_updated_at >= $1
      order by rank desc limit $2`,
    [since, limit],
  );
  return rows.map(({ rank, ...r }) => compact(r));
}

export async function status() {
  const [row] = await query(
    `select (select count(*) from articles where status='analyzed')::int as articles,
            (select count(*) from stories)::int as stories,
            (select count(*) from entities)::int as entities,
            (select count(*) from story_links)::int as story_links,
            (select max(published_at) from articles where status='analyzed') as newest_article_at,
            (select max(finished_at) from pipeline_runs) as last_pipeline_run_at`,
  );
  return row;
}

export async function sources() {
  return query(
    `select s.id, s.name, s.language, s.kind, coalesce(s.home_url, s.url) as url, s.last_fetched_at,
            count(a.id)::int as articles
       from sources s left join articles a on a.source_id = s.id and a.status = 'analyzed'
      where s.enabled group by s.id order by s.language, s.id`,
  );
}
