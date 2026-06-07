import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadEnvModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  return envModule;
}

test("env validation accepts valid configuration", async () => {
  applyTestEnv();
  const envModule = await loadEnvModule();
  const env = envModule.getEnv();
  assert.equal(env.demoMaxTextChars, 1000);
  assert.equal(env.geminiMaxRetries, 1);
  assert.equal(env.webhookMaxBodyBytes, 1048576);
  assert.equal(env.adminOpenAccess, false);
  assert.equal(env.googleDriveSyncEnabled, false);
  assert.equal(env.googleDriveSyncIntervalMinutes, 30);
});

test("env validation rejects open admin access in production", async () => {
  applyTestEnv({
    ADMIN_OPEN_ACCESS: "true",
    NODE_ENV: "production",
  });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /ADMIN_OPEN_ACCESS cannot be true in production/i,
  );
});

test("env validation allows Vercel production hardening to be reported by readiness", async () => {
  applyTestEnv({
    VERCEL: "1",
    VERCEL_ENV: "production",
    DATABASE_URL: "postgres://user:pass@example.com/db",
    NEON_DATABASE_URL: undefined,
    REDIS_URL: undefined,
    REDIS_STATE_ENABLED: "false",
    REDIS_RATE_LIMIT_ENABLED: "false",
    REDIS_REPLAY_ENABLED: "false",
    REDIS_CONVERSATION_ENABLED: "false",
    REDIS_PAUSE_ENABLED: "false",
    OBSERVABILITY_LOG_SINK_URL: undefined,
    OBSERVABILITY_ERROR_SINK_URL: undefined,
  });
  const envModule = await loadEnvModule();
  const env = envModule.getEnv();

  assert.equal(env.redisUrl, null);
  assert.equal(env.redisReplayEnabled, false);
  assert.equal(env.observabilityErrorSinkUrl, null);
});

test("env validation accepts hardened Vercel production configuration", async () => {
  applyTestEnv({
    VERCEL: "1",
    VERCEL_ENV: "production",
    DATABASE_URL: "postgres://user:pass@example.com/db",
    NEON_DATABASE_URL: undefined,
    REDIS_URL: "redis://example.com:6379",
    REDIS_STATE_ENABLED: "true",
    REDIS_RATE_LIMIT_ENABLED: "true",
    REDIS_REPLAY_ENABLED: "true",
    REDIS_CONVERSATION_ENABLED: "true",
    REDIS_PAUSE_ENABLED: "true",
    OBSERVABILITY_ERROR_SINK_URL: "https://errors.example.com",
  });
  const envModule = await loadEnvModule();
  const env = envModule.getEnv();

  assert.equal(env.redisUrl, "redis://example.com:6379");
  assert.equal(env.redisReplayEnabled, true);
  assert.equal(env.observabilityErrorSinkUrl, "https://errors.example.com");
});

test("env validation derives REDIS_URL from Upstash REST credentials", async () => {
  applyTestEnv({
    REDIS_URL: undefined,
    UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "token with symbols:/?",
    REDIS_STATE_ENABLED: "true",
    REDIS_RATE_LIMIT_ENABLED: "true",
    REDIS_REPLAY_ENABLED: "true",
    REDIS_CONVERSATION_ENABLED: "true",
    REDIS_PAUSE_ENABLED: "true",
  });
  const envModule = await loadEnvModule();
  const env = envModule.getEnv();

  assert.equal(
    env.redisUrl,
    "rediss://default:token%20with%20symbols%3A%2F%3F@example-12345.upstash.io:6379",
  );
});

test("env validation auto-enables Redis state from Upstash REST credentials alone", async () => {
  applyTestEnv({
    REDIS_URL: undefined,
    REDIS_STATE_ENABLED: undefined,
    UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "tok",
  });
  const envModule = await loadEnvModule();
  const env = envModule.getEnv();

  assert.equal(env.redisStateEnabled, true);
});

test("env validation rejects NaN values", async () => {
  applyTestEnv({ DEMO_GLOBAL_RATE_LIMIT: "NaN" });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /DEMO_GLOBAL_RATE_LIMIT must be an integer/,
  );
});

test("env validation rejects negative/too-small values", async () => {
  applyTestEnv({ WEBHOOK_MAX_BODY_BYTES: "-1" });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /WEBHOOK_MAX_BODY_BYTES must be >= 65536/,
  );
});

test("env validation rejects empty required secrets", async () => {
  applyTestEnv({ ADMIN_SECRET: "   " });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /ADMIN_SECRET is required and must be a non-empty string/,
  );
});

test("env validation requires REDIS_URL when redis state flags are enabled", async () => {
  applyTestEnv({
    REDIS_STATE_ENABLED: "true",
    REDIS_RATE_LIMIT_ENABLED: "true",
    REDIS_URL: undefined,
  });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /REDIS_URL is required when any REDIS_\*_ENABLED feature flag is true/,
  );
});

test("env validation requires full Google Drive sync credentials when enabled", async () => {
  applyTestEnv({
    GOOGLE_DRIVE_SYNC_ENABLED: "true",
    GOOGLE_DRIVE_FOLDER_ID: "folder-123",
    GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: undefined,
    GOOGLE_DRIVE_PRIVATE_KEY: undefined,
  });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /GOOGLE_DRIVE_SYNC_ENABLED requires GOOGLE_DRIVE_FOLDER_ID, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_DRIVE_PRIVATE_KEY/i,
  );
});
