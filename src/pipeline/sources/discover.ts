import Parser from "rss-parser";
import { parseHTML } from "linkedom";
import type { SourceConfig } from "./config.js";
import { fetchText } from "./http.js";

/** A candidate item discovered from a source listing, before the article page is fetched. */
export interface DiscoveredItem {
  url: string;
  title?: string;
  publishedAt?: Date;
  imageUrl?: string;
  /** Text available directly from the feed (used when the page is not fetched). */
  feedText?: string;
  /** True when feedText is the full content and the page need not be fetched. */
  feedOnly?: boolean;
}

const parser = new Parser({
  customFields: { item: [["media:content", "mediaContent"], ["media:thumbnail", "mediaThumbnail"], ["media:group", "mediaGroup"]] },
});

export function stripHtml(html: string): string {
  if (!html) return "";
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function firstImage(html?: string): string | undefined {
  return html ? /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] : undefined;
}

function parseDate(s?: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function parseFeed(xml: string, source: SourceConfig): Promise<DiscoveredItem[]> {
  // Some feeds include stray characters before the XML declaration or bare "&".
  const cleaned = xml.replace(/^[^<]+/, "").replace(/&(?!#?[a-zA-Z0-9]+;)/g, "&amp;");
  const feed = await parser.parseString(cleaned);
  return feed.items
    .filter((it) => it.link)
    .map((it: any) => {
      const html: string = it["content:encoded"] ?? it.content ?? "";
      const media = it.mediaContent?.$?.url ?? it.mediaThumbnail?.$?.url ?? it.mediaGroup?.["media:thumbnail"]?.[0]?.$?.url;
      const description = it.mediaGroup?.["media:description"]?.[0] ?? "";
      const feedOnly = source.kind === "youtube" || source.kind === "reddit";
      return {
        url: String(it.link).trim(),
        title: it.title?.trim(),
        publishedAt: parseDate(it.isoDate ?? it.pubDate),
        imageUrl: it.enclosure?.url ?? media ?? firstImage(html),
        feedText: stripHtml(html || description || it.contentSnippet || ""),
        feedOnly,
      };
    });
}

/** Collect article links matching the source's link_pattern from a listing page. */
export function extractLinks(html: string, baseUrl: string, pattern: string): string[] {
  const re = new RegExp(pattern);
  const { document } = parseHTML(html);
  const seen = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString().split("#")[0];
    } catch {
      continue;
    }
    if (re.test(abs) || re.test(decodeURI(abs))) seen.add(abs);
  }
  return [...seen];
}

export async function discover(source: SourceConfig): Promise<DiscoveredItem[]> {
  const page = await fetchText(source.url);
  if (source.kind === "html") {
    return extractLinks(page.text, page.url, source.link_pattern!).map((url) => ({ url }));
  }
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(page.text.slice(0, 5000))) {
    throw new Error(`Not a feed (HTTP ${page.status}, ${page.contentType || "no content-type"}): likely bot protection or a moved URL`);
  }
  return parseFeed(page.text, source);
}
