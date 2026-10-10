import { query } from "../lib/db.js";
import { loadSources, type SourceConfig } from "./sources/config.js";
import { discover, type DiscoveredItem } from "./sources/discover.js";
import { extractArticle } from "./sources/extract.js";
import { fetchText, mapLimit } from "./sources/http.js";
import type { Logger } from "./log.js";

const MAX_TEXT_CHARS = 20_000;

/** Normalize article URLs so the same article isn't stored twice. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    }
    if (u.protocol === "http:") u.protocol = "https:";
    // Store Sinhala/Tamil paths readable (decoded IRI): ~3x fewer tokens than %-encoding.
    const s = u.toString();
    try {
      return decodeURI(s);
    } catch {
      return s;
    }
  } catch {
    return raw.trim();
  }
}

/** Date embedded in article URLs like /2026/10/08/slug. */
export function dateFromUrl(url: string): Date | undefined {
  const m = /\/(20\d\d)\/(\d\d)\/(\d\d)\//.exec(url);
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T06:30:00Z`); // noon in Sri Lanka
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const SL_OFFSET_MS = 5.5 * 3600_000;

/**
 * Some sites label Sri Lanka local time as GMT, producing timestamps in the future.
 * Shift such dates back by UTC+5:30, and clamp anything still in the future to now.
 */
export function fixPublishedAt(d: Date | undefined, now = new Date()): Date | undefined {
  if (!d) return d;
  const skew = 15 * 60_000;
  if (d.getTime() > now.getTime() + skew) d = new Date(d.getTime() - SL_OFFSET_MS);
  if (d.getTime() > now.getTime() + skew) d = now;
  return d;
}

/** Upsert sources from config into the DB (config is the source of truth). */
export async function syncSources(sources: SourceConfig[] = loadSources()): Promise<void> {
  for (const s of sources) {
    await query(
      `insert into sources (id, name, kind, url, home_url, language, enabled)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set name=excluded.name, kind=excluded.kind, url=excluded.url,
         home_url=excluded.home_url, language=excluded.language, enabled=excluded.enabled`,
      [s.id, s.name, s.kind, s.url, s.home_url ?? null, s.language, s.enabled],
    );
  }
  // Sources removed from config are disabled (not deleted, so their articles stay attributed).
  await query(`update sources set enabled = false where not (id = any($1))`, [sources.map((s) => s.id)]);
}

export interface FetchOptions {
  only?: string[]; // source ids
  maxAgeHours?: number; // ignore items older than this
  log: Logger;
}

export interface FetchStats {
  sources: number;
  discovered: number;
  inserted: number;
  skipped: number;
  errors: number;
}

export async function fetchSources(opts: FetchOptions): Promise<FetchStats> {
  const all = loadSources();
  await syncSources(all);
  const selected = all.filter((s) => (opts.only?.length ? opts.only.includes(s.id) : s.enabled));
  const stats: FetchStats = { sources: selected.length, discovered: 0, inserted: 0, skipped: 0, errors: 0 };
  const maxAgeMs = (opts.maxAgeHours ?? 72) * 3600_000;

  await mapLimit(selected, 4, async (source) => {
    try {
      const items = await discover(source);
      stats.discovered += items.length;
      const byUrl = new Map<string, DiscoveredItem>();
      for (const it of items) byUrl.set(canonicalUrl(it.url), { ...it, url: canonicalUrl(it.url) });
      const known = new Set(
        (await query<{ url: string }>(`select url from articles where url = any($1)`, [[...byUrl.keys()]])).map((r) => r.url),
      );
      const fresh = [...byUrl.values()].filter((it) => !known.has(it.url)).slice(0, source.max_items);

      let ok = 0;
      await mapLimit(fresh, 3, async (item) => {
        const r = await ingestItem(source, item, maxAgeMs);
        if (r === "inserted") ok++;
        if (r === "skipped") stats.skipped++;
        if (r === "error") stats.errors++;
      });
      stats.inserted += ok;
      await query(`update sources set last_fetched_at = now(), last_error = null where id = $1`, [source.id]);
      opts.log(`  ${source.id}: ${items.length} listed, ${fresh.length} new, ${ok} stored`);
    } catch (e) {
      stats.errors++;
      const msg = (e as Error).message;
      await query(`update sources set last_error = $2 where id = $1`, [source.id, msg.slice(0, 500)]);
      opts.log(`  ${source.id}: ERROR ${msg}`);
    }
  });
  return stats;
}

async function ingestItem(source: SourceConfig, item: DiscoveredItem, maxAgeMs: number): Promise<"inserted" | "skipped" | "error"> {
  let title = item.title;
  let text = item.feedText ?? "";
  let imageUrl = item.imageUrl;
  let publishedAt = item.publishedAt;

  if (!item.feedOnly) {
    try {
      const page = await fetchText(item.url);
      const ex = extractArticle(page.text, page.url);
      if (ex.text.length > text.length) text = ex.text;
      title = title || ex.title;
      imageUrl = imageUrl || ex.imageUrl;
      publishedAt = publishedAt ?? ex.publishedAt;
    } catch (e) {
      if (!text) {
        // Not stored, so the item is retried on the next run.
        return "error";
      }
    }
  }

  publishedAt = fixPublishedAt(publishedAt ?? dateFromUrl(item.url));
  const tooOld = publishedAt && Date.now() - publishedAt.getTime() > maxAgeMs;
  const empty = !title && text.length < 40;
  const status = tooOld || empty ? "skipped" : "pending";
  await query(
    `insert into articles (source_id, url, status, language, original_title, raw_text, image_url, published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (url) do nothing`,
    [
      source.id,
      item.url,
      status,
      source.language,
      title ?? null,
      status === "pending" ? text.slice(0, MAX_TEXT_CHARS) : null,
      imageUrl ?? null,
      publishedAt ?? new Date(),
    ],
  );
  return status === "pending" ? "inserted" : "skipped";
}

/** Fetch a single page; exported for debugging source configs. */
export async function previewArticle(url: string) {
  const page = await fetchText(url);
  return extractArticle(page.text, page.url);
}
