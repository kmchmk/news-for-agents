/**
 * Compare LLMs on the real article-analysis task. Fetches fresh articles (Sinhala, Tamil,
 * English), runs every model on the same prompts, and writes a side-by-side report.
 *
 *   npm run compare -- --models gemini:gemini-3.8-flash,openrouter:google/gemma-4-31b-it:free
 *   npm run compare -- --models ... --per-source 2 --sources adaderana-si,tamilmirror,dailymirror-breaking
 *
 * Model specs: gemini:<model> (Vertex/Gemini env), openrouter:<model> (OPENROUTER_API_KEY),
 * anthropic:<model>, openai:<model> (OPENAI_* env).
 * Output: work/compare-<timestamp>.md and .json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createLLM, type LLM } from "./llm/index.js";
import { ARTICLE_SYSTEM, ArticleAnalysisSchema, articlePrompt, type ArticleAnalysis } from "./prompts.js";
import { loadSources } from "./sources/config.js";
import { discover } from "./sources/discover.js";
import { extractArticle } from "./sources/extract.js";
import { fetchText } from "./sources/http.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const { values } = parseArgs({
  options: {
    models: { type: "string" },
    sources: { type: "string", default: "lankadeepa,newsfirst-si,tamilmirror,newsfirst-ta,dailymirror-breaking" },
    "per-source": { type: "string", default: "2" },
  },
});
if (!values.models) {
  console.error("usage: npm run compare -- --models gemini:gemini-3.8-flash,openrouter:<model>[,...]");
  process.exit(1);
}

function makeLLM(spec: string): LLM {
  const i = spec.indexOf(":");
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  if (provider === "gemini") process.env.GEMINI_MODEL = model;
  if (provider === "anthropic") process.env.ANTHROPIC_MODEL = model;
  if (provider === "openai") process.env.OPENAI_MODEL = model;
  if (provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_API_KEY = process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_MODEL = model;
    return { ...createLLM("openai")!, id: `openrouter/${model}` };
  }
  return createLLM(provider)!;
}

async function sample() {
  const wanted = values.sources!.split(",");
  const per = Number(values["per-source"]);
  const items: { id: string; source: string; language: string; url: string; prompt: string }[] = [];
  for (const source of loadSources().filter((s) => wanted.includes(s.id))) {
    try {
      for (const it of (await discover(source)).slice(0, per)) {
        const page = await fetchText(it.url);
        const a = extractArticle(page.text, page.url);
        const text = (a.text.length > (it.feedText ?? "").length ? a.text : it.feedText ?? "").slice(0, 6000);
        items.push({
          id: `${source.id}-${items.length + 1}`,
          source: source.name,
          language: source.language,
          url: it.url,
          prompt: articlePrompt({ source: source.name, url: it.url, original_title: it.title ?? a.title, text }),
        });
      }
    } catch (e) {
      console.error(`  ${source.id}: ${(e as Error).message}`);
    }
  }
  return items;
}

async function main() {
  const specs = values.models!.split(",").map((s) => s.trim());
  const items = await sample();
  console.error(`${items.length} articles, ${specs.length} models`);
  const results: Record<string, Record<string, ArticleAnalysis | { error: string }>> = {};
  const stats: Record<string, { ms: number; ok: number }> = {};

  for (const spec of specs) {
    results[spec] = {};
    stats[spec] = { ms: 0, ok: 0 };
    let llm: LLM;
    try {
      llm = makeLLM(spec);
    } catch (e) {
      for (const it of items) results[spec][it.id] = { error: (e as Error).message };
      continue;
    }
    for (const it of items) {
      const t0 = Date.now();
      try {
        results[spec][it.id] = await llm.generateJSON({ system: ARTICLE_SYSTEM, prompt: it.prompt, schema: ArticleAnalysisSchema });
        stats[spec].ms += Date.now() - t0;
        stats[spec].ok++;
      } catch (e) {
        results[spec][it.id] = { error: (e as Error).message.slice(0, 300) };
      }
    }
    console.error(`  ${spec}: ${stats[spec].ok}/${items.length} ok`);
  }

  const lines = [`# Model comparison (${new Date().toISOString()})`, "", "| Model | OK | Avg time |", "|---|---|---|"];
  for (const s of specs) lines.push(`| ${s} | ${stats[s].ok}/${items.length} | ${stats[s].ok ? Math.round(stats[s].ms / stats[s].ok) : "-"} ms |`);
  for (const it of items) {
    lines.push("", `## ${it.id} (${it.language}) ${it.url}`, "", "```", it.prompt.split("<<<ARTICLE")[1]?.slice(0, 500) ?? "", "```");
    for (const s of specs) {
      const r = results[s][it.id];
      if ("error" in r) {
        lines.push(`- **${s}**: ERROR ${r.error}`);
        continue;
      }
      lines.push(
        `- **${s}** — relevant=${r.relevant} lang=${r.language} cat=${r.category} imp=${r.importance}`,
        `  - ${r.title}`,
        `  - ${r.summary}`,
        `  - entities: ${r.entities.map((e) => `${e.name} (${e.type})`).join("; ")}`,
      );
    }
  }
  mkdirSync("work", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`work/compare-${stamp}.md`, lines.join("\n"));
  writeFileSync(`work/compare-${stamp}.json`, JSON.stringify({ items, results, stats }, null, 1));
  console.log(`work/compare-${stamp}.md`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
