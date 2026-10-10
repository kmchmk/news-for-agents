/**
 * Rebuilds the derived story graph:
 *  - story_entities: which entities each story involves
 *  - story_links:    story<->story edges, from shared entities (IDF-weighted) and embedding similarity
 *  - stories.community: Louvain communities over the story graph (groups of related stories)
 */
import { UndirectedGraph } from "graphology";
import louvainImport from "graphology-communities-louvain";
import { query, transaction, type Statement } from "../lib/db.js";
import { RETENTION_DAYS } from "../lib/config.js";
import type { Logger } from "./log.js";

const MAX_LINKS_PER_STORY = 8;
const MIN_LINK_WEIGHT = Number(process.env.LINK_MIN_WEIGHT ?? 1.5);
const SIMILAR_MIN = Number(process.env.LINK_SIMILAR_MIN ?? 0.8);
/** Entities appearing in more than this share of stories (e.g. "Sri Lanka") don't create links. */
const HUB_SHARE = 0.08;

// CommonJS interop: the module's default export is the function itself at runtime.
const louvain = ((louvainImport as any).default ?? louvainImport) as (
  g: UndirectedGraph,
  o?: { getEdgeWeight?: string },
) => Record<string, number>;

export interface StoryEntityRow {
  story_id: number;
  entity_id: number;
  name: string;
}
export interface SimilarRow {
  a: number;
  b: number;
  sim: number;
}
export interface LinkEdge {
  a: number;
  b: number;
  relation: "shared_entities" | "similar";
  weight: number;
  shared: string[];
}

/**
 * Pure graph construction (unit-tested): builds a story–entity bipartite graph, projects it
 * onto stories with IDF weights, merges similarity edges, prunes to top-K per story, and
 * detects communities with Louvain.
 */
export function buildStoryGraph(storyIds: number[], rows: StoryEntityRow[], similar: SimilarRow[]) {
  const bipartite = new UndirectedGraph();
  for (const id of storyIds) bipartite.mergeNode(`s${id}`, { kind: "story" });
  for (const r of rows) {
    if (!bipartite.hasNode(`s${r.story_id}`)) continue;
    bipartite.mergeNode(`e${r.entity_id}`, { kind: "entity", name: r.name });
    bipartite.mergeEdge(`s${r.story_id}`, `e${r.entity_id}`);
  }

  const n = Math.max(storyIds.length, 1);
  const maxDf = Math.max(3, Math.floor(n * HUB_SHARE));
  const pair = new Map<string, LinkEdge>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  bipartite.forEachNode((node, attrs) => {
    if (attrs.kind !== "entity") return;
    const stories = bipartite.neighbors(node).map((s) => Number(s.slice(1)));
    const df = stories.length;
    if (df < 2 || df > maxDf) return;
    const idf = Math.log(n / df) + 1;
    for (let i = 0; i < stories.length; i++) {
      for (let j = i + 1; j < stories.length; j++) {
        const [a, b] = stories[i] < stories[j] ? [stories[i], stories[j]] : [stories[j], stories[i]];
        const k = key(a, b);
        const e = pair.get(k) ?? { a, b, relation: "shared_entities" as const, weight: 0, shared: [] };
        e.weight += idf;
        e.shared.push(attrs.name);
        pair.set(k, e);
      }
    }
  });

  for (const s of similar) {
    if (s.sim < SIMILAR_MIN) continue;
    const [a, b] = s.a < s.b ? [s.a, s.b] : [s.b, s.a];
    const k = key(a, b);
    const boost = (s.sim - SIMILAR_MIN) * 10 + MIN_LINK_WEIGHT; // similarity alone is enough to link
    const e = pair.get(k);
    if (e) e.weight += boost;
    else pair.set(k, { a, b, relation: "similar", weight: boost, shared: [] });
  }

  // Keep each story's strongest links.
  const candidates = [...pair.values()].filter((e) => e.weight >= MIN_LINK_WEIGHT).sort((x, y) => y.weight - x.weight);
  const degree = new Map<number, number>();
  const kept: LinkEdge[] = [];
  for (const e of candidates) {
    const da = degree.get(e.a) ?? 0;
    const db = degree.get(e.b) ?? 0;
    if (da >= MAX_LINKS_PER_STORY && db >= MAX_LINKS_PER_STORY) continue;
    degree.set(e.a, da + 1);
    degree.set(e.b, db + 1);
    kept.push({ ...e, weight: Math.round(e.weight * 100) / 100, shared: e.shared.slice(0, 10) });
  }

  const storyGraph = new UndirectedGraph();
  for (const id of storyIds) storyGraph.addNode(String(id));
  for (const e of kept) storyGraph.mergeEdge(String(e.a), String(e.b), { weight: e.weight });
  const communities: Record<string, number> = storyGraph.size > 0 ? louvain(storyGraph, { getEdgeWeight: "weight" }) : {};
  // Isolated stories get no community.
  const community = new Map<number, number | null>();
  for (const id of storyIds) community.set(id, storyGraph.degree(String(id)) > 0 ? communities[String(id)] : null);
  return { links: kept, community };
}

export async function rebuildGraph(opts: { log: Logger }): Promise<{ stories: number; links: number; communities: number }> {

  const stories = (
    await query<{ id: number }>(`select id::int from stories where last_updated_at > now() - make_interval(days => $1)`, [RETENTION_DAYS])
  ).map((r) => r.id);
  // Computed from articles directly; story_entities itself is rewritten in the transaction below.
  const rows = await query<StoryEntityRow>(
    `select distinct a.story_id::int, ae.entity_id::int, e.name
       from article_entities ae
       join articles a on a.id = ae.article_id
       join entities e on e.id = ae.entity_id
      where a.story_id = any($1)`,
    [stories],
  );
  const similar = await query<SimilarRow>(
    `select s.id::int as a, n.id::int as b, n.sim
       from stories s
       cross join lateral (
         select s2.id, 1 - (s2.embedding <=> s.embedding) as sim
           from stories s2
          where s2.id <> s.id and s2.embedding is not null and s2.id = any($1)
          order by s2.embedding <=> s.embedding limit 5) n
      where s.id = any($1) and s.embedding is not null`,
    [stories],
  );

  const { links, community } = buildStoryGraph(stories, rows, similar.map((r) => ({ ...r, sim: Number(r.sim) })));

  const statements: Statement[] = [
    { text: `delete from story_entities` },
    {
      text: `insert into story_entities (story_id, entity_id, mentions)
             select a.story_id, ae.entity_id, count(*)
               from article_entities ae join articles a on a.id = ae.article_id
              where a.story_id is not null
              group by a.story_id, ae.entity_id`,
    },
    { text: `delete from story_links` },
  ];
  for (let i = 0; i < links.length; i += 200) {
    const chunk = links.slice(i, i + 200);
    const params: unknown[] = [];
    const values = chunk.map((l) => {
      params.push(l.a, l.b, l.relation, l.weight, l.shared);
      const o = params.length - 5;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5})`;
    });
    statements.push({ text: `insert into story_links (story_a, story_b, relation, weight, shared) values ${values.join(",")}`, params });
  }
  statements.push({
    text: `update stories s set community = c.community
             from unnest($1::bigint[], $2::int[]) as c(id, community) where s.id = c.id`,
    params: [[...community.keys()], [...community.values()]],
  });
  await transaction(statements);

  const communities = new Set([...community.values()].filter((c) => c !== null)).size;
  opts.log(`  graph: ${stories.length} stories, ${links.length} links, ${communities} communities`);
  return { stories: stories.length, links: links.length, communities };
}
