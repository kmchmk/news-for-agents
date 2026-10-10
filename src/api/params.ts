import { CATEGORIES } from "../lib/config.js";

export class BadRequest extends Error {}

/** Parse "24h", "7d", "90m" or an ISO date into a Date. */
export function parseSince(v: string | undefined): Date | null {
  if (!v) return null;
  const rel = /^(\d+)\s*([mhdw])$/i.exec(v.trim());
  if (rel) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[rel[2].toLowerCase() as "m" | "h" | "d" | "w"];
    return new Date(Date.now() - Number(rel[1]) * unit);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequest(`Invalid time "${v}". Use e.g. 24h, 7d or an ISO date.`);
  return d;
}

export function parseIntParam(v: string | undefined, def: number, min: number, max: number, name: string): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function parseCategory(v: string | undefined): string[] {
  const list = parseList(v);
  for (const c of list) {
    if (!(CATEGORIES as readonly string[]).includes(c)) throw new BadRequest(`Unknown category "${c}". Valid: ${CATEGORIES.join(", ")}`);
  }
  return list;
}

/** Combine free text and keyword list into a single websearch-style query ("a OR b"). */
export function textQuery(q: string | undefined, keywords: string[]): string | null {
  const parts: string[] = [];
  if (q?.trim()) parts.push(q.trim().slice(0, 300));
  if (keywords.length) parts.push(keywords.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(" OR "));
  return parts.length ? parts.join(" ") : null;
}

/** Drop null/undefined/empty-array fields to keep responses token-efficient. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
