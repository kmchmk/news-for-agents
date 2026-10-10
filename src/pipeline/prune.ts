/**
 * Retention: news older than RETENTION_DAYS is removed, except stories that are still
 * receiving updates. A story is the retention unit: while any new article joins it within
 * the window, the whole story history (all its articles) is kept.
 */
import { query } from "../lib/db.js";
import { RETENTION_DAYS } from "../lib/config.js";
import { deleteImages } from "./images.js";
import type { Logger } from "./log.js";

export async function prune(opts: { log: Logger; days?: number }): Promise<{ stories: number; articles: number; entities: number }> {
  const days = opts.days ?? RETENTION_DAYS;

  const images = await query<{ url: string }>(
    `select a.image_cdn_url as url from articles a
       left join stories s on s.id = a.story_id
      where a.image_cdn_url is not null
        and ((s.id is not null and s.last_updated_at < now() - make_interval(days => $1))
          or (s.id is null and coalesce(a.published_at, a.fetched_at) < now() - make_interval(days => $1)))`,
    [days],
  );

  const stories = await query(`delete from stories where last_updated_at < now() - make_interval(days => $1) returning id`, [days]);
  // Articles never attached to a story (skipped/failed/pending) expire on their own date.
  const articles = await query(
    `delete from articles where story_id is null and coalesce(published_at, fetched_at) < now() - make_interval(days => $1) returning id`,
    [days],
  );
  const entities = await query(
    `delete from entities e where not exists (select 1 from article_entities ae where ae.entity_id = e.id) returning id`,
  );
  await query(`delete from pipeline_runs where started_at < now() - interval '90 days'`);

  try {
    await deleteImages(images.map((r) => r.url));
  } catch (e) {
    opts.log(`  prune: image cleanup failed (${(e as Error).message})`);
  }
  const stats = { stories: stories.length, articles: articles.length, entities: entities.length };
  opts.log(`  prune: removed ${stats.stories} stories, ${stats.articles} loose articles, ${stats.entities} entities`);
  return stats;
}
