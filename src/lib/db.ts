/**
 * Database access. Two drivers behind one tiny interface:
 *  - "neon-http": Neon's serverless driver over HTTPS (default for *.neon.tech URLs). Works from
 *    serverless functions and from networks that block the Postgres port.
 *  - "pg": node-postgres over TCP (default otherwise, e.g. local Postgres).
 * Override with DB_DRIVER=pg|neon-http.
 */
import pg from "pg";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export interface Statement {
  text: string;
  params?: unknown[];
}

let pool: pg.Pool | undefined;
let http: NeonQueryFunction<false, false> | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function driver(): "pg" | "neon-http" {
  const d = process.env.DB_DRIVER;
  if (d === "pg" || d === "neon-http") return d;
  return /\.neon\.tech\b/.test(connectionString()) ? "neon-http" : "pg";
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString(),
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

function getHttp(): NeonQueryFunction<false, false> {
  http ??= neon(connectionString());
  return http;
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  if (driver() === "neon-http") return (await getHttp().query(text, params)) as T[];
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

/** Run statements atomically. */
export async function transaction(statements: Statement[]): Promise<void> {
  if (!statements.length) return;
  if (driver() === "neon-http") {
    const sql = getHttp();
    await sql.transaction(statements.map((s) => sql.query(s.text, s.params ?? [])));
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    for (const s of statements) await client.query(s.text, s.params ?? []);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Split a SQL script into statements (strips `--` comments; no semicolons inside literals). */
export function splitSql(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** pgvector literal for a number array. */
export function toVector(v: number[] | null | undefined): string | null {
  return v && v.length ? `[${v.join(",")}]` : null;
}
