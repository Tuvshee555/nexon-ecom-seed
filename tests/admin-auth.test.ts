import assert from "node:assert/strict";
import test from "node:test";
import { pickFirst, safeSecretCompare } from "../src/lib/adminAuth";

test("safeSecretCompare matches only exact secret", () => {
  assert.equal(safeSecretCompare("abc123", "abc123"), true);
  assert.equal(safeSecretCompare("abc123", "abc124"), false);
  assert.equal(safeSecretCompare("abc123", "abc1234"), false);
  assert.equal(safeSecretCompare("abc123", ""), false);
});

test("pickFirst handles array and scalar headers safely", () => {
  assert.equal(pickFirst([" first ", "second"]), "first");
  assert.equal(pickFirst(" value "), "value");
  assert.equal(pickFirst(undefined), "");
});
