import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

const SourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  kind: z.enum(["rss", "html", "youtube", "reddit"]),
  url: z.string().url(),
  home_url: z.string().url().optional(),
  link_pattern: z.string().optional(),
  language: z.enum(["si", "ta", "en"]),
  enabled: z.boolean().default(true),
  max_items: z.number().int().positive().default(25),
});
export type SourceConfig = z.infer<typeof SourceSchema>;

const FileSchema = z.object({ sources: z.array(SourceSchema) });

export const DEFAULT_SOURCES_PATH = fileURLToPath(new URL("../../../config/sources.yaml", import.meta.url));

export function loadSources(path = DEFAULT_SOURCES_PATH): SourceConfig[] {
  const parsed = FileSchema.parse(parse(readFileSync(path, "utf8")));
  const ids = new Set<string>();
  for (const s of parsed.sources) {
    if (ids.has(s.id)) throw new Error(`Duplicate source id: ${s.id}`);
    ids.add(s.id);
    if (s.kind === "html" && !s.link_pattern) throw new Error(`html source ${s.id} needs link_pattern`);
  }
  return parsed.sources;
}
