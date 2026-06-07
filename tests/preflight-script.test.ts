import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const BASE_ENV = {
  ...process.env,
  GEMINI_API_KEY: "test-gemini-key",
  VERIFY_TOKEN: "test-verify-token",
  TOKEN_PAGE: "test-page-token",
  FACEBOOK_PAGE_ID: "1234567890",
  META_APP_SECRET: "test-meta-secret",
  ADMIN_SECRET: "test-admin-secret",
  ADMIN_OPEN_ACCESS: "false",
  ALLOW_ADMIN_SECRET_QUERY: "false",
  TRUST_PROXY_HEADERS: "true",
  DATABASE_URL: "postgres://user:pass@example.com/db",
  NEON_DATABASE_URL: "",
  REDIS_STATE_ENABLED: "false",
  REDIS_RATE_LIMIT_ENABLED: "false",
  REDIS_REPLAY_ENABLED: "false",
  REDIS_CONVERSATION_ENABLED: "false",
  REDIS_PAUSE_ENABLED: "false",
  REDIS_URL: "",
  OBSERVABILITY_LOG_SINK_URL: "",
  OBSERVABILITY_ERROR_SINK_URL: "",
  OBSERVABILITY_SINK_TIMEOUT_MS: "2000",
  OBSERVABILITY_SINK_BATCH_SIZE: "20",
  VERCEL_ENV: "production",
  VERCEL: "1",
};

test("preflight treats optional production ops sinks as ready by default", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/preflight.ts"],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, STRICT_PREFLIGHT: "" },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"score":10/);
});

test("preflight strict mode does not require optional production ops sinks", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/preflight.ts"],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, STRICT_PREFLIGHT: "true" },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"score":10/);
});
