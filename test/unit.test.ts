import { describe, expect, it } from "vitest";
import { canonicalUrl, dateFromUrl, fixPublishedAt } from "../src/pipeline/fetch.js";
import { assertPublicUrl, decodeBody, detectCharset, isPublicAddress } from "../src/pipeline/sources/http.js";
import { extractLinks, parseFeed } from "../src/pipeline/sources/discover.js";
import { extractArticle } from "../src/pipeline/sources/extract.js";
import { entitySlug } from "../src/pipeline/analyze.js";
import { buildStoryGraph } from "../src/pipeline/link.js";
import { chooseStory } from "../src/pipeline/cluster.js";
import { parseJsonReply, mockEmbedder } from "../src/pipeline/llm/index.js";
import { parseSince, textQuery, compact } from "../src/api/params.js";
import { parseNodeId } from "../src/api/graph.js";
import { loadSources } from "../src/pipeline/sources/config.js";
import type { SourceConfig } from "../src/pipeline/sources/config.js";

const rssSource: SourceConfig = { id: "t", name: "T", kind: "rss", url: "https://example.lk/rss", language: "en", enabled: true, max_items: 25 };

describe("sources config", () => {
  it("loads and validates config/sources.yaml", () => {
    const sources = loadSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((s) => s.language === "si")).toBe(true);
    expect(sources.some((s) => s.language === "ta")).toBe(true);
  });
});

describe("fetching helpers", () => {
  it("canonicalizes URLs", () => {
    expect(canonicalUrl("http://example.lk/a?utm_source=x&id=2#top")).toBe("https://example.lk/a?id=2");
    expect(canonicalUrl("https://sinhala.newsfirst.lk/2026/10/10/%e0%b7%81%e0%b7%8a")).toBe("https://sinhala.newsfirst.lk/2026/10/10/ශ්");
  });

  it("blocks internal addresses (SSRF guard)", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["104.26.14.219", "8.8.8.8", "2606:4700::6810:ed3"]) expect(isPublicAddress(ip), ip).toBe(true);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/non-public/);
    await expect(assertPublicUrl("http://localhost:5432/")).rejects.toThrow(/non-public/);
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow(/non-public/);
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
  });

  it("reads dates from URLs", () => {
    expect(dateFromUrl("https://x.lk/2026/09/28/slug")?.toISOString()).toBe("2026-09-28T06:30:00.000Z");
    expect(dateFromUrl("https://x.lk/article/123")).toBeUndefined();
  });

  it("corrects local time mislabeled as GMT", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    // 17:00 "GMT" is really 17:00 Sri Lanka = 11:30 UTC
    expect(fixPublishedAt(new Date("2026-10-10T17:00:00Z"), now)?.toISOString()).toBe("2026-10-10T11:30:00.000Z");
    expect(fixPublishedAt(new Date("2026-10-11T12:00:00Z"), now)).toEqual(now);
    expect(fixPublishedAt(new Date("2026-10-10T11:00:00Z"), now)?.toISOString()).toBe("2026-10-10T11:00:00.000Z");
  });

  it("prefers UTF-8 when a feed mislabels its charset", () => {
    const bytes = new TextEncoder().encode("ශ්‍රී ලංකා");
    expect(detectCharset("text/xml;charset=iso-8859-1", "")).toBe("iso-8859-1");
    expect(decodeBody(bytes, "iso-8859-1")).toBe("ශ්‍රී ලංකා");
  });

  it("parses RSS with bare ampersands", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T & Co</title>
      <item><title>Rain & floods</title><link>https://example.lk/a</link><pubDate>Sat, 10 Oct 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Heavy rain <img src="https://example.lk/i.jpg"></p>]]></description></item></channel></rss>`;
    const items = await parseFeed(xml, rssSource);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Rain & floods");
    expect(items[0].publishedAt?.toISOString()).toBe("2026-10-10T10:00:00.000Z");
  });

  it("extracts article links by pattern", () => {
    const html = `<a href="/article/1">a</a><a href="https://www.virakesari.lk/article/2#c">b</a><a href="/category/x">c</a>`;
    expect(extractLinks(html, "https://www.virakesari.lk/", "^https://(www\\.)?virakesari\\.lk/article/\\d+")).toEqual([
      "https://www.virakesari.lk/article/1",
      "https://www.virakesari.lk/article/2",
    ]);
  });

  it("extracts article text and metadata", () => {
    const para = "The Central Bank kept policy rates unchanged at its meeting. ".repeat(8);
    const html = `<html><head><meta property="og:image" content="/img/a.jpg"><meta property="article:published_time" content="2026-10-10T08:00:00+05:30">
      <title>Rates</title></head><body><nav>Menu</nav><article><h1>Rates unchanged</h1><p>${para}</p><p>${para}</p></article></body></html>`;
    const a = extractArticle(html, "https://example.lk/news/1");
    expect(a.text).toContain("policy rates unchanged");
    expect(a.imageUrl).toBe("https://example.lk/img/a.jpg");
    expect(a.publishedAt?.toISOString()).toBe("2026-10-10T02:30:00.000Z");
  });
});

