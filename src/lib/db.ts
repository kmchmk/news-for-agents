import pg from "pg";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** pgvector literal for a number array. */
export function toVector(v: number[] | null | undefined): string | null {
  return v && v.length ? `[${v.join(",")}]` : null;
}
