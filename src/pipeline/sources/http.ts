import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const UA =
  process.env.FETCH_USER_AGENT ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 NewsForAgents/0.1";

export interface FetchedText {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  text: string;
}

/** Pick a charset from the Content-Type header, then from an XML/HTML declaration. */
export function detectCharset(contentType: string, head: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const fromXml = /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (fromHeader ?? fromXml ?? fromMeta ?? "utf-8").toLowerCase();
}

/**
 * Decode bytes. Several Sri Lankan sites declare iso-8859-1 while actually
 * sending UTF-8 Sinhala/Tamil, so prefer UTF-8 whenever the bytes are valid UTF-8.
 */
export function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

// ---------------------------------------------------------------- SSRF guard
// Feeds decide which URLs we fetch, so a compromised source could point us at internal
// services (router admin pages, cloud metadata endpoints...). Only public addresses are allowed.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 127], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
  blocked.addSubnet(net, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is judged by its IPv4 part.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) address = mapped[1];
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Throw unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Blocked URL scheme: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error(`Blocked non-public address for ${url.hostname}`);
  return url;
}

/** fetch() that re-checks every redirect hop against the SSRF guard. */
export async function safeFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const signal = AbortSignal.timeout(init.timeoutMs ?? 20_000);
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    Object.defineProperty(res, "url", { value: current });
    return res;
  }
  throw new Error(`Too many redirects for ${url}`);
}

export async function fetchText(url: string, timeoutMs = 20_000): Promise<FetchedText> {
  const res = await safeFetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8" },
    timeoutMs,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const text = decodeBody(bytes, detectCharset(contentType, head));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { url: res.url || url, status: res.status, contentType, text };
}

/** Run async tasks with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
