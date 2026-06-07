const WEBSITE_URL = "";
const WEBSITE_REPLY =
  "Төлбөрийн заавар, дансны мэдээллийг чат дээр баталгаажуулахгүй. Тухайн оператороос албан ёсоор баталгаажуулж авна уу.";

const PAYMENT_LEAK_PATTERNS: RegExp[] = [
  /\/register/i,
  /регистер\s*хуудас/i,
  /register\s*page/i,
  /данс\s*(?:руу\s*)?шилжүүл/i,
  /данс(?:аар|ны\s*дугаар)/i,
  /qpay\s*(?:эсвэл|болон|-?р\s*төл|-?аар\s*төл)/i,
  /(?:qpay|кюпэй).{0,30}(?:төл|шилжүүл)/i,
  /төлбөрийг\s*(?:qpay|кюпэй|данс)/i,
];

function containsLeakedPaymentInstruction(text: string) {
  if (!text) return false;
  if (WEBSITE_URL && text.includes(WEBSITE_URL)) return false;
  return PAYMENT_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function enforceWebsiteForPayment(text: string) {
  if (containsLeakedPaymentInstruction(text)) return WEBSITE_REPLY;
  return text;
}

function stripMarkdown(text: string): string {
  return text
    // [link text](url) → just the url
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$2")
    // **bold** or __bold__ → plain
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    // *italic* or _italic_ → plain
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // # headers → plain
    .replace(/^#{1,6}\s+/gm, "")
    // bullet points * or - at line start → plain
    .replace(/^[\*\-]\s+/gm, "")
    // dedupe consecutive identical URLs on separate lines
    .replace(/(https?:\/\/[^\s]+)\n\1/g, "$1");
}

function normalizeWhitespace(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeForCompare(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function sanitizeAssistantReply(text: string) {
  const cleaned = normalizeWhitespace(stripMarkdown(text));
  if (!cleaned) return "Энэ мэдээлэл одоогоор тодорхойгүй байна. Хүний ажилтантай холбож өгье.";

  const dedupedParagraphs: string[] = [];
  const seenParagraphs = new Set<string>();

  for (const paragraph of cleaned.split("\n")) {
    const normalizedParagraph = normalizeForCompare(paragraph);
    if (!normalizedParagraph || seenParagraphs.has(normalizedParagraph)) continue;
    seenParagraphs.add(normalizedParagraph);

    const uniqueSentences: string[] = [];
    const seenSentences = new Set<string>();
    for (const sentence of splitSentences(paragraph)) {
      const normalizedSentence = normalizeForCompare(sentence);
      if (!normalizedSentence || seenSentences.has(normalizedSentence)) continue;
      seenSentences.add(normalizedSentence);
      uniqueSentences.push(sentence);
      if (uniqueSentences.length >= 5) break;
    }

    if (uniqueSentences.length) {
      dedupedParagraphs.push(uniqueSentences.join(" "));
    }
  }

  return dedupedParagraphs.join("\n").trim() || "Энэ мэдээлэл одоогоор тодорхойгүй байна. Хүний ажилтантай холбож өгье.";
}

export function isDuplicateReply(
  previousReply: string | undefined,
  nextReply: string,
) {
  if (!previousReply) return false;
  return normalizeForCompare(previousReply) === normalizeForCompare(nextReply);
}
