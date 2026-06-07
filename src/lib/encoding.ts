const MOJIBAKE_HINT = /[ÃÂÐÑÒÓÔÕÖØÝÞ]/;
const MONGOLIAN_HINT = /[А-Яа-яЁёӨөҮү]/;

export function fixMojibake(text: string) {
  if (!text) return text;
  if (!MOJIBAKE_HINT.test(text)) return text;

  const decoded = Buffer.from(text, "latin1").toString("utf8");
  if (MONGOLIAN_HINT.test(decoded) && !decoded.includes("�")) return decoded;
  return text;
}
