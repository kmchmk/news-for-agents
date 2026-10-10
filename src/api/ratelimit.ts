import type { MiddlewareHandler } from "hono";

/**
 * Per-IP fixed-window rate limiter, kept in function-instance memory.
 *
 * This is one layer of DDoS protection; the others are:
 *  - CDN caching (Cache-Control s-maxage on every GET) so repeated requests never reach the function or DB
 *  - Vercel's platform DDoS mitigation (always on) and optional Vercel Firewall rate-limit rules
 *  - hard caps on every query parameter (limit, depth, offset)
 * Memory limits are per instance, which is good enough to stop a single noisy client
 * without paying for an external store.
 */
export function rateLimit(opts: { perMinute: number; maxKeys?: number }): MiddlewareHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  const maxKeys = opts.maxKeys ?? 10_000;

  return async (c, next) => {
    const ip =
      c.req.header("x-vercel-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.reset <= now) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear();
      }
      entry = { count: 0, reset: now + 60_000 };
      hits.set(ip, entry);
    }
    entry.count++;
    const remaining = Math.max(0, opts.perMinute - entry.count);
    c.header("X-RateLimit-Limit", String(opts.perMinute));
    c.header("X-RateLimit-Remaining", String(remaining));
    if (entry.count > opts.perMinute) {
      const retry = Math.ceil((entry.reset - now) / 1000);
      c.header("Retry-After", String(retry));
      c.header("Cache-Control", "no-store");
      return c.json({ error: "rate_limited", message: `Too many requests. Retry after ${retry}s.` }, 429);
    }
    await next();
  };
}
