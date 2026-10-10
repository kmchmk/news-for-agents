/**
 * Optional: mirror article lead images to Cloudflare R2 (S3-compatible, free egress) so image
 * URLs keep working even if the publisher hotlink-protects or deletes them.
 * Enabled only when all R2_* env vars are set; otherwise original image URLs are served.
 */
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { query } from "../lib/db.js";
import { mapLimit } from "./sources/http.js";
import type { Logger } from "./log.js";

const MAX_BYTES = 3 * 1024 * 1024;

interface R2Config {
  client: S3Client;
  bucket: string;
  publicBase: string;
}

export function r2Config(): R2Config | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE_URL) return null;
  return {
    client: new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
    bucket: R2_BUCKET,
    publicBase: R2_PUBLIC_BASE_URL.replace(/\/$/, ""),
  };
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

export async function mirrorImages(opts: { limit?: number; log: Logger }): Promise<{ mirrored: number; failed: number }> {
  const r2 = r2Config();
  if (!r2) {
    opts.log("  images: R2 not configured, serving original image URLs");
    return { mirrored: 0, failed: 0 };
  }
  const rows = await query<{ id: number; image_url: string }>(
    `select id::int, image_url from articles
      where status = 'analyzed' and image_url is not null and image_cdn_url is null
      order by published_at desc limit $1`,
    [opts.limit ?? 300],
  );
  const stats = { mirrored: 0, failed: 0 };
  await mapLimit(rows, 4, async (row) => {
    try {
      const res = await fetch(row.image_url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Mozilla/5.0" } });
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!res.ok || !EXT[type]) throw new Error(`bad image response ${res.status} ${type}`);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > MAX_BYTES) throw new Error("image too large");
      const key = `img/${createHash("sha256").update(row.image_url).digest("hex").slice(0, 32)}.${EXT[type]}`;
      await r2.client.send(
        new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: body, ContentType: type, CacheControl: "public, max-age=31536000, immutable" }),
      );
      await query(`update articles set image_cdn_url = $2 where id = $1`, [row.id, `${r2.publicBase}/${key}`]);
      stats.mirrored++;
    } catch {
      // Fall back to the original URL and don't retry.
      await query(`update articles set image_cdn_url = image_url where id = $1`, [row.id]);
      stats.failed++;
    }
  });
  return stats;
}

/** Delete mirrored images (called by prune for removed articles). */
export async function deleteImages(urls: string[]): Promise<void> {
  const r2 = r2Config();
  if (!r2) return;
  const keys = urls.filter((u) => u.startsWith(r2.publicBase + "/")).map((u) => u.slice(r2.publicBase.length + 1));
  for (let i = 0; i < keys.length; i += 1000) {
    await r2.client.send(
      new DeleteObjectsCommand({ Bucket: r2.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }),
    );
  }
}
