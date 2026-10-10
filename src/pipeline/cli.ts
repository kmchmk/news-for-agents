/**
 * Admin CLI for the news pipeline. Run with:  npm run news -- <command> [options]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { closePool, query, splitSql } from "../lib/db.js";
import { analyzePending } from "./analyze.js";
import { assignStories, summarizeStories } from "./cluster.js";
import { exportWork, importWork } from "./agent-io.js";
import { fetchSources, previewArticle, syncSources } from "./fetch.js";
import { mirrorImages } from "./images.js";
import { rebuildGraph } from "./link.js";
import { createEmbedder, createLLM } from "./llm/index.js";
import { consoleLogger as log } from "./log.js";
import { prune } from "./prune.js";
import { loadSources } from "./sources/config.js";
import { discover } from "./sources/discover.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const HELP = `News for Agents - pipeline CLI

Usage: npm run news -- <command> [options]

Commands:
  migrate                 Create/upgrade the database schema
  sources                 Sync config/sources.yaml to the DB and list sources
  test-source <id>        Dry-run one source: list items and extract the first article
  fetch                   Fetch new articles from enabled sources   [--source id,id] [--max-age-hours 72]
  analyze                 Analyze pending articles with the LLM     [--limit 200] [--concurrency 4]
  cluster                 Attach analyzed articles to stories and refresh story summaries
  link                    Rebuild the story graph (entity links, similarity, communities)
  images                  Mirror lead images to Cloudflare R2 (if configured)
  prune                   Delete news older than RETENTION_DAYS (ongoing stories are kept)
  run                     All of the above in order (fetch → analyze → images → cluster → link → prune)
  export <articles|stories> [--limit 20] [--out file]   Export work for an external agent
  import <file>           Import results produced by an external agent
  stats                   Show counts and data freshness

Providers (env): LLM_PROVIDER=gemini|anthropic|openai|none  EMBEDDING_PROVIDER=gemini|openai|none
Override per run with --llm <provider> and --embedding <provider>.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    "max-age-hours": { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string" },
    out: { type: "string" },
    llm: { type: "string" },
    embedding: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, arg] = positionals;
const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  log(`▶ ${step}`);
  const [run] = await query<{ id: number }>(`insert into pipeline_runs (step) values ($1) returning id::int`, [step]);
  const stats = await fn();
  await query(`update pipeline_runs set finished_at = now(), stats = $2 where id = $1`, [run.id, JSON.stringify(stats)]);
  log(`✔ ${step} ${JSON.stringify(stats)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return stats;
}

async function migrate() {
  const sql = readFileSync(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8");
  for (const statement of splitSql(sql)) await query(statement);
  log("✔ schema up to date");
}

async function main() {
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const llm = () => createLLM(values.llm);
  const embedder = () => createEmbedder(values.embedding);

  switch (command) {
    case "migrate":
      await migrate();
      break;

    case "sources": {
      await syncSources();
      const rows = await query(
        `select s.id, s.language, s.enabled, s.last_fetched_at, s.last_error, count(a.id)::int as articles
           from sources s left join articles a on a.source_id = s.id and a.status = 'analyzed'
          group by s.id order by s.enabled desc, s.language, s.id`,
      );
      console.table(rows);
      break;
    }

    case "test-source": {
      const source = loadSources().find((s) => s.id === arg);
      if (!source) throw new Error(`Unknown source "${arg}"`);
      const items = await discover(source);
      console.log(`${items.length} items`);
      for (const it of items.slice(0, 10)) console.log(`- ${it.publishedAt?.toISOString() ?? "????"} ${it.title ?? ""} ${it.url}`);
      if (items[0] && !items[0].feedOnly) {
        const a = await previewArticle(items[0].url);
        console.log("\nFirst article:", { ...a, text: a.text.slice(0, 600) + (a.text.length > 600 ? "…" : "") });
      }
      return; // no DB used
    }

    case "fetch":
      await timed("fetch", () =>
        fetchSources({ only: values.source?.split(","), maxAgeHours: num(values["max-age-hours"], 72), log }),
      );
      break;

    case "analyze": {
      const model = llm();
      if (!model) throw new Error("analyze needs an LLM (set LLM_PROVIDER or use export/import)");
      await timed("analyze", () =>
        analyzePending({ llm: model, embedder: embedder(), limit: num(values.limit, 200), concurrency: num(values.concurrency, 4), log }),
      );
      break;
    }

    case "cluster": {
      const model = llm();
      await timed("cluster", () => assignStories({ llm: model, log }));
      await timed("summarize", () => summarizeStories({ llm: model, limit: num(values.limit, 100), log }));
      break;
    }

    case "link":
      await timed("link", () => rebuildGraph({ log }));
      break;

    case "images":
      await timed("images", () => mirrorImages({ limit: num(values.limit, 300), log }));
      break;

    case "prune":
      await timed("prune", () => prune({ log }));
      break;

    case "run": {
      const model = llm();
      const emb = embedder();
      await timed("fetch", () => fetchSources({ only: values.source?.split(","), maxAgeHours: num(values["max-age-hours"], 72), log }));
      if (model) {
        await timed("analyze", () =>
          analyzePending({ llm: model, embedder: emb, limit: num(values.limit, 300), concurrency: num(values.concurrency, 4), log }),
        );
      } else {
        log("⚠ no LLM configured: skipping analyze (use `export articles` / `import` with an external agent)");
      }
      await timed("images", () => mirrorImages({ log }));
      await timed("cluster", () => assignStories({ llm: model, log }));
      await timed("summarize", () => summarizeStories({ llm: model, log }));
      await timed("link", () => rebuildGraph({ log }));
      await timed("prune", () => prune({ log }));
      break;
    }

    case "export": {
      if (arg !== "articles" && arg !== "stories") throw new Error("usage: export <articles|stories> [--limit n] [--out file]");
      const work = await exportWork(arg, num(values.limit, 20));
      const json = JSON.stringify(work, null, 2);
      if (values.out) {
        mkdirSync(dirname(values.out), { recursive: true });
        writeFileSync(values.out, json);
        log(`✔ exported ${work.items.length} ${arg} to ${values.out}`);
      } else {
        console.log(json);
      }
      break;
    }

    case "import": {
      if (!arg) throw new Error("usage: import <file>");
      const res = await importWork(arg, embedder());
      log(`✔ imported ${res.imported} ${res.kind}${res.errors.length ? `, ${res.errors.length} errors` : ""}`);
      for (const e of res.errors) log(`  ${e}`);
      if (res.kind === "articles") log("  next: npm run news -- cluster && npm run news -- link");
      break;
    }

    case "stats": {
      const [counts] = await query(
        `select (select count(*) from articles where status='analyzed')::int as analyzed,
                (select count(*) from articles where status='pending')::int as pending,
                (select count(*) from articles where status='failed')::int as failed,
                (select count(*) from stories)::int as stories,
                (select count(*) from entities)::int as entities,
                (select count(*) from story_links)::int as links,
                (select max(published_at) from articles where status='analyzed') as newest_article,
                (select max(finished_at) from pipeline_runs) as last_run`,
      );
      console.table([counts]);
      break;
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`✖ ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
