import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export interface ExtractedArticle {
  title?: string;
  text: string;
  imageUrl?: string;
  publishedAt?: Date;
}

function meta(document: any, ...names: string[]): string | undefined {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"]`) ?? document.querySelector(`meta[name="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
}

function jsonLdDate(document: any): string | undefined {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    const m = /"datePublished"\s*:\s*"([^"]+)"/.exec(s.textContent ?? "");
    if (m) return m[1];
  }
  return undefined;
}

/** Extract readable article text, lead image and publish time from an article page. */
export function extractArticle(html: string, url: string): ExtractedArticle {
  const { document } = parseHTML(html);
  const imageRaw = meta(document, "og:image", "twitter:image");
  const dateRaw =
    meta(document, "article:published_time", "og:published_time", "pubdate", "publishdate", "date") ?? jsonLdDate(document);
  const ogTitle = meta(document, "og:title");

  let text = "";
  let title: string | undefined;
  try {
    // Readability mutates the document, so read metadata first.
    const article = new Readability(document as any, { charThreshold: 200 }).parse();
    text = article?.textContent ?? "";
    title = article?.title ?? undefined;
  } catch {
    /* fall through to raw body text */
  }
  if (text.trim().length < 200) {
    const { document: fresh } = parseHTML(html);
    for (const el of fresh.querySelectorAll("script,style,nav,header,footer,aside,form")) el.remove();
    text = fresh.body?.textContent ?? text;
  }

  let imageUrl: string | undefined;
  if (imageRaw) {
    try {
      imageUrl = new URL(imageRaw, url).toString();
    } catch {
      /* ignore bad URL */
    }
  }
  const d = dateRaw ? new Date(dateRaw) : undefined;
  return {
    title: ogTitle ?? title,
    text: text.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(),
    imageUrl,
    publishedAt: d && !Number.isNaN(d.getTime()) ? d : undefined,
  };
}
