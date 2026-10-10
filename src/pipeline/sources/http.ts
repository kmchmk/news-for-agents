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

export async function fetchText(url: string, timeoutMs = 20_000): Promise<FetchedText> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
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
