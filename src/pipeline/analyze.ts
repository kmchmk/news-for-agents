import { query, toVector } from "../lib/db.js";
import type { Embedder, LLM } from "./llm/index.js";
import { ARTICLE_SYSTEM, ArticleAnalysisSchema, articlePrompt, type ArticleAnalysis } from "./prompts.js";
import { mapLimit } from "./sources/http.js";
import type { Logger } from "./log.js";

export const MAX_PROMPT_CHARS = 6000;
const MAX_ATTEMPTS = 3;

export interface PendingArticle {
  id: number;
  source: string;
  url: string;
  original_title: string | null;
  published_at: string | null;
  text: string;
}

export async function loadPending(limit: number): Promise<PendingArticle[]> {
  return query<PendingArticle>(
    `select a.id::int, s.name as source, a.url, a.original_title,
            to_char(a.published_at at time zone 'Asia/Colombo', 'YYYY-MM-DD HH24:MI') as published_at,
            left(coalesce(a.raw_text, ''), $2) as text
       from articles a join sources s on s.id = a.source_id
      where a.status = 'pending' and a.attempts < $3
      order by a.published_at desc nulls last
      limit $1`,
    [limit, MAX_PROMPT_CHARS, MAX_ATTEMPTS],
  );
}

export function entitySlug(type: string, name: string): string {
  const norm = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-");
  return `${type}:${norm}`;
}

/** Text used for the article embedding. */
export function embeddingText(a: { title: string; summary: string; keywords?: string[] }): string {
  return `${a.title}\n${a.summary}\n${(a.keywords ?? []).join(", ")}`;
}

/** Persist an analysis result (from a built-in LLM or an external agent). */
export async function saveAnalysis(
  articleId: number,
  analysis: ArticleAnalysis,
  modelId: string,
  embedder: Embedder | null,
): Promise<void> {
  if (!analysis.relevant) {
    await query(
      `update articles set status='skipped', raw_text=null, analyzed_at=now(), analysis_model=$2,
              title=$3, summary=$4, language=coalesce($5, language)
        where id=$1`,
      [articleId, modelId, analysis.title, analysis.summary, analysis.language === "other" ? null : analysis.language],
    );
    return;
  }
  const keywords = [...new Set(analysis.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
  const [embedding] = embedder ? await embedder.embed([embeddingText({ ...analysis, keywords })], "document") : [null];

  await query(
    `update articles set
        status='analyzed', raw_text=null, analyzed_at=now(), analysis_model=$2, error=null,
        title=$3, summary=$4, category=$5, keywords=$6, importance=$7,
        language=coalesce($8, language), embedding=$9::vector,
        search = setweight(to_tsvector('simple', $3), 'A')
              || setweight(to_tsvector('simple', array_to_string($6::text[], ' ')), 'A')
              || setweight(to_tsvector('english', $4), 'B')
      where id=$1`,
    [
      articleId,
      modelId,
      analysis.title,
      analysis.summary,
      analysis.category,
      keywords,
      analysis.importance,
      analysis.language === "other" ? null : analysis.language,
      toVector(embedding),
    ],
  );

  await query(`delete from article_entities where article_id = $1`, [articleId]);
  const seen = new Set<string>();
  for (const e of analysis.entities) {
    const name = e.name.trim();
    const slug = entitySlug(e.type, name);
    if (!name || slug.endsWith(":") || seen.has(slug)) continue;
    seen.add(slug);
    const [row] = await query<{ id: number }>(
      `insert into entities (slug, name, type) values ($1,$2,$3)
       on conflict (slug) do update set name = entities.name
       returning id::int`,
      [slug, name, e.type],
    );
    await query(`insert into article_entities (article_id, entity_id) values ($1,$2) on conflict do nothing`, [articleId, row.id]);
  }
}

export interface AnalyzeOptions {
  llm: LLM;
  embedder: Embedder | null;
  limit?: number;
  concurrency?: number;
  log: Logger;
}

export async function analyzePending(opts: AnalyzeOptions): Promise<{ analyzed: number; skipped: number; failed: number }> {
  const pending = await loadPending(opts.limit ?? 200);
  const stats = { analyzed: 0, skipped: 0, failed: 0 };
  opts.log(`  analyzing ${pending.length} pending articles with ${opts.llm.id}`);

  await mapLimit(pending, opts.concurrency ?? 4, async (a) => {
    try {
      const analysis = await opts.llm.generateJSON({
        system: ARTICLE_SYSTEM,
        prompt: articlePrompt(a),
        schema: ArticleAnalysisSchema,
      });
      await saveAnalysis(a.id, analysis, opts.llm.id, opts.embedder);
      if (analysis.relevant) stats.analyzed++;
      else stats.skipped++;
    } catch (e) {
      stats.failed++;
      const msg = (e as Error).message.slice(0, 500);
      await query(
        `update articles set attempts = attempts + 1, error = $2,
                status = case when attempts + 1 >= $3 then 'failed' else status end
          where id = $1`,
        [a.id, msg, MAX_ATTEMPTS],
      );
      opts.log(`  article ${a.id}: ${msg}`);
    }
  });
  return stats;
}
