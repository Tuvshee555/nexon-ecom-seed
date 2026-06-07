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

test("admin system hides diagnostics without admin access", async () => {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  applyTestEnv({
    DATABASE_URL: undefined,
    NEON_DATABASE_URL: undefined,
  });

  const { default: handler } = await import("../src/pages/api/admin/system");
  const req = {
    method: "GET",
    url: "/api/admin/system",
    headers: {},
    query: {},
  } as NextApiRequest;
  const res = createResponse() as unknown as NextApiResponse & {
    statusCode: number;
    body: Record<string, unknown>;
  };

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.open_access, false);
  assert.equal(res.body.authorized, false);
  assert.equal("db" in res.body, false);
  assert.equal("drive_sync" in res.body, false);
});
