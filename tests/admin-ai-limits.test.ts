import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { applyTestEnv } from "./helpers/env";

type TestResponse = NextApiResponse & {
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, string | number | readonly string[]>;
};

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string | number | readonly string[]>,
    body: undefined as unknown as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
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
  return response as unknown as TestResponse;
}

async function prepareEnvironment() {
  applyTestEnv({
    DATABASE_URL: "postgres://user:pass@example.com/db",
    NEON_DATABASE_URL: undefined,
  });
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const rateLimitModule = await import("../src/lib/rateLimit");
  rateLimitModule.resetRateLimitForTests();
}

function createAdminJsonRequest(
  path: string,
  body: Record<string, unknown>,
  ip: string,
) {
  return {
    method: "POST",
    url: path,
    headers: {
      "x-admin-secret": "test-admin-secret",
      "x-forwarded-for": ip,
    },
    query: {},
    body,
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
}

function createAdminStreamRequest(
  path: string,
  body: Record<string, unknown>,
  ip: string,
  contentLength?: string,
) {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as unknown as NextApiRequest;
  Object.assign(req, {
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      "content-length": contentLength || String(Buffer.byteLength(raw)),
      "x-admin-secret": "test-admin-secret",
      "x-forwarded-for": ip,
    },
    query: {},
    socket: { remoteAddress: ip },
  });
  return req;
}

test("admin AI change rejects only truly oversized instructions", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");

  // A long pasted price list (over the old 4k cap) must NOT be rejected — it is
  // auto-split into batches. Only an absurdly large paste is turned away.
  const okRes = createResponse();
  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      { instruction: "x".repeat(4_001) },
      "203.0.113.10",
    ),
    okRes,
  );
  assert.notEqual(okRes.body?.error, "instruction_too_long");

  const tooLongRes = createResponse();
  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      { instruction: "x".repeat(500_001) },
      "203.0.113.10",
    ),
    tooLongRes,
  );
  assert.equal(tooLongRes.statusCode, 413);
  assert.equal(tooLongRes.body.error, "instruction_too_long");
  assert.equal(tooLongRes.body.max_chars, 500_000);
});

test("admin AI change requires explicit rollback confirmation", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");
  const res = createResponse();

  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      { request_id: 123, rollback: true },
      "203.0.113.11",
    ),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "confirmation_required");
});

test("admin AI change rate limits repeated admin AI attempts", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");
  let last = createResponse();

  for (let index = 0; index < 31; index += 1) {
    last = createResponse();
    await handler(
      createAdminJsonRequest(
        "/api/admin/ai-change",
        { instruction: "x".repeat(4_001) },
        "203.0.113.12",
      ),
      last,
    );
  }

  assert.equal(last.statusCode, 429);
  assert.equal(last.body.error, "rate_limited");
});

test("admin file parse no longer rejects batches on upload count", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/parse-file");
  const upload = {
    filename: "tiny.txt",
    mimeType: "text/plain",
    dataBase64: Buffer.from("trip").toString("base64"),
  };
  const res = createResponse();

  await handler(
    createAdminStreamRequest(
      "/api/admin/parse-file",
      { uploads: [upload, upload, upload, upload, upload, upload] },
      "203.0.113.13",
    ),
    res,
  );

  // The per-request upload-count cap was lifted, so a six-file batch must NOT
  // be turned away with the old "too_many_uploads" rejection. (It may still
  // fail later for unrelated reasons like missing AI creds in the test env.)
  assert.notEqual(res.body?.error, "too_many_uploads");
});

test("admin file parse rejects oversized raw payloads by content length", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/parse-file");
  const res = createResponse();

  await handler(
    createAdminStreamRequest(
      "/api/admin/parse-file",
      {},
      "203.0.113.14",
      "4500001",
    ),
    res,
  );

  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, "upload_payload_too_large");
  assert.equal(res.body.max_bytes, 4_500_000);
});