describe("analysis helpers", () => {
  it("builds stable entity slugs", () => {
    expect(entitySlug("person", "Anura Kumara  Dissanayake")).toBe("person:anura-kumara-dissanayake");
    expect(entitySlug("organization", "Central Bank of Sri Lanka (CBSL)")).toBe("organization:central-bank-of-sri-lanka-cbsl");
  });

  it("parses JSON replies with fences", () => {
    expect(parseJsonReply('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('result: {"a":[1,2]} done')).toEqual({ a: [1, 2] });
  });

  it("mock embeddings are normalized and similarity-preserving", async () => {
    const [a, b, c] = await mockEmbedder().embed(["floods in ratnapura", "ratnapura floods worsen", "cricket match result"], "document");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(a, a)).toBeCloseTo(1, 5);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });
});

describe("story assignment", () => {
  const article = { title: "x", summary: "y" };
  it("auto-joins very similar stories", async () => {
    expect(await chooseStory(article, [{ id: 7, title: "", summary: "", sim: 0.95, shared: 0 }], null)).toBe(7);
  });
  it("starts a new story when nothing is close", async () => {
    expect(await chooseStory(article, [{ id: 7, title: "", summary: "", sim: 0.5, shared: 0 }], null)).toBeNull();
  });
  it("asks the LLM in the gray zone and validates its answer", async () => {
    const cands = [
      { id: 7, title: "a", summary: "", sim: 0.8, shared: 1 },
      { id: 9, title: "b", summary: "", sim: 0.75, shared: 0 },
    ];
    const llm = (story_id: number | null) => ({ id: "fake", generateJSON: async () => ({ story_id }) as any });
    expect(await chooseStory(article, cands, llm(9))).toBe(9);
    expect(await chooseStory(article, cands, llm(null))).toBeNull();
    expect(await chooseStory(article, cands, llm(1234))).toBeNull(); // hallucinated id
  });
});

describe("story graph", () => {
  it("links stories through shared entities, ignores hubs, finds communities", () => {
    const stories = Array.from({ length: 30 }, (_, i) => i + 1);
    const rows = [
      // "Sri Lanka" appears everywhere: a hub, must not create links
      ...stories.map((s) => ({ story_id: s, entity_id: 1, name: "Sri Lanka" })),
      { story_id: 1, entity_id: 2, name: "IMF" },
      { story_id: 2, entity_id: 2, name: "IMF" },
      { story_id: 1, entity_id: 3, name: "Central Bank" },
      { story_id: 2, entity_id: 3, name: "Central Bank" },
      { story_id: 5, entity_id: 4, name: "Ratnapura" },
      { story_id: 6, entity_id: 4, name: "Ratnapura" },
    ];
    const { links, community } = buildStoryGraph(stories, rows, [{ a: 6, b: 7, sim: 0.9 }]);
    const pairs = links.map((l) => `${l.a}-${l.b}`).sort();
    expect(pairs).toEqual(["1-2", "5-6", "6-7"]);
    expect(links.find((l) => l.a === 1)?.shared.sort()).toEqual(["Central Bank", "IMF"]);
    expect(community.get(1)).toBe(community.get(2));
    expect(community.get(1)).not.toBe(community.get(5));
    expect(community.get(20)).toBeNull();
  });
});

describe("API params", () => {
  it("parses relative and absolute times", () => {
    const d = parseSince("24h")!;
    expect(Math.abs(Date.now() - d.getTime() - 86400e3)).toBeLessThan(1000);
    expect(parseSince("2026-10-01")?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseSince("yesterday")).toThrow();
  });
  it("builds keyword queries", () => {
    expect(textQuery(undefined, ["imf", "fuel price"])).toBe('imf OR "fuel price"');
    expect(textQuery("budget", [])).toBe("budget");
    expect(textQuery("", [])).toBeNull();
  });
  it("compacts objects", () => {
    expect(compact({ a: 1, b: null, c: [], d: "x" })).toEqual({ a: 1, d: "x" });
  });
  it("validates node ids", () => {
    expect(parseNodeId("story:12")).toEqual({ type: "story", key: "12" });
    expect(parseNodeId("source:adaderana-en")).toEqual({ type: "source", key: "adaderana-en" });
    expect(() => parseNodeId("story:abc")).toThrow();
    expect(() => parseNodeId("user:1")).toThrow();
  });
});
