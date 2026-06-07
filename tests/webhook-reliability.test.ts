import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { applyTestEnv } from "./helpers/env";

const execFileAsync = promisify(execFile);

type WebhookHandler = (
  req: unknown,
  res: unknown,
) => Promise<unknown>;

function signPayload(rawBody: Buffer, appSecret: string) {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

function createWebhookRequest(payload: unknown, appSecret: string) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = signPayload(rawBody, appSecret);

  return {
    method: "POST",
    url: "/api/webhook",
    query: {},
    headers: {
      "content-length": String(rawBody.length),
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    async *[Symbol.asyncIterator]() {
      yield rawBody;
    },
  } as unknown;
}

function createWebhookResponse() {
  let statusCode = 200;
  let body: unknown;
  const headers = new Map<string, string>();

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    send(value: unknown) {
      body = value;
      return res;
    },
    end(value?: unknown) {
      body = value;
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    get statusCode() {
      return statusCode;
    },
  } as unknown;

  return {
    res,
    result: () => ({
      statusCode,
      body,
      headers: Object.fromEntries(headers),
    }),
  };
}

async function loadWebhookHandler(): Promise<WebhookHandler> {
  const envModule = await import("../src/lib/env");
  const rateLimitModule = await import("../src/lib/rateLimit");
  const resilienceModule = await import("../src/lib/resilience");
  const redisStateModule = await import("../src/lib/redisState");
  const webhookModule = await import("../src/pages/api/webhook");

  envModule.resetEnvCacheForTests();
  rateLimitModule.resetRateLimitForTests();
  resilienceModule.resetResilienceStateForTests();
  redisStateModule.resetRedisStateForTests();
  webhookModule.resetWebhookStateForTests();

  return webhookModule.default as WebhookHandler;
}

async function callWebhook(handler: WebhookHandler, payload: unknown) {
  const appSecret = process.env.META_APP_SECRET || "test-meta-secret";
  const req = createWebhookRequest(payload, appSecret);
  const { res, result } = createWebhookResponse();
  await handler(req, res);
  return result();
}

test("webhook retries transient send failure then dedupes completed event", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let sendAttempts = 0;
  let geminiAttempts = 0;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes(":generateContent")) {
      geminiAttempts += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "Сайн байна уу?" }] } },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return new Response("temporary send failure", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-retry",
          messaging: [
            {
              sender: { id: "ig-user-retry" },
              message: { mid: "ig-mid-retry-1", text: "hello retry path" },
            },
          ],
        },
      ],
    };

    const first = await callWebhook(handler, payload);
    const second = await callWebhook(handler, payload);
    const third = await callWebhook(handler, payload);

    assert.equal(first.statusCode, 503);
    assert.equal(second.statusCode, 200);
    assert.equal(third.statusCode, 200);
    assert.equal(sendAttempts, 2);
    assert.equal(geminiAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook preserves reply order for concurrent same-user requests", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        contents?: { parts?: { text?: string }[] }[];
      };
      const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";
      const matches = Array.from(prompt.matchAll(/User:\s*([^\n]+)\nAssistant:/gm));
      const userText = (matches[matches.length - 1]?.[1] || "unknown").trim();

      if (userText === "first") {
        await sleep(250);
      }

      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: `reply:${userText}` }] } },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        message?: { text?: string };
      };
      sentTexts.push(String(body.message?.text || ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const firstPayload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-concurrency",
          messaging: [
            {
              sender: { id: "ig-user-concurrency" },
              message: { mid: "ig-mid-concurrency-1", text: "first" },
            },
          ],
        },
      ],
    };

    const secondPayload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-concurrency",
          messaging: [
            {
              sender: { id: "ig-user-concurrency" },
              message: { mid: "ig-mid-concurrency-2", text: "second" },
            },
          ],
        },
      ],
    };

    const firstPromise = callWebhook(handler, firstPayload);
    await sleep(20);
    const secondPromise = callWebhook(handler, secondPayload);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(sentTexts, ["reply:first", "reply:second"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook handles long Gemini latency without dropping event", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let sendCount = 0;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes(":generateContent")) {
      await sleep(700);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "slow reply" }] } }],
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      sendCount += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-slow",
          messaging: [
            {
              sender: { id: "ig-user-slow" },
              message: { mid: "ig-mid-slow-1", text: "long latency test" },
            },
          ],
        },
      ],
    };

    const started = Date.now();
    const result = await callWebhook(handler, payload);
    const durationMs = Date.now() - started;

    assert.equal(result.statusCode, 200);
    assert.ok(durationMs >= 650);
    assert.equal(sendCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redis disconnect in replay/conversation mode fails closed with 503", async () => {
  const script = `
    (async () => {
      const { createHmac } = await import("node:crypto");

      process.env.GEMINI_API_KEY = "test-gemini-key";
      process.env.VERIFY_TOKEN = "test-verify-token";
      process.env.TOKEN_PAGE = "test-page-token";
      process.env.FACEBOOK_PAGE_ID = "1234567890";
      process.env.META_APP_SECRET = "test-meta-secret";
      process.env.ADMIN_SECRET = "test-admin-secret";
      process.env.TRUST_PROXY_HEADERS = "true";
      process.env.ALLOW_ADMIN_SECRET_QUERY = "false";
      process.env.REDIS_STATE_ENABLED = "true";
      process.env.REDIS_REPLAY_ENABLED = "true";
      process.env.REDIS_CONVERSATION_ENABLED = "true";
      process.env.REDIS_RATE_LIMIT_ENABLED = "false";
      process.env.REDIS_PAUSE_ENABLED = "false";
      process.env.REDIS_URL = "redis://127.0.0.1:6399";
      process.env.REDIS_CONNECT_TIMEOUT_MS = "100";
      process.env.REDIS_COMMAND_TIMEOUT_MS = "100";

      const envModule = (await import("./src/lib/env")).default;
      const rateLimitModule = (await import("./src/lib/rateLimit")).default;
      const resilienceModule = (await import("./src/lib/resilience")).default;
      const redisStateModule = (await import("./src/lib/redisState")).default;
      const webhookBundle = (await import("./src/pages/api/webhook")).default;
      const webhookHandler = webhookBundle.default;

      envModule.resetEnvCacheForTests();
      rateLimitModule.resetRateLimitForTests();
      resilienceModule.resetResilienceStateForTests();
      redisStateModule.resetRedisStateForTests();
      webhookBundle.resetWebhookStateForTests();

      globalThis.fetch = async () => {
        return new Response("unexpected", { status: 500 });
      };

      const payload = {
        object: "instagram",
        entry: [
          {
            id: "ig-page-redis",
            messaging: [
              {
                sender: { id: "ig-user-redis" },
                message: { mid: "ig-mid-redis-1", text: "redis check" }
              }
            ]
          }
        ]
      };

      const raw = Buffer.from(JSON.stringify(payload), "utf8");
      const signature = "sha256=" + createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");

      const req = {
        method: "POST",
        url: "/api/webhook",
        query: {},
        headers: {
          "content-length": String(raw.length),
          "x-hub-signature-256": signature,
          "content-type": "application/json",
        },
        async *[Symbol.asyncIterator]() {
          yield raw;
        },
      };

      let statusCode = 200;
      let body = null;
      const headers = new Map();
      const res = {
        status(code) { statusCode = code; return res; },
        json(value) { body = value; return res; },
        send(value) { body = value; return res; },
        end(value) { body = value; return res; },
        setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
        get statusCode() { return statusCode; },
      };

      await webhookHandler(req, res);
      console.log("RESULT:" + JSON.stringify({ statusCode, body, headers: Object.fromEntries(headers) }));
      process.exit(0);
    })().catch((error) => {
      console.error("SCRIPT_ERROR:" + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    });
  `;

  const { stdout } = await execFileAsync(
    "node",
    ["--import", "tsx", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      timeout: 20_000,
    },
  );

  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("RESULT:"));

  assert.ok(line, "Missing RESULT output from redis fail-closed subprocess");
  const result = JSON.parse(String(line).slice("RESULT:".length)) as {
    statusCode: number;
    body?: { error?: string };
  };
  assert.equal(result.statusCode, 503);
  assert.equal(result.body?.error, "retryable_failure");
});
