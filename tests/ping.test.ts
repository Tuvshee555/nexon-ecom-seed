import assert from "node:assert/strict";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { applyTestEnv } from "./helpers/env";

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string | number | readonly string[]>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name.toLowerCase()] = value;
    },
  };
  return response;
}

test("ping hides diagnostics without admin access", async () => {
  applyTestEnv();
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { default: handler } = await import("../src/pages/api/ping");
  const req = {
    method: "GET",
    url: "/api/ping",
    headers: {},
    query: {},
  } as NextApiRequest;
  const res = createResponse() as unknown as NextApiResponse & {
    statusCode: number;
    body: Record<string, unknown>;
  };

  handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal("readiness" in res.body, false);
});

test("admin ping exposes readiness diagnostics", async () => {
  applyTestEnv({
    DATABASE_URL: "postgres://user:pass@example.com/db",
    NEON_DATABASE_URL: undefined,
  });
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { default: handler } = await import("../src/pages/api/ping");
  const req = {
    method: "GET",
    url: "/api/ping",
    headers: { "x-admin-secret": "test-admin-secret" },
    query: {},
  } as unknown as NextApiRequest;
  const res = createResponse() as unknown as NextApiResponse & {
    statusCode: number;
    body: Record<string, unknown>;
  };

  handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof (res.body.readiness as { score?: unknown }).score, "number");
  assert.equal("metrics" in res.body, true);
});
