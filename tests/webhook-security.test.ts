import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  parseWebhookJson,
  PayloadTooLargeError,
  readRawBodyLimited,
  verifyMetaSignature,
} from "../src/lib/webhookSecurity";

function sha256Signature(payload: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function sha1Signature(payload: string, secret: string) {
  return `sha1=${crypto.createHmac("sha1", secret).update(payload).digest("hex")}`;
}

test("webhook signature verification accepts valid sha256 and sha1 signatures", () => {
  const secret = "test-secret";
  const payload = JSON.stringify({ object: "page", entry: [] });
  const raw = Buffer.from(payload, "utf8");

  assert.equal(
    verifyMetaSignature(raw, sha256Signature(payload, secret), secret),
    true,
  );
  assert.equal(
    verifyMetaSignature(raw, sha1Signature(payload, secret), secret),
    true,
  );
  assert.equal(
    verifyMetaSignature(raw, "sha256=deadbeef", secret),
    false,
  );
});

test("readRawBodyLimited rejects oversized payloads", async () => {
  const stream = (async function* generate() {
    yield Buffer.from("a".repeat(600));
    yield Buffer.from("b".repeat(600));
  }());

  await assert.rejects(
    () => readRawBodyLimited(stream, 1024, "1200"),
    PayloadTooLargeError,
  );
});

test("readRawBodyLimited preserves body when within limit", async () => {
  const stream = (async function* generate() {
    yield Buffer.from("{\"ok\":");
    yield Buffer.from("true}");
  }());
  const body = await readRawBodyLimited(stream, 1024, "11");
  assert.equal(body.toString("utf8"), "{\"ok\":true}");
});

test("parseWebhookJson throws on malformed payload", () => {
  assert.throws(
    () => parseWebhookJson(Buffer.from("{\"object\":\"page\",\"entry\":[", "utf8")),
    SyntaxError,
  );
});
