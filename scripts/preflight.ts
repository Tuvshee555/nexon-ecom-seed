import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function stripEnvQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] != null) continue;
    process.env[key] = stripEnvQuotes(trimmed.slice(eqIndex + 1));
  }
}

function loadLocalEnvFiles() {
  loadEnvFile(resolve(process.cwd(), ".env.local"));
  loadEnvFile(resolve(process.cwd(), ".env"));
}

function isStrictPreflightEnabled() {
  const value = String(process.env.STRICT_PREFLIGHT || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

async function run() {
  loadLocalEnvFiles();

  // Validate env FIRST, before importing modules that call getEnv() at load time
  // (e.g. redisState.ts). Otherwise a missing-secret throw during those imports
  // bypasses the try/catch below and hard-fails the build. The template must build
  // with no .env; runtime still validates strictly via getEnv() per request.
  const envModule = await import("../src/lib/env");
  let env: ReturnType<typeof envModule.getEnv>;
  try {
    env = envModule.getEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "preflight.env_incomplete",
        message:
          "Env validation failed at build time (continuing — runtime validates per-request). " +
          message,
      }),
    );
    return;
  }

  const observabilityModule = await import("../src/lib/observability");
  const readinessModule = await import("../src/lib/readiness");
  const redisModule = await import("../src/lib/redisState");

  const readiness = readinessModule.getReadinessReport(env);
  const redisHealthBefore = redisModule.getRedisHealth();
  const getObservabilityDiagnostics = observabilityModule.getObservabilityDiagnostics;

  const redisProbe: { attempted: boolean; ok: boolean; detail: string } = {
    attempted: false,
    ok: true,
    detail: "not_enabled",
  };

  if (env.redisStateEnabled) {
    redisProbe.attempted = true;
    const result = await redisModule.withRedis("preflight.redis_ping", async (redis) => {
      const pong = await redis.ping();
      return pong;
    });

    if (result === null) {
      redisProbe.ok = false;
      redisProbe.detail = "redis_unavailable";
    } else {
      redisProbe.ok = true;
      redisProbe.detail = String(result);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    env: {
      nodeEnv: process.env.NODE_ENV || null,
      vercel: Boolean(process.env.VERCEL),
      redisStateEnabled: env.redisStateEnabled,
      redisRateLimitEnabled: env.redisRateLimitEnabled,
      redisReplayEnabled: env.redisReplayEnabled,
      redisConversationEnabled: env.redisConversationEnabled,
      redisPauseEnabled: env.redisPauseEnabled,
      observabilityLogSinkEnabled: Boolean(env.observabilityLogSinkUrl),
      observabilityErrorSinkEnabled: Boolean(env.observabilityErrorSinkUrl),
    },
    redis: {
      before: redisHealthBefore,
      probe: redisProbe,
      after: redisModule.getRedisHealth(),
    },
    observability: getObservabilityDiagnostics(),
    readiness,
  };

  observabilityModule.logInfo("preflight.completed", report);
  if (!redisProbe.ok) {
    throw new Error("Preflight failed: Redis is enabled but unavailable");
  }
  if (
    isStrictPreflightEnabled() &&
    readiness.production &&
    readiness.issues.some((issue) => issue.severity === "critical")
  ) {
    throw new Error(
      `Preflight failed: production readiness score ${readiness.score}/10 (${readiness.issues
        .filter((issue) => issue.severity === "critical")
        .map((issue) => issue.key)
        .join(", ")})`,
    );
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "preflight.failed",
      message,
    }),
  );
  process.exit(1);
});
