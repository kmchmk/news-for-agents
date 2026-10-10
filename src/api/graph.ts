/**
 * Graph traversal for agents. Node ids: "story:<id>", "article:<id>", "entity:<id>", "source:<id>".
 *
 * Edges:
 *   article --part_of--> story          article --mentions--> entity
 *   article --published_by--> source    story --involves--> entity (weight = mentions)
 *   story --related--> story (weight; relation = shared_entities | similar; shared = entity names)
 */
import { DirectedGraph, UndirectedGraph } from "graphology";
import { bfsFromNode } from "graphology-traversal";
import { query } from "../lib/db.js";
import { BadRequest, compact } from "./params.js";

export const NODE_TYPES = ["story", "article", "entity", "source"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface GNode {
  id: string;
  type: NodeType;
  label: string;
  [k: string]: unknown;
}
export interface GEdge {
  source: string;
  target: string;
  type: string;
  weight?: number;
  shared?: string[];
}

export function parseNodeId(id: string): { type: NodeType; key: string } {
  const m = /^(story|article|entity|source):([A-Za-z0-9-]+)$/.exec(id);
  if (!m) throw new BadRequest(`Invalid node id "${id}". Use story:<id>, article:<id>, entity:<id> or source:<id>.`);
  if (m[1] !== "source" && !/^\d+$/.test(m[2])) throw new BadRequest(`Invalid node id "${id}"`);
  return { type: m[1] as NodeType, key: m[2] };
}

const PER_RELATION = 15;

/** Load one node and its direct neighborhood. */
export async function expand(id: string): Promise<{ node: GNode | null; neighbors: GNode[]; edges: GEdge[] }> {
  const { type, key } = parseNodeId(id);
  const neighbors: GNode[] = [];
  const edges: GEdge[] = [];

  if (type === "story") {
    const [s] = await query(
      `select id::int, title, summary, category, status, importance, article_count, last_updated_at from stories where id = $1`,
      [key],
    );
    if (!s) return { node: null, neighbors, edges };
    const articles = await query(
      `select id::int, title, source_id, published_at, url from articles where story_id = $1 order by published_at desc limit $2`,
      [key, PER_RELATION],
    );
    for (const a of articles) {
      neighbors.push(compact({ id: `article:${a.id}`, type: "article", label: a.title, source: a.source_id, published_at: a.published_at, url: a.url }) as GNode);
      edges.push({ source: `article:${a.id}`, target: id, type: "part_of" });
    }
    const entities = await query(
      `select e.id::int, e.name, e.type, se.mentions from story_entities se join entities e on e.id = se.entity_id
        where se.story_id = $1 order by se.mentions desc limit $2`,
      [key, PER_RELATION],
    );
    for (const e of entities) {
      neighbors.push({ id: `entity:${e.id}`, type: "entity", label: e.name, entity_type: e.type });
      edges.push({ source: id, target: `entity:${e.id}`, type: "involves", weight: e.mentions });
    }
    const related = await query(
      `select o.id::int, o.title, o.last_updated_at, l.relation, l.weight, l.shared
         from story_links l join stories o on o.id = case when l.story_a = $1 then l.story_b else l.story_a end
        where l.story_a = $1 or l.story_b = $1 order by l.weight desc limit $2`,
      [key, PER_RELATION],
    );
    for (const r of related) {
      neighbors.push({ id: `story:${r.id}`, type: "story", label: r.title, last_updated_at: r.last_updated_at });
      edges.push(compact({ source: id, target: `story:${r.id}`, type: "related", relation: r.relation, weight: r.weight, shared: r.shared }) as GEdge);
    }
    const { id: _sid, title, ...story } = s;
    return { node: compact({ ...story, id, type, label: title }) as GNode, neighbors, edges };
  }

  if (type === "article") {
    const [a] = await query(
      `select id::int, title, summary, url, source_id, story_id::int, published_at, language, category
         from articles where id = $1 and status = 'analyzed'`,
      [key],
    );
    if (!a) return { node: null, neighbors, edges };
    if (a.story_id) {
      const [s] = await query(`select id::int, title from stories where id = $1`, [a.story_id]);
      if (s) {
        neighbors.push({ id: `story:${s.id}`, type: "story", label: s.title });
        edges.push({ source: id, target: `story:${s.id}`, type: "part_of" });
      }
    }
    neighbors.push({ id: `source:${a.source_id}`, type: "source", label: a.source_id });
    edges.push({ source: id, target: `source:${a.source_id}`, type: "published_by" });
    const entities = await query(
      `select e.id::int, e.name, e.type from article_entities ae join entities e on e.id = ae.entity_id where ae.article_id = $1`,
      [key],
    );
    for (const e of entities) {
      neighbors.push({ id: `entity:${e.id}`, type: "entity", label: e.name, entity_type: e.type });
      edges.push({ source: id, target: `entity:${e.id}`, type: "mentions" });
    }
    const { id: _aid, title, ...article } = a;
    return { node: compact({ ...article, id, type, label: title }) as GNode, neighbors, edges };
  }

  if (type === "entity") {
    const [e] = await query(`select id::int, name, type from entities where id = $1`, [key]);
    if (!e) return { node: null, neighbors, edges };
    const stories = await query(
      `select s.id::int, s.title, s.last_updated_at, se.mentions from story_entities se join stories s on s.id = se.story_id
        where se.entity_id = $1 order by s.last_updated_at desc limit $2`,
      [key, PER_RELATION],
    );
    for (const s of stories) {
      neighbors.push({ id: `story:${s.id}`, type: "story", label: s.title, last_updated_at: s.last_updated_at });
      edges.push({ source: `story:${s.id}`, target: id, type: "involves", weight: s.mentions });
    }
    return { node: { id, type, label: e.name, entity_type: e.type }, neighbors, edges };
  }

  // source
  const [src] = await query(`select id, name, language from sources where id = $1`, [key]);
  if (!src) return { node: null, neighbors, edges };
  const articles = await query(
    `select id::int, title, published_at from articles where source_id = $1 and status = 'analyzed'
      order by published_at desc limit $2`,
    [key, PER_RELATION],
  );
  for (const a of articles) {
    neighbors.push({ id: `article:${a.id}`, type: "article", label: a.title, published_at: a.published_at });
    edges.push({ source: `article:${a.id}`, target: id, type: "published_by" });
  }
  return { node: { id, type, label: src.name, language: src.language }, neighbors, edges };
}

/**
 * Breadth-first expansion from a start node up to `depth` hops, restricted to `types`,
 * capped at `maxNodes`. Returns a subgraph (nodes + edges) with each node's hop distance.
 */
export async function neighborhood(start: string, opts: { depth: number; types: NodeType[]; maxNodes: number }) {
  const graph = new DirectedGraph({ allowSelfLoops: false });
  const first = await expand(start);
  if (!first.node) return null;
  graph.addNode(start, { ...first.node, hop: 0 });

  let frontier: { id: string; data: Awaited<ReturnType<typeof expand>> }[] = [{ id: start, data: first }];
  for (let hop = 1; hop <= opts.depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const { data } of frontier) {
      for (const n of data.neighbors) {
        if (!opts.types.includes(n.type)) continue;
        if (!graph.hasNode(n.id)) {
          if (graph.order >= opts.maxNodes) continue;
          graph.addNode(n.id, { ...n, hop });
          next.push(n.id);
        }
      }
      for (const e of data.edges) {
        if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
          graph.addEdge(e.source, e.target, e);
        }
      }
    }
    if (hop === opts.depth) break;
    frontier = [];
    for (const id of next) frontier.push({ id, data: await expand(id) });
  }

  // Order nodes by BFS distance from the start (treating edges as undirected for reachability).
  const order: string[] = [];
  const undirected = new UndirectedGraph();
  graph.forEachNode((n) => undirected.addNode(n));
  graph.forEachEdge((_e, _a, s, t) => undirected.mergeEdge(s, t));
  bfsFromNode(undirected, start, (n) => {
    order.push(n);
  });
  graph.forEachNode((n) => {
    if (!order.includes(n)) order.push(n);
  });

  return {
    start,
    depth: opts.depth,
    nodes: order.map((n) => graph.getNodeAttributes(n)),
    edges: graph.mapEdges((_e, attrs) => attrs as GEdge),
    truncated: graph.order >= opts.maxNodes,
  };
}
