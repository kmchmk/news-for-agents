/**
 * "Bring your own agent" mode: export pending work as a self-describing JSON file that any
 * LLM/agent can complete, then import the results. No API keys needed in this repo.
 *
 *   npm run news -- export articles --limit 20 --out work/articles.json
 *   (agent fills in "results" following the instructions inside the file)
 *   npm run news -- import work/articles.json
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadPending, saveAnalysis } from "./analyze.js";
import { loadStaleStories, saveStorySummary } from "./cluster.js";
import type { Embedder } from "./llm/index.js";
import { ARTICLE_SYSTEM, ArticleAnalysisSchema, STORY_SYSTEM, StorySummarySchema, articlePrompt, storyPrompt } from "./prompts.js";

function schemaOf(schema: z.ZodType) {
  const s = z.toJSONSchema(schema) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export async function exportWork(kind: "articles" | "stories", limit: number) {
  if (kind === "articles") {
    const items = await loadPending(limit);
    return {
      kind,
      instructions:
        `${ARTICLE_SYSTEM}\n\nFor EACH item in "items", read its "prompt" and produce an analysis object matching "result_schema". ` +
        `Write them into "results" as [{"id": <item id>, "analysis": {...}}], keep everything else, and save the file. ` +
        `Then run: npm run news -- import <this file>`,
      result_schema: schemaOf(ArticleAnalysisSchema),
      items: items.map((a) => ({ id: a.id, prompt: articlePrompt(a) })),
      results: [] as unknown[],
    };
  }
  const stories = await loadStaleStories(limit);
  return {
    kind,
    instructions:
      `${STORY_SYSTEM}\n\nFor EACH item in "items", read its "prompt" (the story's reports, oldest first) and produce a summary ` +
      `object matching "result_schema". Write them into "results" as [{"id": <item id>, "summary": {...}}] and save the file. ` +
      `Then run: npm run news -- import <this file>`,
    result_schema: schemaOf(StorySummarySchema),
    items: stories.map((s) => ({ id: s.id, prompt: storyPrompt(s.articles) })),
    results: [] as unknown[],
  };
}

const ImportFile = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("articles"),
    model: z.string().optional(),
    results: z.array(z.object({ id: z.number().int(), analysis: ArticleAnalysisSchema })),
  }),
  z.object({
    kind: z.literal("stories"),
    model: z.string().optional(),
    results: z.array(z.object({ id: z.number().int(), summary: StorySummarySchema })),
  }),
]);

export async function importWork(path: string, embedder: Embedder | null): Promise<{ kind: string; imported: number; errors: string[] }> {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const file = ImportFile.parse({ ...raw, results: raw.results ?? [] });
  const errors: string[] = [];
  let imported = 0;
  for (const r of file.results) {
    try {
      if (file.kind === "articles") {
        await saveAnalysis(r.id, (r as any).analysis, `agent/${file.model ?? "external"}`, embedder);
      } else {
        await saveStorySummary(r.id, (r as any).summary);
      }
      imported++;
    } catch (e) {
      errors.push(`${r.id}: ${(e as Error).message}`);
    }
  }
  return { kind: file.kind, imported, errors };
}
