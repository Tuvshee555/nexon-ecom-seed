import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getEnv } from "./env";
import { logError, logInfo, recordCounter } from "./observability";

const env = getEnv();
let pool: Pool | null = null;

function normalizeConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const sslmode = url.searchParams.get("sslmode");
    const useLibpqCompat = url.searchParams.get("uselibpqcompat");
    if (
      sslmode &&
      ["prefer", "require", "verify-ca"].includes(sslmode) &&
      useLibpqCompat !== "true"
    ) {
      url.searchParams.set("sslmode", "verify-full");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

function createPool(connectionString: string): Pool {
  const p = new Pool({
    connectionString: normalizeConnectionString(connectionString),
    max: 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: "-c client_encoding=UTF8",
  });
  return p;
}

function getPool() {
  if (!env.neonDatabaseUrl) return null;
  if (!pool) {
    pool = createPool(env.neonDatabaseUrl);
    pool.on("error", (error) => {
      logError("neon.pool.error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    logInfo("neon.pool.initialized", { configured: true });
  }
  return pool;
}

export function isNeonConfigured() {
  return Boolean(env.neonDatabaseUrl);
}

export async function queryNeon<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T> | null> {
  const db = getPool();
  if (!db) return null;
  recordCounter("neon.query_total", 1);
  return db.query<T>(text, params);
}

export async function withNeonClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | null> {
  const db = getPool();
  if (!db) return null;
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
