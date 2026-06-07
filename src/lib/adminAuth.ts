import crypto from "crypto";

export function pickFirst(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export function safeSecretCompare(expectedSecret: string, provided: string) {
  if (!expectedSecret || !provided) return false;
  const expected = Buffer.from(expectedSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
