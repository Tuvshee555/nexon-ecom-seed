import Head from "next/head";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "@/components/ui";
import { extractGoogleDriveFileIds } from "@/lib/googleDriveLinks";

/* ----------------------------------------------------------------
   Types
   ---------------------------------------------------------------- */
type TripStatus = "active" | "cancelled" | "sold_out" | "draft";

type TravelTrip = {
  id: string;
  category: string;
  operator_name: string;
  route_name: string;
  duration_text: string;
  adult_price: number | null;
  child_price: number | null;
  currency: string;
  departure_dates: string[];
  seats_total: number | null;
  seats_left: number | null;
  has_food: boolean | null;
  status: TripStatus;
  notes: string;
  source_description: string;
  updated_at: string;
};

type PauseRow = {
  sender_id: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};

type RecentRow = { sender_id: string; last_seen: string };

type ControlState = {
  bot_paused: boolean;
  pause_reason: string | null;
  updated_at: string;
};

type TravelBotSettings = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string[];
  comment_trigger_patterns: string[];
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: Record<string, unknown>[];
  discount_policies: Record<string, unknown>[];
  verified_credentials: Record<string, unknown>[];
  faq: Record<string, unknown>[];
  handoff_enabled: boolean;
  handoff_keywords: string[];
  handoff_reply: string;
  handoff_pause_minutes: number;
  updated_at: string;
};

type StructuredRow = Record<string, string>;

type SettingsForm = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string;
  comment_trigger_patterns: string;
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: StructuredRow[];
  discount_policies: StructuredRow[];
  verified_credentials: StructuredRow[];
  faq: StructuredRow[];
  handoff_enabled: boolean;
  handoff_keywords: string;
  handoff_reply: string;
  handoff_pause_minutes: string;
};

type AIAction = {
  action: string;
  trip_id?: string;
  match?: { operator_name?: string; route_name?: string };
  fields?: Record<string, unknown>;
};

type AIProposal = {
  summary: string;
  needs_confirmation: boolean;
  important_reason: string;
  conflicts: string[];
  actions: AIAction[];
};

type AIProposalResponse = {
  proposal?: AIProposal;
  request_id?: number;
  error?: string;
  message?: string;
  retry_after_ms?: number;
  max_chars?: number;
  max_bytes?: number;
  max_file_bytes?: number;
  max_total_bytes?: number;
  max_uploads?: number;
  max_drive_files?: number;
  reset?: number;
};

type ClarificationOption = {
  label: string;
  answer: string;
};

type ClarificationQuestion = {
  id: string;
  prompt: string;
  detail?: string;
  options: ClarificationOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
};

type ClarificationAnswer = {
  questionId: string;
  prompt: string;
  answer: string;
};

type AdminMsg = {
  id: string;
  role: "admin";
  text: string;
  fileNames?: string[];
};
type ProposalMsg = {
  id: string;
  role: "assistant";
  kind: "proposal";
  proposal: AIProposal;
  requestId: number | null;
  instruction: string;
  status: "pending" | "applied" | "reverted" | "cancelled" | "error";
  confirmChecked: boolean;
  resultText?: string;
  clarifications: ClarificationQuestion[];
  clarificationAnswers: ClarificationAnswer[];
  answeredClarificationIds: string[];
  customReply: string;
};
type NoteMsg = {
  id: string;
  role: "assistant";
  kind: "note";
  text: string;
  tone: "info" | "error" | "success";
};
type ChatMessage = AdminMsg | ProposalMsg | NoteMsg;

type AttachedFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  file: File;
};

type ParseUploadUnit = {
  displayName: string;
  filename: string;
  mimeType: string;
  dataUrl: string;
};

type TabKey = "assistant" | "trips" | "bot" | "leads" | "settings";

type TravelLead = {
  id: number;
  kind: "handoff" | "booking";
  platform: string;
  sender_id: string;
  customer_message: string;
  contact_phone: string;
  context: string;
  status: "new" | "seen";
  created_at: string;
  seen_at: string | null;
};

type LeadStats = {
  total: number;
  new_count: number;
  today: number;
  last7days: number;
  last30days: number;
  by_platform: Array<{ platform: string; count: number }>;
  by_kind: Array<{ kind: string; count: number }>;
  daily: Array<{ day: string; count: number }>;
};

type DriveSyncRecentFile = {
  file_id: string;
  file_name: string;
  last_status: string;
  last_error: string;
  request_id: number | null;
  updated_at: string;
};

type DriveSyncDiagnostics = {
  enabled: boolean;
  configured: boolean;
  folder_id: string | null;
  service_account_email: string | null;
  interval_minutes: number;
  file_limit: number;
  state: {
    status: "idle" | "running" | "success" | "warning" | "error";
    last_checked_at: string | null;
    last_synced_at: string | null;
    last_error: string;
    last_summary: string;
    last_run_id: string;
    files_examined: number;
    files_changed: number;
    files_applied: number;
    files_blocked: number;
    updated_at: string | null;
  };
  recent_files: DriveSyncRecentFile[];
};

type ReadinessReport = {
  score: number;
  production: boolean;
  issues: Array<{
    key: string;
    severity: "critical" | "warning";
    message: string;
  }>;
};

/* ----------------------------------------------------------------
   Constants & helpers
   ---------------------------------------------------------------- */
const SECRET_KEY = "travel_admin_secret";
const SECRET_TS_KEY = "travel_admin_secret_ts";
// Remember the device for 7 days, sliding: the timer resets every time the
// admin opens/uses the panel, so it only logs out after a full week of no use.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_AUTO_REFRESH_MS =
  process.env.NODE_ENV === "development" ? 0 : 45_000;
const MAX_PARSE_UPLOAD_BYTES = 850_000;
const MAX_TEXT_PARSE_CHARS = 60_000;
const MAX_ATTACHED_FILES = 5;
const MAX_CLIENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CLIENT_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
// Allow very large pasted price lists. Oversized pastes are auto-split into
// safe AI-sized batches server-side, so the admin can paste a whole list (or
// several) at once without it ever being truncated or rejected.
const MAX_AI_INPUT_CHARS = 500_000;
const MAX_DRIVE_LINKS = 5;
// Accept everything in the picker so nothing looks greyed-out. Unsupported
// types still get a clear message after selection rather than being silently
// unselectable.
const ACCEPT_FILES = "*";

const STATUS_LABELS: Record<TripStatus, string> = {
  active: "Идэвхтэй",
  cancelled: "Цуцлагдсан",
  sold_out: "Суудал дууссан",
  draft: "Ноорог",
};

const STATUS_TONE: Record<TripStatus, "success" | "danger" | "warning" | "neutral"> =
  {
    active: "success",
    cancelled: "danger",
    sold_out: "warning",
    draft: "neutral",
  };

const FIELD_LABELS: Record<string, string> = {
  category: "Ангилал",
  operator_name: "Оператор",
  route_name: "Маршрут",
  duration_text: "Хугацаа",
  adult_price: "Том хүний үнэ",
  child_price: "Хүүхдийн үнэ",
  currency: "Валют",
  departure_dates: "Гарах өдөр",
  seats_total: "Нийт суудал",
  seats_left: "Үлдсэн суудал",
  has_food: "Хоол",
  status: "Төлөв",
  notes: "Тэмдэглэл",
  source_description: "Эх сурвалж",
};

const DURATIONS: Array<{ label: string; ms: number | null }> = [
  { label: "10 мин", ms: 10 * 60 * 1000 },
  { label: "30 мин", ms: 30 * 60 * 1000 },
  { label: "1 цаг", ms: 60 * 60 * 1000 },
  { label: "∞", ms: null },
];

const HANDOFF_DURATION_OPTIONS = [
  { label: "30 минут", value: "30" },
  { label: "1 цаг", value: "60" },
  { label: "2 цаг", value: "120" },
  { label: "Гараар сэргээх хүртэл", value: "0" },
] as const;

const HANDOFF_DURATION_CUSTOM = "custom";

const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  { label: "Аялал цуцлах", prompt: "Дараах аяллыг цуцал: " },
  { label: "Суудал шинэчлэх", prompt: "Дараах аяллын үлдсэн суудлыг шинэчил: " },
  { label: "Үнэ өөрчлөх", prompt: "Дараах аяллын үнийг өөрчил: " },
  { label: "Хоол", prompt: "Дараах аяллын хоолны мэдээллийг өөрчил: " },
  {
    label: "Шинэ аялал",
    prompt:
      "Шинэ аялал нэм. Оператор: , Маршрут: , Хугацаа: , Том хүний үнэ: , Гарах өдөр: ",
  },
];

let idCounter = 0;
function uid(): string {
  idCounter += 1;
  return `m${Date.now().toString(36)}${idCounter}`;
}

function getSecretStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

const TEST_BOT_CONVERSATION_KEY = "admin_testbot_conversation_id";

function getTestBotConversationId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.sessionStorage.getItem(TEST_BOT_CONVERSATION_KEY);
  if (existing) return existing;
  const nextId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
  window.sessionStorage.setItem(TEST_BOT_CONVERSATION_KEY, nextId);
  return nextId;
}

function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  return element.matches(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  );
}

function asInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.trim().toLowerCase().endsWith(".pdf")
  );
}

function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(file.name.trim())
  );
}

function isTextLikeFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    /\.(csv|txt|text|md|log)$/i.test(file.name.trim())
  );
}

function isOfficeDocFile(file: File): boolean {
  return /\.(xlsx|xlsm|xls|docx)$/i.test(file.name.trim());
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function textToDataUrl(text: string): string {
  return bytesToDataUrl(new TextEncoder().encode(text), "text/plain");
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatWaitMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return "бага зэрэг хүлээгээд";
  }
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} секунд хүлээгээд`;
  return `${Math.ceil(seconds / 60)} минут хүлээгээд`;
}

function apiErrorMessage(
  data: Partial<AIProposalResponse> | undefined,
  fallback: string,
): string {
  const code = String(data?.error || "").trim();
  const raw = String(data?.message || data?.error || "").trim();
  const wait = formatWaitMs(data?.retry_after_ms);

  if (code === "rate_limited") {
    return `AI хэсэг түр хязгаарлагдлаа. ${wait} дахин оролдоно уу.`;
  }
  if (code === "instruction_too_long") {
    return `Заавар хэт урт байна. ${data?.max_chars || MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`;
  }
  if (code === "clarification_too_long") {
    return `Тодруулга хэт урт байна. ${data?.max_chars || MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`;
  }
  if (code === "note_too_long") {
    return `Файлтай хамт бичсэн тайлбар хэт урт байна. ${data?.max_chars || MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`;
  }
  if (code === "upload_payload_too_large") {
    return `Нэг удаагийн файл илгээх хэмжээ хэтэрлээ. Файлаа жижиглээд дахин оруулна уу.`;
  }
  if (code === "upload_file_too_large") {
    return `Нэг файл ${formatBytes(Number(data?.max_file_bytes) || MAX_CLIENT_FILE_BYTES)}-аас том байна. Файлаа жижиглээд дахин оруулна уу.`;
  }
  if (code === "upload_total_too_large") {
    return `Нэг удаагийн нийт файлын хэмжээ ${formatBytes(Number(data?.max_total_bytes) || MAX_CLIENT_TOTAL_FILE_BYTES)}-аас хэтэрлээ. Файлуудаа хэсэг хэсгээр нь оруулна уу.`;
  }
  if (code === "too_many_uploads") {
    return `Нэг удаад ${data?.max_uploads || MAX_ATTACHED_FILES}-аас олон файл илгээхгүй. Файлуудаа хэсэг хэсгээр нь оруулна уу.`;
  }
  if (code === "too_many_drive_files") {
    return `Нэг удаад ${data?.max_drive_files || MAX_DRIVE_LINKS}-аас олон Drive файл уншихгүй. Хэсэглээд дахин оруулна уу.`;
  }
  if (/too large|request limit/i.test(raw)) {
    return "Файл эсвэл хүсэлт хэт том байна. Файлаа жижиглээд эсвэл цөөн файл сонгоод дахин оролдоно уу.";
  }
  if (/rate.?limit|quota|temporarily rate limited/i.test(raw)) {
    return `AI үйлчилгээ түр завгүй байна. ${wait} дахин оролдоно уу.`;
  }
  if (/timed out|too long|timeout/i.test(raw)) {
    return "AI хариу өгөхөд хэт удлаа. Асуултаа богино, тодорхой болгоод дахин оролдоно уу.";
  }
  if (/temporarily unavailable|circuit|upstream/i.test(raw)) {
    return `AI үйлчилгээ түр боломжгүй байна. ${wait} дахин оролдоно уу.`;
  }

  return raw || fallback;
}

function isTransientAiFailure(proposal: AIProposal | undefined): boolean {
  if (!proposal) return false;
  const text = [
    proposal.summary,
    proposal.important_reason,
    ...(proposal.conflicts || []),
  ].join(" ");
  return /429|rate.?limit|quota|resource.?exhausted|circuit|upstream|could not finish reading batch/i.test(
    text,
  );
}

function chunkText(text: string, maxChars = MAX_TEXT_PARSE_CHARS): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    const splitAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
    );
    const end = splitAt > maxChars * 0.6 ? splitAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function pdfTextItemsToText(items: unknown[]): string {
  const lines: string[] = [];
  let current = "";
  let lastY: number | null = null;
  let lastX: number | null = null;

  const flush = () => {
    const line = current.replace(/[ \t]+/g, " ").trim();
    if (line) lines.push(line);
    current = "";
    lastY = null;
    lastX = null;
  };

  for (const rawItem of items) {
    const item = rawItem as {
      str?: string;
      width?: number;
      transform?: number[];
      hasEOL?: boolean;
    };
    const text = item.str?.trim();
    if (!text) continue;
    const x = Array.isArray(item.transform) ? item.transform[4] : null;
    const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
    if (lastY != null && y != null && Math.abs(y - lastY) > 4) {
      flush();
    }
    if (current) {
      current += x != null && lastX != null && x - lastX > 24 ? "\t" : " ";
    }
    current += text;
    if (x != null) lastX = x + (item.width || text.length * 5);
    if (y != null) lastY = y;
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join("\n");
}

type PdfViewport = { width: number; height: number };
type PdfRenderPage = {
  getViewport(input: { scale: number }): PdfViewport;
  render(input: unknown): { promise: Promise<void> };
  getTextContent(): Promise<{ items: unknown[] }>;
};
type PdfDocumentProxy = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfRenderPage>;
};

async function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentProxy> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  return (await loadingTask.promise) as PdfDocumentProxy;
}

async function extractPdfText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await loadPdfDocument(bytes);
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = pdfTextItemsToText(content.items);
    if (text.trim()) {
      pages.push(`Page ${pageNumber}\n${text}`);
    }
  }

  return pages.join("\n\n").trim();
}

async function canvasToJpegBytes(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) throw new Error("PDF хуудсыг зураг болгож чадсангүй.");
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderPdfPageAsImageUnit(
  originalBytes: Uint8Array,
  filename: string,
  pageIndex: number,
  partNumber: number,
): Promise<ParseUploadUnit> {
  const pdf = await loadPdfDocument(originalBytes);
  const page = await pdf.getPage(pageIndex + 1);
  let scale = 1.45;
  let quality = 0.82;
  let bestBytes: Uint8Array | null = null;

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new Error("PDF хуудсыг зураг болгож чадсангүй.");

    await page.render({ canvasContext, viewport }).promise;
    const bytes = await canvasToJpegBytes(canvas, quality);
    if (!bestBytes || bytes.byteLength < bestBytes.byteLength) {
      bestBytes = bytes;
    }
    if (bytes.byteLength <= MAX_PARSE_UPLOAD_BYTES) {
      return {
        displayName: `${filename} (${partNumber}, page ${pageIndex + 1})`,
        filename: `${filename}.part-${String(partNumber).padStart(3, "0")}.page-${String(pageIndex + 1).padStart(3, "0")}.jpg`,
        mimeType: "image/jpeg",
        dataUrl: bytesToDataUrl(bytes, "image/jpeg"),
      };
    }

    if (quality > 0.46) {
      quality -= 0.12;
    } else {
      scale *= 0.72;
      quality = 0.72;
    }
  }

  throw new Error(
    `"${filename}" PDF-ийн ${pageIndex + 1}-р хуудсыг request limit-д багтааж жижиглэж чадсангүй (${formatBytes(bestBytes?.byteLength || 0)}).`,
  );
}

async function createPdfChunkBytes(
  sourcePdf: import("pdf-lib").PDFDocument,
  pageIndexes: number[],
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const chunkPdf = await PDFDocument.create();
  const pages = await chunkPdf.copyPages(sourcePdf, pageIndexes);
  for (const page of pages) {
    chunkPdf.addPage(page);
  }
  return chunkPdf.save({ useObjectStreams: true });
}

// Decides whether extracted PDF text is a real text layer worth sending as
// text, vs junk from a scanned/image PDF (which should go to OCR instead).
// Requires enough length AND a healthy share of letters/digits so a few stray
// glyphs from a scan don't get mistaken for a usable text layer.
function isUsablePdfText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200) return false;
  const wordChars = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  return wordChars >= 120 && wordChars / trimmed.length >= 0.5;
}

async function buildPdfUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const { PDFDocument } = await import("pdf-lib");
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = "application/pdf";

  // Accuracy-first: if the PDF has a real text layer, send the AI clean
  // extracted text (like Excel→HTML) instead of the raw binary. The model
  // reads structured text far more reliably than a PDF blob, so prices/tables
  // come through more accurately — and it costs fewer tokens too. This runs for
  // ALL sizes now (previously small PDFs skipped straight to binary). Scanned
  // PDFs with no text layer fall through to the binary/image path below, where
  // Gemini's OCR handles them.
  const extractedText = await extractPdfText(file).catch(() => "");
  if (isUsablePdfText(extractedText)) {
    return chunkText(extractedText).map((chunk, index, chunks) => ({
      displayName:
        chunks.length > 1 ? `${file.name} (${index + 1}/${chunks.length})` : file.name,
      filename: `${file.name}.text-${String(index + 1).padStart(3, "0")}.txt`,
      mimeType: "text/plain",
      dataUrl: textToDataUrl(chunk),
    }));
  }

  // No usable text layer (likely scanned). Small enough → send binary so Gemini
  // OCRs it; otherwise fall through to per-page image rendering below.
  if (originalBytes.byteLength <= MAX_PARSE_UPLOAD_BYTES) {
    return [
      {
        displayName: file.name,
        filename: file.name,
        mimeType,
        dataUrl: bytesToDataUrl(originalBytes, mimeType),
      },
    ];
  }

  let sourcePdf: import("pdf-lib").PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(originalBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    const text = await extractPdfText(file);
    if (!text) throw new Error(`"${file.name}" PDF файлыг жижиглэж уншиж чадсангүй.`);
    return chunkText(text).map((chunk, index, chunks) => ({
      displayName: `${file.name} (${index + 1}/${chunks.length})`,
      filename: `${file.name}.text-${String(index + 1).padStart(3, "0")}.txt`,
      mimeType: "text/plain",
      dataUrl: textToDataUrl(chunk),
    }));
  }

  const units: ParseUploadUnit[] = [];
  let currentPages: number[] = [];

  const flushCurrent = async () => {
    if (currentPages.length === 0) return;
    const chunkBytes = await createPdfChunkBytes(sourcePdf, currentPages);
    if (chunkBytes.byteLength > MAX_PARSE_UPLOAD_BYTES) {
      for (const pageIndex of currentPages) {
        units.push(
          await renderPdfPageAsImageUnit(
            originalBytes,
            file.name,
            pageIndex,
            units.length + 1,
          ),
        );
      }
      currentPages = [];
      return;
    }
    units.push({
      displayName: `${file.name} (${units.length + 1})`,
      filename: `${file.name}.part-${String(units.length + 1).padStart(3, "0")}.pdf`,
      mimeType,
      dataUrl: bytesToDataUrl(chunkBytes, mimeType),
    });
    currentPages = [];
  };

  for (let pageIndex = 0; pageIndex < sourcePdf.getPageCount(); pageIndex += 1) {
    const candidatePages = [...currentPages, pageIndex];
    const candidateBytes = await createPdfChunkBytes(sourcePdf, candidatePages);
    if (
      candidateBytes.byteLength > MAX_PARSE_UPLOAD_BYTES &&
      currentPages.length > 0
    ) {
      await flushCurrent();
      currentPages = [pageIndex];
      const singlePageBytes = await createPdfChunkBytes(sourcePdf, currentPages);
      if (singlePageBytes.byteLength > MAX_PARSE_UPLOAD_BYTES) {
        await flushCurrent();
      }
      continue;
    }
    if (candidateBytes.byteLength > MAX_PARSE_UPLOAD_BYTES) {
      units.push(
        await renderPdfPageAsImageUnit(
          originalBytes,
          file.name,
          pageIndex,
          units.length + 1,
        ),
      );
      currentPages = [];
      continue;
    }
    currentPages = candidatePages;
  }

  await flushCurrent();
  return units;
}

async function buildTextUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const text = (await file.text()).trim();
  if (!text) throw new Error(`"${file.name}" текст файл хоосон байна.`);
  return chunkText(text).map((chunk, index, chunks) => ({
    displayName: `${file.name} (${index + 1}/${chunks.length})`,
    filename: `${file.name}.text-${String(index + 1).padStart(3, "0")}.txt`,
    mimeType: "text/plain",
    dataUrl: textToDataUrl(chunk),
  }));
}

/** Inflates a single entry from a ZIP (DOCX/XLSX) in the browser. */
async function readZipEntryInBrowser(
  buffer: ArrayBuffer,
  entryName: string,
): Promise<string | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const targetBytes = new TextEncoder().encode(entryName);
  const matches = (start: number) => {
    for (let i = 0; i < targetBytes.length; i += 1) {
      if (bytes[start + i] !== targetBytes[i]) return false;
    }
    return true;
  };

  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (compressedSize === 0) break;

    if (nameLength === targetBytes.length && matches(nameStart)) {
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) {
        const stream = new Response(
          new Blob([data]).stream().pipeThrough(
            new DecompressionStream("deflate-raw"),
          ),
        );
        return await stream.text();
      }
      return null;
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

/**
 * Extracts text from an Office document (Excel .xlsx/.xlsm/.xls, Word .docx)
 * in the browser, then chunks it like plain text. This keeps upload size tied
 * to the *content*, so a heavy Office file (embedded fonts/images) never trips
 * the per-request size wall — only its readable text is sent.
 */
async function buildOfficeUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const lower = file.name.trim().toLowerCase();
  const buffer = await file.arrayBuffer();
  let text = "";

  if (lower.endsWith(".docx")) {
    const xml = await readZipEntryInBrowser(buffer, "word/document.xml");
    if (!xml) {
      throw new Error(
        `"${file.name}" Word файлыг уншиж чадсангүй. PDF болгож хадгалаад дахин оруулна уу.`,
      );
    }
    text = xml
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\b[^>]*\/?>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) parts.push(`# ${sheetName}\n${csv}`);
    }
    text = parts.join("\n\n").trim();
  }

  if (!text) {
    throw new Error(`"${file.name}" файлд текст өгөгдөл олдсонгүй.`);
  }

  return chunkText(text).map((chunk, index, chunks) => ({
    displayName: `${file.name} (${index + 1}/${chunks.length})`,
    filename: `${file.name}.text-${String(index + 1).padStart(3, "0")}.txt`,
    mimeType: "text/plain",
    dataUrl: textToDataUrl(chunk),
  }));
}

async function buildImageUploadUnit(file: File): Promise<ParseUploadUnit> {
  if (file.size <= MAX_PARSE_UPLOAD_BYTES) {
    return {
      displayName: file.name,
      filename: file.name,
      mimeType: file.type || "image/jpeg",
      dataUrl: await fileToDataUrl(file),
    };
  }

  const bitmap = await createImageBitmap(file);
  try {
    let scale = 1;
    let quality = 0.82;
    let bestBytes: Uint8Array | null = null;

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Зургийг жижиглэж чадсангүй.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const bytes = await canvasToJpegBytes(canvas, quality);
      if (!bestBytes || bytes.byteLength < bestBytes.byteLength) {
        bestBytes = bytes;
      }
      if (bytes.byteLength <= MAX_PARSE_UPLOAD_BYTES) {
        return {
          displayName: file.name,
          filename: `${file.name}.compressed.jpg`,
          mimeType: "image/jpeg",
          dataUrl: bytesToDataUrl(bytes, "image/jpeg"),
        };
      }
      if (quality > 0.46) {
        quality -= 0.12;
      } else {
        scale *= 0.72;
        quality = 0.78;
      }
    }

    throw new Error(
      `"${file.name}" зургийг request limit-д багтааж жижиглэж чадсангүй (${formatBytes(bestBytes?.byteLength || 0)}).`,
    );
  } finally {
    bitmap.close();
  }
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `…${value.slice(-12)}`;
}

function timeLeft(expiresAt: string | null): string {
  if (!expiresAt) return "∞";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Дууссан";
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return minutes <= 0 ? `${seconds}с` : `${minutes}м ${seconds}с`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("mn-MN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function driveSyncTone(
  status: DriveSyncDiagnostics["state"]["status"] | undefined,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "success") return "success";
  if (status === "warning" || status === "running") return "warning";
  if (status === "error") return "danger";
  return "neutral";
}

function toStructuredRows(value: unknown): StructuredRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row: StructuredRow = {};
      for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
        row[key] = typeof val === "string" ? val : val == null ? "" : String(val);
      }
      return row;
    });
}

function settingsToForm(settings: TravelBotSettings): SettingsForm {
  return {
    business_name: settings.business_name || "",
    system_prompt: settings.system_prompt || "",
    quick_info_reply: settings.quick_info_reply || "",
    quick_info_keywords: (settings.quick_info_keywords || []).join("\n"),
    comment_trigger_patterns: (settings.comment_trigger_patterns || []).join("\n"),
    comment_public_reply: settings.comment_public_reply || "",
    comment_dm_reply: settings.comment_dm_reply || "",
    special_offers: toStructuredRows(settings.special_offers),
    discount_policies: toStructuredRows(settings.discount_policies),
    verified_credentials: toStructuredRows(settings.verified_credentials),
    faq: toStructuredRows(settings.faq),
    handoff_enabled: settings.handoff_enabled !== false,
    handoff_keywords: (settings.handoff_keywords || []).join("\n"),
    handoff_reply: settings.handoff_reply || "",
    handoff_pause_minutes: String(settings.handoff_pause_minutes ?? 60),
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function handoffDurationSelectValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "60";
  return HANDOFF_DURATION_OPTIONS.some((option) => option.value === trimmed)
    ? trimmed
    : HANDOFF_DURATION_CUSTOM;
}

function describeAction(action: AIAction): {
  verb: string;
  target: string;
  changes: string[];
} {
  const verbRaw = String(action.action || "").toLowerCase();
  const verb =
    verbRaw === "cancel"
      ? "Цуцлах"
      : verbRaw === "upsert"
        ? action.trip_id
          ? "Шинэчлэх"
          : "Шинэ аялал нэмэх"
        : verbRaw === "patch"
          ? "Шинэчлэх"
          : verbRaw || "Үйлдэл";
  const target =
    action.match?.route_name ||
    action.fields?.route_name?.toString() ||
    action.match?.operator_name ||
    action.trip_id ||
    "аялал";
  const fields = action.fields || {};
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    const label = FIELD_LABELS[key] || key;
    if (key === "has_food") {
      changes.push(`${label}: ${value ? "Байгаа" : "Байхгүй"}`);
    } else if (key === "status") {
      changes.push(
        `${label}: ${STATUS_LABELS[value as TripStatus] || String(value)}`,
      );
    } else if (key === "departure_dates" && Array.isArray(value)) {
      changes.push(`${label}: ${value.join(", ")}`);
    } else {
      changes.push(`${label}: ${String(value)}`);
    }
  }
  return { verb, target: String(target), changes };
}

function formatMoneyValue(
  amount: number | null | undefined,
  currency?: unknown,
): string {
  if (amount == null || !Number.isFinite(amount)) return "unknown";
  const code = typeof currency === "string" && currency.trim() ? currency.trim() : "";
  return `${amount.toLocaleString("en-US")}${code ? ` ${code}` : ""}`;
}

function extractQuotedValues(text: string): string[] {
  const matches = Array.from(text.matchAll(/['"]([^'"]+)['"]/g));
  const values = matches
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);
  return Array.from(new Set(values));
}

function normalizeReviewText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isAgencyReviewText(text: string): boolean {
  const normalized = normalizeReviewText(text).replace(/[.,:;!?()[\]{}"']/g, "");
  // Generic agency-header detection. Agency-specific names (from AGENCY_NAME) are
  // handled server-side during ingestion (travelOps.ts); this client-side check
  // only needs the generic headers.
  const agencyHeaders = ["travel agency", "agency"];
  return agencyHeaders.some(
    (header) => normalized === header || normalized.startsWith(`${header} `),
  );
}

function isLikelyTripRouteText(text: string): boolean {
  const normalized = normalizeReviewText(text);
  return (
    normalized.includes("аялал") ||
    normalized.includes("tour") ||
    normalized.includes("хөх хот") ||
    normalized.includes("эрээн") ||
    normalized.includes("бээжин") ||
    normalized.includes("сеoul") ||
    normalized.includes("seoul")
  );
}

function isSuspiciousChildPriceConflict(normalized: string): boolean {
  const mentionsChild =
    normalized.includes("хүүхдийн үнэ") || normalized.includes("child price");
  if (!mentionsChild) return false;
  return (
    normalized.includes("higher") ||
    normalized.includes("greater") ||
    normalized.includes("more than") ||
    normalized.includes("өндөр") ||
    normalized.includes("их") ||
    normalized.includes("давсан")
  );
}

function isOptionalAddOnCostConflict(normalized: string): boolean {
  const mentionsForeignCost =
    normalized.includes("cny") ||
    normalized.includes("yuan") ||
    normalized.includes("юань");
  if (!mentionsForeignCost) return false;
  return (
    normalized.includes("optional") ||
    normalized.includes("add-on") ||
    normalized.includes("addon") ||
    normalized.includes("extra") ||
    normalized.includes("нэмэлт төлбөр") ||
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("хөтөлбөрт багтаагүй") ||
    normalized.includes("ганцаараа орох") ||
    normalized.includes("single room")
  );
}

// Keep this list in sync with RECURRING_DEPARTURE_TOKENS in src/lib/travelOps.ts.
const RECURRING_DATE_TOKENS = [
  "өдөр бүр",
  "өдөр болгон",
  "өдөр тутам",
  "daily",
  "every day",
  "everyday",
  "гараг бүр",
  "долоо хоног бүр",
  "долоохоног бүр",
  "every week",
  "weekly",
  "пүрэв",
  "даваа",
  "мягмар",
  "лхагва",
  "баасан",
  "бямба",
  "ням",
  "thursday",
  "monday",
  "tuesday",
  "wednesday",
  "friday",
  "saturday",
  "sunday",
  "сар бүр",
  "monthly",
  "every month",
  "хоног тутам",
];

function isRecurringDateText(normalized: string): boolean {
  return RECURRING_DATE_TOKENS.some((token) => normalized.includes(token));
}

function isDocumentedMealExceptionConflict(normalized: string): boolean {
  const mentionsMeal =
    normalized.includes("хоол") ||
    normalized.includes("цай") ||
    normalized.includes("meal") ||
    normalized.includes("breakfast") ||
    normalized.includes("lunch") ||
    normalized.includes("dinner");
  if (!mentionsMeal) return false;
  return (
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("өөрсдийн зардлаар") ||
    normalized.includes("өөрөө") ||
    normalized.includes("чөлөөт өдөр") ||
    normalized.includes("байдаггүй") ||
    normalized.includes("байхгүй") ||
    normalized.includes("not included") ||
    normalized.includes("own expense") ||
    normalized.includes("free day")
  );
}

function summarizeConflict(detail: string): string {
  const normalized = normalizeReviewText(detail);
  const quoted = extractQuotedValues(detail);
  const subject = quoted[0] || "Энэ аялал";

  if (isAgencyReviewText(subject) || isAgencyReviewText(detail)) {
    return "";
  }
  if (isOptionalAddOnCostConflict(normalized)) {
    return "";
  }
  if (isDocumentedMealExceptionConflict(normalized)) {
    return "";
  }
  if (isRecurringDateText(normalized)) {
    return "";
  }
  if (isSuspiciousChildPriceConflict(normalized)) {
    return `${subject}: хүүхдийн болон том хүний үнэ зөрүүтэй байна.`;
  }
  if (normalized.includes("юань") || normalized.includes("cny") || normalized.includes("валют")) {
    return `${subject}: үндсэн үнэ MNT, шинжилгээний төлбөр CNY байна.`;
  }
  if (normalized.includes("хоол") || normalized.includes("meal")) {
    return `${subject}: хоол багтсан эсэх нь тодорхойгүй байна.`;
  }
  if (
    normalized.includes("batch failed") ||
    normalized.includes("503") ||
    normalized.includes("upstream")
  ) {
    return "Зарим файл түр уншигдаагүй байна.";
  }
  if (
    normalized.includes("6-р сард") ||
    normalized.includes("7-р сард") ||
      normalized.includes("8-р сард")
  ) {
    return `${subject}: сар бүрийн үнэ өөр байна.`;
  }
  if (
    normalized.includes("file") ||
    normalized.includes("файлын нэр") ||
    normalized.includes("operator") ||
    normalized.includes("оператор") ||
    normalized.includes("брэнд")
  ) {
    return "";
  }
  return "";
}

function buildProposalClarifications(
  proposal: AIProposal,
  answeredIds: string[] = [],
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const seen = new Set(answeredIds);
  const coveredConflictChecks: Array<(normalized: string) => boolean> = [];

  function pushQuestion(question: ClarificationQuestion | null) {
    if (!question) return;
    if (seen.has(question.id)) return;
    seen.add(question.id);
    questions.push(question);
  }

  proposal.actions.forEach((action, index) => {
    const fields = action.fields || {};
    const routeName =
      fields.route_name?.toString().trim() ||
      action.match?.route_name?.trim() ||
      `аялал ${index + 1}`;
    const adultPrice =
      typeof fields.adult_price === "number" ? fields.adult_price : null;
    const childPrice =
      typeof fields.child_price === "number" ? fields.child_price : null;
    const currency =
      typeof fields.currency === "string" ? fields.currency : undefined;
    if (adultPrice != null && childPrice != null && childPrice > adultPrice) {
      const routeKey = normalizeReviewText(routeName);
      coveredConflictChecks.push(
        (normalized) =>
          normalized.includes(routeKey) &&
          (normalized.includes("хүүхдийн үнэ") ||
            normalized.includes("child price") ||
            normalized.includes("том хүний үнэ")),
      );
      pushQuestion({
        id: `child-price:${routeName}`,
        prompt: `"${routeName}" аяллын хүүхдийн үнэ ${formatMoneyValue(childPrice, currency)} байгаа ч том хүний үнэ ${formatMoneyValue(adultPrice, currency)} байна. Ингэж үлдээх үү?`,
        options: [
          {
            label: "Тийм, ингэж үлдээх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}, том хүний үнийг ${adultPrice} гэж үлдээ.`,
          },
          {
            label: "Том хүний үнээр тэнцүүлэх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}-н оронд ${adultPrice} болгон өөрчил.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: `"${routeName}" аяллын зөв үнэ эсвэл зааварчилга бичнэ үү`,
      });
    }
  });

  proposal.conflicts.forEach((conflict, index) => {
    const detail = conflict.trim();
    if (!detail) return;
    const normalized = normalizeReviewText(detail);
    if (coveredConflictChecks.some((check) => check(normalized))) return;
    const quoted = extractQuotedValues(conflict);
    // The first quoted value is usually the trip/route the conflict is about.
    const subject = quoted[0] || "";
    const subjectTag = subject ? `"${subject}" аяллын ` : "";

    if (isAgencyReviewText(subject) || isAgencyReviewText(detail)) return;
    if (isOptionalAddOnCostConflict(normalized)) return;
    if (isDocumentedMealExceptionConflict(normalized)) return;
    if (isRecurringDateText(normalized)) return;
    if (
      normalized.includes("хүүхдийн үнэ") ||
      normalized.includes("child price")
    ) {
      if (!isSuspiciousChildPriceConflict(normalized)) return;
    }

    if (
      normalized.includes("file") ||
      normalized.includes("файлын нэр") ||
      normalized.includes("operator") ||
      normalized.includes("оператор") ||
      normalized.includes("брэнд")
    ) {
      const detected = quoted[0] || "файлын нэр";
      const operator = quoted[1] || "илэрсэн оператор";
      if (
        normalized.includes("file") ||
        normalized.includes("файлын нэр") ||
        isLikelyTripRouteText(detected) ||
        isLikelyTripRouteText(operator) ||
        isAgencyReviewText(detected) ||
        isAgencyReviewText(operator)
      ) {
        return;
      }
      pushQuestion({
        id: `operator-mismatch:${index}`,
        prompt: "Брэнд/операторын нэр зөрчилтэй байна. Аль нэрийг хэрэглэх вэ?",
        detail,
        options: [
          {
            label: `"${operator}" хэрэглэх`,
            answer: `Операторыг "${operator}" гэж үлдээнэ үү. (Зөрчил: ${detail})`,
          },
          {
            label: `"${detected}" хэрэглэх`,
            answer: `Операторыг "${detected}" болгоно уу. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Зөв оператор эсвэл брэндийн нэрийг бичнэ үү",
      });
      return;
    }

    if (normalized.includes("хөтөлбөртэй") && normalized.includes("чөлөөт")) {
      pushQuestion({
        id: `plan-choice:${index}`,
        prompt: `${subjectTag}хөтөлбөртэй болон чөлөөт гэсэн хоёр тусдаа үнийн хувилбар байна. Яаж хадгалах вэ?`,
        detail,
        options: [
          {
            label: "Тусдаа хоёр аялал",
            answer: `${subjectTag}хөтөлбөртэй болон чөлөөт хувилбарыг тусдаа хоёр аялал болгон хадгал. (Зөрчил: ${detail})`,
          },
          {
            label: "Зөвхөн хөтөлбөртэй",
            answer: `${subjectTag}зөвхөн хөтөлбөртэй хувилбарыг үндсэн аялал болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Зөвхөн чөлөөт",
            answer: `${subjectTag}зөвхөн чөлөөт хувилбарыг үндсэн аялал болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: хоёр хувилбарыг тусдаа хадгал, эсвэл нэгийг сонго",
      });
      return;
    }

    if (
      normalized.includes("хоол") ||
      normalized.includes("meal") ||
      normalized.includes("day 7")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("хоол") || value.includes("meal")),
      );
      pushQuestion({
        id: `meal-conflict:${index}`,
        prompt: `${subjectTag}хоолны мэдээлэл зөрчилтэй байна. Хоол багтсан уу?`,
        options: [
          {
            label: "Тийм, багтсан",
            answer: `${subjectTag}хоолыг багтсан гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Үгүй, багтаагүй",
            answer: `${subjectTag}хоолыг багтаагүй гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хоолны зөв дүрмийг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("явах өдөр тодорхойгүй") ||
      normalized.includes("огноо") ||
      normalized.includes("departure date")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("огноо") || value.includes("departure date")),
      );
      pushQuestion({
        id: `date-conflict:${index}`,
        prompt: `${subjectTag}гарах өдрийг тодорхойлж чадсангүй. Юу хийх вэ?`,
        options: [
          {
            label: "Огноогүй үлдээх",
            answer: `${subjectTag}гарах өдөргүйгээр саналд хэвээр нь үлдээ. (Зөрчил: ${detail})`,
          },
          {
            label: "Энэ аяллыг хасах",
            answer: `${subjectTag}гарах өдөр нь тодорхойгүй тул санал болгохгүй. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрэглэх гарах өдрийг бичнэ үү (ж: 2026-06-15)",
      });
      return;
    }

    if (
      normalized.includes("юань") ||
      normalized.includes("cny") ||
      normalized.includes("валют")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("юань") || value.includes("cny") || value.includes("валют")),
      );
      pushQuestion({
        id: `currency-conflict:${index}`,
        prompt: `${subjectTag}үндсэн үнэ MNT, шинжилгээний нэмэлт төлбөр CNY байна. Яаж хадгалах вэ?`,
        options: [
          {
            label: "MNT + CNY тэмдэглэл",
            answer: `${subjectTag}үндсэн үнийг MNT-ээр хадгалж, шинжилгээний CNY төлбөрийг тэмдэглэл/source_description-д тодорхой бич.`,
          },
          {
            label: "Админаар засуулах",
            answer: `${subjectTag}үнийн бүтэц тодорхойгүй тул хадгалахаас өмнө админаас яг adult/child MNT болон CNY нэмэлт төлбөрийг асуу.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: том хүн 890000 MNT + 600 CNY, хүүхэд 700000 MNT + 300 CNY",
      });
      return;
    }

    if (
      normalized.includes("6-р сард") ||
      normalized.includes("7-р сард") ||
      normalized.includes("8-р сард") ||
      normalized.includes("сард") && normalized.includes("үнэ")
    ) {
      pushQuestion({
        id: `seasonal-price:${index}`,
        prompt: `${subjectTag}сараас хамаараад өөр үнэтэй байна. Үүнийг яаж хадгалах вэ?`,
        options: [
          {
            label: "Сарын ялгааг үлдээх",
            answer: `${subjectTag}сарын ялгаатай үнийг тусад нь тайлбар/тэмдэглэлд хадгалж, буруу тэгшлэхгүй.`,
          },
          {
            label: "Нэг үнэ болгох",
            answer: `${subjectTag}нэг үндсэн үнэ сонгож үлдээ. Сарын ялгаатай үнийг одоохондоо ашиглахгүй.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Сар бүрийн үнийг хэрхэн хадгалахыг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("хоёр маршрут") ||
      normalized.includes("two route") ||
      normalized.includes("ижил")
    ) {
      pushQuestion({
        id: `duplicate-route:${index}`,
        prompt: "Ижил маршруттай боловч мэдээлэл нь зөрүүтэй хоёр аялал илэрлээ. Юу хийх вэ?",
        options: [
          {
            label: "Тусдаа үлдээх",
            answer: `Эдгээрийг тусдаа аялал болгон үлдээ. (Зөрчил: ${detail})`,
          },
          {
            label: "Нэг болгон нэгтгэх",
            answer: `Эдгээрийг нэг аялал болгон нэгтгэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("batch failed") ||
      normalized.includes("upstream") ||
      normalized.includes("503")
    ) {
      return;
    }

    if (
      normalized.includes("нэмэлт шалгалт") ||
      normalized.includes("additional check") ||
      normalized.includes("review needed") ||
      normalized.includes("баталгаажуул")
    ) {
      return;
    }

    // Any concrete conflict that doesn't match a known category still gets surfaced
    // with the original detail, so the admin is not asked a blind question.
    pushQuestion({
      id: `conflict:${index}`,
      prompt: `Дараах зөрчлийг хэрхэн зохицуулах вэ? ${detail}`,
      options: [
        {
          label: "Илэрсэнээр нь үлдээх",
          answer: `Дараах зөрчлийг илэрсэн хэвээр нь үлдээ: ${detail}`,
        },
        {
          label: "Болгоомжтой засах",
          answer: `Дараах зөрчлийг болгоомжтой хянаж засна уу: ${detail}`,
        },
      ],
      allowCustom: true,
      customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
    });
  });

  return questions.slice(0, 4);
}

/* ----------------------------------------------------------------
   Small presentational components
   ---------------------------------------------------------------- */
function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

function StructuredEditor({
  title,
  addLabel,
  fields,
  rows,
  onChange,
}: {
  title: string;
  addLabel: string;
  fields: Array<{ key: string; label: string }>;
  rows: StructuredRow[];
  onChange: (rows: StructuredRow[]) => void;
}) {
  function update(index: number, key: string, value: string) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    const blank: StructuredRow = {};
    for (const field of fields) blank[field.key] = "";
    onChange([...rows, blank]);
  }
  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <Button size="sm" variant="secondary" onClick={add}>
          <Icons.plus size={15} />
          {addLabel}
        </Button>
      </div>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-ink-subtle">Хоосон байна.</p>
        )}
        {rows.map((row, index) => (
          <div
            key={index}
            className="rounded-md border border-line bg-surface p-2.5"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-xs font-medium text-ink-muted">
                    {field.label}
                  </span>
                  <input
                    className="mt-1 h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink focus:border-brand"
                    value={row[field.key] || ""}
                    onChange={(e) => update(index, field.key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(index)}
                className="text-danger"
              >
                <Icons.trash size={15} />
                Устгах
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Page
   ---------------------------------------------------------------- */
const BLANK_TRIP_DRAFT: Record<string, string> = {
  category: "",
  operator_name: "",
  route_name: "",
  duration_text: "",
  adult_price: "",
  child_price: "",
  currency: "MNT",
  seats_total: "",
  seats_left: "",
  departure_dates: "",
  status: "active",
  has_food: "unknown",
  notes: "",
  source_description: "",
};

export default function AdminPage() {
  const toast = useToast();

  const [secret, setSecret] = useState("");
  const [secretDraft, setSecretDraft] = useState("");
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [openAccess, setOpenAccess] = useState(false);
  const [dbInfo, setDbInfo] = useState<{
    configured: boolean;
    schemaReady: boolean;
    trips: number;
    lastUpdatedAt: string | null;
  } | null>(null);
  const [driveSync, setDriveSync] = useState<DriveSyncDiagnostics | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);

  const [tab, setTab] = useState<TabKey>("assistant");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [tick, setTick] = useState(0);

  const [trips, setTrips] = useState<TravelTrip[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [control, setControl] = useState<ControlState | null>(null);
  const [pausedRows, setPausedRows] = useState<PauseRow[]>([]);
  const [recentRows, setRecentRows] = useState<RecentRow[]>([]);
  const [pauseReason, setPauseReason] = useState("");

  const [settings, setSettings] = useState<TravelBotSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      kind: "note",
      tone: "info",
      text:
        "Сайн байна уу! Аяллын мэдээллээ энд шуурхай өөрчилнө. Бичгээр зааварчилж болно (ж: «Бангкок аяллыг цуцал»), эсвэл прайс жагсаалт (Excel, PDF, зураг) хавсаргаарай. Би уншаад өөрчлөлтийг санал болгоно — та зөвшөөрвөл шууд хадгална.",
    },
  ]);
  const [aiInput, setAiInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [aiBusyLabel, setAiBusyLabel] = useState("");

  const [editingTrip, setEditingTrip] = useState<TravelTrip | null>(null);
  const [isNewTrip, setIsNewTrip] = useState(false);
  const [tripDraft, setTripDraft] = useState<Record<string, string>>(
    BLANK_TRIP_DRAFT,
  );
  const [deletingTrip, setDeletingTrip] = useState<TravelTrip | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [leads, setLeads] = useState<TravelLead[]>([]);
  const [newLeadCount, setNewLeadCount] = useState(0);
  const [leadStats, setLeadStats] = useState<LeadStats | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const secretRef = useRef(secret);
  const searchRef = useRef(search);
  const statusFilterRef = useRef(statusFilter);

  useEffect(() => {
    secretRef.current = secret;
  }, [secret]);

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);

  const fetchWithAdmin = useCallback(
    async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      if (secretRef.current.trim()) {
        headers.set("x-admin-secret", secretRef.current.trim());
      }
      return fetch(url, { ...init, headers });
    },
    [],
  );

  const readJsonSafe = useCallback(async (response: Response) => {
    const raw = await response.text();
    if (!raw) return {} as Record<string, unknown>;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { error: raw.slice(0, 300) } as Record<string, unknown>;
    }
  }, []);

  const loadTrips = useCallback(
    async (
      nextSearch = searchRef.current,
      nextStatusFilter = statusFilterRef.current,
      options: { showLoading?: boolean } = {},
    ) => {
      if (options.showLoading) setLoading(true);
      try {
        const tripRes = await fetchWithAdmin(
          `/api/admin/trips?search=${encodeURIComponent(
            nextSearch,
          )}&status=${encodeURIComponent(nextStatusFilter)}&limit=300`,
        );
        if (tripRes.status === 401) {
          setRequiresAuth(true);
          return;
        }

        const tripJson = await tripRes.json();
        setRequiresAuth(false);
        setTrips(Array.isArray(tripJson?.trips) ? tripJson.trips : []);
        setControl((tripJson?.control as ControlState) || null);
      } catch {
        toast.error("Аяллын мэдээлэл ачаалж чадсангүй.");
      } finally {
        if (options.showLoading) setLoading(false);
      }
    },
    [fetchWithAdmin, toast],
  );

  const loadPauseState = useCallback(async () => {
    try {
      const pauseRes = await fetchWithAdmin("/api/pause");
      if (pauseRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }

      const pauseJson = await pauseRes.json().catch(() => ({}));
      setRequiresAuth(false);
      setControl(pauseJson?.control || null);
      setPausedRows(Array.isArray(pauseJson?.paused) ? pauseJson.paused : []);
      setRecentRows(Array.isArray(pauseJson?.recent) ? pauseJson.recent : []);
      return true;
    } catch {
      toast.error("Ботын төлөв ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, toast]);

  const loadSettingsState = useCallback(async () => {
    try {
      const settingsRes = await fetchWithAdmin("/api/admin/settings");
      if (settingsRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }

      const settingsJson = await settingsRes.json().catch(() => ({}));
      setRequiresAuth(false);
      if (settingsJson?.settings) {
        setSettings(settingsJson.settings as TravelBotSettings);
        setSettingsForm((prev) =>
          prev ? prev : settingsToForm(settingsJson.settings as TravelBotSettings),
        );
      }
      return true;
    } catch {
      toast.error("Тохиргоо ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, toast]);

  const loadLeadsState = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading) setLoading(true);
    try {
      const leadsRes = await fetchWithAdmin("/api/admin/leads?stats=1");
      if (leadsRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }

      const leadsJson = await leadsRes.json().catch(() => ({}));
      setRequiresAuth(false);
      setLeads(Array.isArray(leadsJson?.leads) ? leadsJson.leads : []);
      setNewLeadCount(
        typeof leadsJson?.new_count === "number" ? leadsJson.new_count : 0,
      );
      setLeadStats(
        leadsJson?.stats && typeof leadsJson.stats === "object"
          ? (leadsJson.stats as LeadStats)
          : null,
      );
      return true;
    } catch {
      toast.error("Хүсэлтүүд ачаалж чадсангүй.");
      return false;
    } finally {
      if (options.showLoading) setLoading(false);
    }
  }, [fetchWithAdmin, toast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const systemRes = await fetchWithAdmin("/api/admin/system");
      if (systemRes.status === 401) {
        setRequiresAuth(true);
        setLoading(false);
        return;
      }
      const systemJson = await systemRes.json();
      const nextOpenAccess = Boolean(systemJson?.open_access);
      const authorized = Boolean(systemJson?.authorized);
      setOpenAccess(nextOpenAccess);
      if (!nextOpenAccess && !authorized) {
        setRequiresAuth(true);
        setDbInfo(null);
        setDriveSync(null);
        setReadiness(null);
        setLoading(false);
        return;
      }

      setRequiresAuth(false);
      setDbInfo(systemJson?.db || null);
      setDriveSync((systemJson?.drive_sync as DriveSyncDiagnostics) || null);
      setReadiness((systemJson?.readiness as ReadinessReport) || null);
      setLoading(false);

      await Promise.all([
        loadTrips(searchRef.current, statusFilterRef.current),
        loadPauseState(),
        loadSettingsState(),
        loadLeadsState(),
      ]);
    } catch {
      toast.error("Системийн өгөгдөл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [
    fetchWithAdmin,
    loadLeadsState,
    loadPauseState,
    loadSettingsState,
    loadTrips,
    toast,
  ]);

  const syncDriveNow = useCallback(async () => {
    setBusyKey("drive-sync");
    try {
      const res = await fetchWithAdmin("/api/admin/drive-sync", {
        method: "POST",
      });
      const json = (await readJsonSafe(res)) as {
        diagnostics?: DriveSyncDiagnostics;
        summary?: string;
      };
      if (json.diagnostics) setDriveSync(json.diagnostics);
      if (!res.ok) {
        throw new Error(json.summary || "Google Drive синк хийх үед алдаа гарлаа.");
      }
      toast.success(json.summary || "Google Drive синк дууслаа.");
      await loadAll();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Google Drive синк хийх үед алдаа гарлаа.",
      );
    } finally {
      setBusyKey("");
    }
  }, [fetchWithAdmin, loadAll, readJsonSafe, toast]);

  useEffect(() => {
    const storage = getSecretStorage();
    if (!storage) return;
    const stored = storage.getItem(SECRET_KEY) || "";
    const ts = Number(storage.getItem(SECRET_TS_KEY) || "0");
    if (stored && Date.now() - ts < SESSION_TTL_MS) {
      secretRef.current = stored;
      // Restoring a persisted session on mount; safe one-shot setState.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSecret(stored);
      setSecretDraft(stored);
      // Slide the session forward on each use so an active admin stays logged
      // in; only a full week of inactivity logs them out.
      storage.setItem(SECRET_TS_KEY, String(Date.now()));
    } else if (stored) {
      storage.removeItem(SECRET_KEY);
      storage.removeItem(SECRET_TS_KEY);
    }
  }, []);

  useEffect(() => {
    // Initial data fetch on mount; loadAll sets state asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (requiresAuth || (!openAccess && !secret.trim())) return;
    const timer = window.setTimeout(() => {
      void loadTrips(search, statusFilter, { showLoading: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loadTrips, openAccess, requiresAuth, search, secret, statusFilter]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (ADMIN_AUTO_REFRESH_MS <= 0) return;
    const refresh = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (typeof document !== "undefined" && isEditableElement(document.activeElement)) {
        return;
      }
      if (
        isNewTrip ||
        editingTrip != null ||
        deletingTrip ||
        confirmClear ||
        busyKey ||
        aiInput.trim() ||
        attachedFiles.length > 0 ||
        dragOver
      ) {
        return;
      }
      void loadAll();
    }, ADMIN_AUTO_REFRESH_MS);
    return () => clearInterval(refresh);
  }, [
    aiInput,
    attachedFiles.length,
    busyKey,
    confirmClear,
    deletingTrip,
    dragOver,
    editingTrip,
    isNewTrip,
    loadAll,
  ]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const pausedIds = useMemo(
    () => new Set(pausedRows.map((row) => row.sender_id)),
    [pausedRows],
  );
  const handoffRows = useMemo(
    () => pausedRows.filter((row) => row.reason === "handoff"),
    [pausedRows],
  );

  /* ---------------- auth ---------------- */
  async function applySecret() {
    const nextSecret = secretDraft.trim();
    if (!nextSecret) return;
    const storage = getSecretStorage();
    if (storage) {
      storage.setItem(SECRET_KEY, nextSecret);
      storage.setItem(SECRET_TS_KEY, String(Date.now()));
    }
    secretRef.current = nextSecret;
    setSecret(nextSecret);
    await loadAll();
  }

  /* ---------------- AI assistant ---------------- */
  function pushMessage(message: ChatMessage) {
    setChatMessages((prev) => [...prev, message]);
  }

  async function readAttachedFile(file: File): Promise<AttachedFile> {
    return {
      id: `${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      mimeType: file.type || "",
      sizeBytes: file.size,
      file,
    };
  }

  async function attachFiles(files: FileList | File[]) {
    const inputFiles = Array.from(files);
    if (inputFiles.length === 0) return;

    // No size/count/total limits — accept every file as-is. Large files are
    // auto-split into AI-sized chunks at parse time (buildPdfUploadUnits /
    // buildTextUploadUnits), so size is handled there, not by rejecting here.
    const limitedFiles = inputFiles;

    try {
      const nextFiles = await Promise.all(
        limitedFiles.map((file) => readAttachedFile(file)),
      );
      setAttachedFiles((prev) => {
        const existing = new Set(prev.map((file) => file.id));
        const deduped = nextFiles.filter((file) => !existing.has(file.id));
        return [...prev, ...deduped];
      });
    } catch {
      toast.error("Нэг буюу хэд хэдэн файлыг уншиж чадсангүй.");
    }
  }

  function mergeAIProposals(
    proposals: AIProposal[],
    fileNames: string[],
  ): AIProposal {
    const actionKeys = new Set<string>();
    const actions: AIAction[] = [];
    const conflicts = new Set<string>();
    const importantReasons = new Set<string>();
    const summaries = new Set<string>();

    for (const proposal of proposals) {
      for (const action of proposal.actions || []) {
        const key = JSON.stringify(action);
        if (actionKeys.has(key)) continue;
        actionKeys.add(key);
        actions.push(action);
      }
      for (const conflict of proposal.conflicts || []) {
        if (conflict.trim()) conflicts.add(conflict.trim());
      }
      if (proposal.important_reason?.trim()) {
        importantReasons.add(proposal.important_reason.trim());
      }
      if (proposal.summary?.trim()) {
        summaries.add(proposal.summary.trim());
      }
    }

    return {
      summary:
        actions.length > 0
          ? `${fileNames.length} файл уншиж ${actions.length} өөрчлөлтийн санал оллоо.`
          : Array.from(summaries)[0] || "Файлуудаас хэрэгжүүлэх өөрчлөлт олдсонгүй.",
      needs_confirmation:
        proposals.some((proposal) => proposal.needs_confirmation) ||
        conflicts.size > 0,
      important_reason: Array.from(importantReasons).join(" "),
      conflicts: Array.from(conflicts),
      actions,
    };
  }

  async function parseUploadUnitWithRetry(
    unit: ParseUploadUnit,
    note: string,
    progressLabel: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null }> {
    // Rate limits / transient AI hiccups never surface as an error: we wait and
    // resume automatically, with a friendly countdown, for as long as it takes.
    // Only a genuine, unrecoverable problem (e.g. the chunk truly cannot be
    // built) ends the loop, and even then we return an empty-but-valid result
    // for this chunk so one bad piece can't sink the whole upload.
    const MAX_HARD_FAILURES = 6; // consecutive non-rate-limit failures
    let hardFailures = 0;
    let waitAttempt = 0;

    while (true) {
      let res: Response;
      try {
        res = await fetchWithAdmin("/api/admin/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploads: [
              {
                filename: unit.filename,
                mimeType: unit.mimeType,
                dataBase64: unit.dataUrl,
              },
            ],
            note,
          }),
        });
      } catch {
        // Network blip — treat like a transient wait, don't error out.
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          return emptyChunkResult(unit.displayName);
        }
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }

      const json = (await readJsonSafe(res)) as AIProposalResponse;
      const rateLimited = res.status === 429;
      const transientOk =
        res.ok &&
        isTransientAiFailure(json.proposal) &&
        !json.proposal?.actions?.length;

      // Rate limited or transiently busy → wait and resume forever (no cap).
      if (rateLimited || transientOk) {
        const waitMs =
          typeof json.retry_after_ms === "number" && json.retry_after_ms > 0
            ? json.retry_after_ms
            : Math.min(60_000, 20_000 + waitAttempt * 10_000);
        await waitWithCountdown(progressLabel, waitMs, ++waitAttempt);
        continue;
      }

      if (!res.ok) {
        // 413 (chunk too big) is unrecoverable for this piece — skip it cleanly
        // rather than throwing and killing the whole multi-chunk upload.
        if (res.status === 413) {
          return emptyChunkResult(unit.displayName);
        }
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          return emptyChunkResult(unit.displayName);
        }
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }

      if (!json.proposal || !Array.isArray(json.proposal.actions)) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          return emptyChunkResult(unit.displayName);
        }
        await waitWithCountdown(progressLabel, 10_000, ++waitAttempt);
        continue;
      }

      return {
        proposal: json.proposal,
        requestId: typeof json.request_id === "number" ? json.request_id : null,
      };
    }
  }

  // Wait helper that shows a friendly, ticking countdown instead of an error.
  async function waitWithCountdown(
    progressLabel: string,
    totalMs: number,
    attempt: number,
  ) {
    const stepMs = 1_000;
    let remaining = Math.max(stepMs, Math.round(totalMs));
    while (remaining > 0) {
      const secs = Math.ceil(remaining / 1000);
      setAiBusyLabel(
        `${progressLabel} — AI түр завгүй байна, ${secs}с дараа үргэлжилнэ` +
          (attempt > 3 ? ` (оролдлого ${attempt})` : ""),
      );
      await delayMs(Math.min(stepMs, remaining));
      remaining -= stepMs;
    }
  }

  // A valid, empty result for a single chunk that genuinely couldn't be read,
  // so the rest of the upload still completes without a thrown error.
  function emptyChunkResult(displayName: string): {
    proposal: AIProposal;
    requestId: number | null;
  } {
    return {
      proposal: {
        summary: `"${displayName}" хэсгийг алгассан.`,
        needs_confirmation: false,
        important_reason: "",
        conflicts: [],
        actions: [],
      },
      requestId: null,
    };
  }

  // Drive-file equivalent of parseUploadUnitWithRetry: rate limits / transient
  // AI busy auto-wait & resume forever; a genuinely unreadable file is skipped
  // cleanly so one bad link can't sink a batch of Drive links.
  async function parseDriveFileWithRetry(
    fileId: string,
    note: string,
    progressLabel: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null }> {
    const MAX_HARD_FAILURES = 6;
    let hardFailures = 0;
    let waitAttempt = 0;
    const label = `Google Drive ${shortId(fileId)}`;

    while (true) {
      let res: Response;
      try {
        res = await fetchWithAdmin("/api/admin/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driveFileIds: [fileId], note }),
        });
      } catch {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label);
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }

      const json = (await readJsonSafe(res)) as AIProposalResponse;
      const rateLimited = res.status === 429;
      const transientOk =
        res.ok &&
        isTransientAiFailure(json.proposal) &&
        !json.proposal?.actions?.length;

      if (rateLimited || transientOk) {
        const waitMs =
          typeof json.retry_after_ms === "number" && json.retry_after_ms > 0
            ? json.retry_after_ms
            : Math.min(60_000, 20_000 + waitAttempt * 10_000);
        await waitWithCountdown(progressLabel, waitMs, ++waitAttempt);
        continue;
      }

      if (!res.ok) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label);
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }

      if (!json.proposal || !Array.isArray(json.proposal.actions)) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label);
        await waitWithCountdown(progressLabel, 10_000, ++waitAttempt);
        continue;
      }

      return {
        proposal: json.proposal,
        requestId: typeof json.request_id === "number" ? json.request_id : null,
      };
    }
  }

  async function parseAttachedFiles(
    files: AttachedFile[],
    note: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null }> {
    const proposals: AIProposal[] = [];
    let singleRequestId: number | null = null;
    const uploadUnits: ParseUploadUnit[] = [];
    const skippedFiles: string[] = [];

    for (const file of files) {
      // One unreadable file (corrupt PDF, weird binary) must never abort the
      // whole batch. We skip it with a gentle note and keep going.
      try {
        if (isPdfFile(file.file)) {
          uploadUnits.push(...(await buildPdfUploadUnits(file.file)));
        } else if (isOfficeDocFile(file.file)) {
          uploadUnits.push(...(await buildOfficeUploadUnits(file.file)));
        } else if (isTextLikeFile(file.file)) {
          uploadUnits.push(...(await buildTextUploadUnits(file.file)));
        } else if (isImageFile(file.file)) {
          uploadUnits.push(await buildImageUploadUnit(file.file));
        } else {
          if (file.file.size > MAX_PARSE_UPLOAD_BYTES) {
            // Unknown big binary we can't chunk — skip it cleanly.
            skippedFiles.push(file.name);
            continue;
          }
          uploadUnits.push({
            displayName: file.name,
            filename: file.name,
            mimeType: file.mimeType,
            dataUrl: await fileToDataUrl(file.file),
          });
        }
      } catch {
        skippedFiles.push(file.name);
      }
    }

    if (skippedFiles.length > 0) {
      toast.info(
        `${skippedFiles.length} файлыг уншиж чадсангүй тул алгаслаа: ${skippedFiles
          .slice(0, 3)
          .join(", ")}${skippedFiles.length > 3 ? "…" : ""}`,
      );
    }

    if (uploadUnits.length === 0) {
      return {
        proposal: {
          summary: "Уншигдах файл олдсонгүй.",
          needs_confirmation: false,
          important_reason: "",
          conflicts: [],
          actions: [],
        },
        requestId: null,
      };
    }

    for (let index = 0; index < uploadUnits.length; index += 1) {
      const unit = uploadUnits[index];
      const progressLabel = `${files.length} файл уншиж байна… ${index + 1}/${uploadUnits.length}`;
      setAiBusyLabel(progressLabel);
      const parsed = await parseUploadUnitWithRetry(unit, note, progressLabel);
      proposals.push(parsed.proposal);
      if (uploadUnits.length === 1) {
        singleRequestId = parsed.requestId;
      }
      if (index < uploadUnits.length - 1) {
        await delayMs(2_000);
      }
    }

    return {
      proposal:
        proposals.length === 1
          ? proposals[0]
          : mergeAIProposals(
              proposals,
              files.map((file) => file.name),
            ),
      requestId: singleRequestId,
    };
  }

  async function parseDriveFileIds(
    fileIds: string[],
    note: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null }> {
    // No cap on Drive links — each file is fetched and chunked one at a time.
    const proposals: AIProposal[] = [];
    let singleRequestId: number | null = null;

    for (let index = 0; index < fileIds.length; index += 1) {
      const fileId = fileIds[index];
      const progressLabel = `${fileIds.length} Google Drive файл уншиж байна… ${index + 1}/${fileIds.length}`;
      setAiBusyLabel(progressLabel);
      // Same auto-wait & resume behaviour as file uploads: rate limits / busy
      // AI never surface as an error; only an unrecoverable problem skips this
      // one Drive file (cleanly) so the rest still process.
      const parsed = await parseDriveFileWithRetry(fileId, note, progressLabel);
      proposals.push(parsed.proposal);
      if (fileIds.length === 1) {
        singleRequestId = parsed.requestId;
      }
    }

    return {
      proposal:
        proposals.length === 1
          ? proposals[0]
          : mergeAIProposals(
              proposals,
              fileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
            ),
      requestId: singleRequestId,
    };
  }

  function removeAttachedFile(fileId: string) {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== fileId));
  }

  async function sendAssistant() {
    const text = aiInput.trim();
    const files = attachedFiles;
    const driveFileIds = extractGoogleDriveFileIds(text);
    if (!text && files.length === 0 && driveFileIds.length === 0) return;
    if (busyKey === "ai-send") return;

    if (text.length > MAX_AI_INPUT_CHARS) {
      toast.error(
        `AI заавар хэт урт байна. ${MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`,
      );
      return;
    }
    const sourceNames = [
      ...files.map((file) => file.name),
      ...driveFileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
    ];
    pushMessage({
      id: uid(),
      role: "admin",
      text: text || "Файл орууллаа",
      fileNames: sourceNames,
    });
    setAiInput("");
    setAttachedFiles([]);
    setBusyKey("ai-send");
    setAiBusyLabel(
      files.length > 0 || driveFileIds.length > 0
        ? `${Math.max(1, sourceNames.length)} файл уншиж байна… (хэдэн секунд)`
        : "AI хариу бэлдэж байна…",
    );

    try {
      let proposal: AIProposal | undefined;
      let requestId: number | null = null;
      if (files.length > 0 || driveFileIds.length > 0) {
        const parsedProposals: AIProposal[] = [];
        const parsedSourceNames: string[] = [];
        if (files.length > 0) {
          const parsed = await parseAttachedFiles(files, text);
          parsedProposals.push(parsed.proposal);
          parsedSourceNames.push(...files.map((file) => file.name));
          requestId = parsed.requestId;
        }
        if (driveFileIds.length > 0) {
          const parsedDrive = await parseDriveFileIds(driveFileIds, text);
          parsedProposals.push(parsedDrive.proposal);
          parsedSourceNames.push(
            ...driveFileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
          );
          requestId = files.length === 0 ? parsedDrive.requestId : null;
        }
        proposal =
          parsedProposals.length === 1
            ? parsedProposals[0]
            : mergeAIProposals(parsedProposals, parsedSourceNames);
      } else {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: text }),
        });
        const json = await readJsonSafe(res);
        const data = json as AIProposalResponse;
        if (!res.ok) {
          throw new Error(apiErrorMessage(data, "AI санал үүсгэж чадсангүй."));
        }
        proposal = data.proposal;
        requestId = typeof data.request_id === "number" ? data.request_id : null;
      }

      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error(
          "AI хэрэгжих санал буцааж чадсангүй. Илүү тодорхой зааварчилгаар дахин оролдоно уу.",
        );
      }
      if (proposal.actions.length === 0) {
        pushMessage({
          id: uid(),
          role: "assistant",
          kind: "note",
          tone: "info",
          text:
            proposal.summary ||
            "Өөрчлөх зүйл олдсонгүй. Илүү дэлгэрэнгүй зааварчилга эсвэл өөр файл оруулна уу.",
        });
        return;
      }
      const fileInstruction =
        sourceNames.length > 0
          ? text
            ? `[File] ${sourceNames.join(", ")} - ${text}`
            : `[File] ${sourceNames.join(", ")}`
          : text;
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "proposal",
        proposal,
        requestId,
        instruction: fileInstruction,
        status: "pending",
        confirmChecked: false,
        clarifications: buildProposalClarifications(proposal),
        clarificationAnswers: [],
        answeredClarificationIds: [],
        customReply: "",
      });
    } catch (err) {
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "note",
        tone: "error",
        text:
          err instanceof TypeError
            ? "Сервер хариу өгөхөөс өмнө байршуулалт амжилтгүй болсон. Сүлжээ, браузер эсвэл платформын бодит request limit-д хүрсэн байж магадгүй."
            : err instanceof Error
              ? err.message
              : "Алдаа гарлаа.",
      });
    } finally {
      setBusyKey("");
    }
  }
  function setProposalMessage(id: string, patch: Partial<ProposalMsg>) {
    setChatMessages((prev) =>
      prev.map((message) =>
        message.id === id && "kind" in message && message.kind === "proposal"
          ? { ...message, ...patch }
          : message,
      ),
    );
  }

  async function answerClarification(
    message: ProposalMsg,
    question: ClarificationQuestion,
    answer: string,
  ) {
    const trimmed = answer.trim();
    if (!trimmed) return;

    setBusyKey(`clarify-${message.id}`);
    try {
      let proposal: AIProposal | undefined;
      let newRequestId: number | null = message.requestId;

      if (message.requestId != null) {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: message.requestId,
            clarification: trimmed,
          }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
      } else {
        // No DB record — regenerate with combined instruction + clarification.
        const combined = [
          message.instruction,
          ...message.clarificationAnswers.map(
            (qa) => `${qa.prompt}: ${qa.answer}`,
          ),
          `${question.prompt}: ${trimmed}`,
        ]
          .filter(Boolean)
          .join("\n");
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: combined }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
        if (typeof json?.request_id === "number") {
          newRequestId = json.request_id as number;
        }
      }

      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error("AI засварласан санал буцааж чадсангүй.");
      }

      const nextAnsweredIds = [
        ...message.answeredClarificationIds,
        question.id,
      ];
      setProposalMessage(message.id, {
        proposal,
        requestId: newRequestId,
        clarifications: buildProposalClarifications(proposal, nextAnsweredIds),
        clarificationAnswers: [
          ...message.clarificationAnswers,
          {
            questionId: question.id,
            prompt: question.prompt,
            answer: trimmed,
          },
        ],
        answeredClarificationIds: nextAnsweredIds,
        customReply: "",
        confirmChecked: false,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Саналыг засаж чадсангүй.",
      );
    } finally {
      setBusyKey("");
    }
  }

  async function applyProposal(message: ProposalMsg) {
    setBusyKey(`apply-${message.id}`);
    try {
      const body =
        message.requestId != null
          ? { request_id: message.requestId, apply: true, confirm: true }
          : {
              apply: true,
              confirm: true,
              proposal_direct: message.proposal,
              instruction: message.instruction,
            };
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || json?.error || "Хэрэгжүүлж чадсангүй.");
      }
      setProposalMessage(message.id, {
        status: "applied",
        requestId:
          typeof json?.request_id === "number"
            ? (json.request_id as number)
            : message.requestId,
        resultText: Array.isArray(json?.results)
          ? json.results.join(" • ")
          : json?.message || "Амжилттай.",
      });
      toast.success("Өөрчлөлт хадгалагдлаа. Бот шинэ мэдээллээр хариулна.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Алдаа гарлаа.",
      });
      toast.error("Хэрэгжүүлэхэд алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }

  async function rollbackProposal(message: ProposalMsg) {
    if (message.requestId == null) {
      toast.error("Буцаах хадгалсан хүсэлтийн дугаар олдсонгүй.");
      return;
    }
    if (
      !window.confirm(
        "Сүүлд хадгалсан AI өөрчлөлтийг буцаах уу? Энэ үйлдэл тухайн өөрчлөлтийн өмнөх аяллын мэдээллийг сэргээнэ.",
      )
    ) {
      return;
    }

    setBusyKey(`rollback-${message.id}`);
    try {
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: message.requestId,
          rollback: true,
          confirm: true,
        }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(
          String(json?.message || json?.error || "Буцааж чадсангүй."),
        );
      }
      setProposalMessage(message.id, {
        status: "reverted",
        resultText: Array.isArray(json?.results)
          ? json.results.join(" • ")
          : String(json?.message || "Буцаагдлаа."),
      });
      toast.success("AI өөрчлөлтийг буцаалаа.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Буцаахад алдаа гарлаа.",
      });
      toast.error("Буцаахад алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }

  async function submitClarificationForm(
    message: ProposalMsg,
    answers: Record<string, string>,
  ) {
    // Build a combined clarification string from all answered questions.
    // Include each question's conflict detail so the AI knows exactly which
    // trip/conflict the admin's answer applies to.
    const combined = message.clarifications
      .map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        if (!answer) return "";
        const context = q.detail ? ` [Зөрчил: ${q.detail}]` : "";
        return `${q.prompt}${context} → ${answer}`;
      })
      .filter(Boolean)
      .join("\n");
    if (!combined.trim()) return;

    // Re-use answerClarification with the first question as the anchor.
    // The combined text carries all answers so the AI sees the full picture.
    const firstQ = message.clarifications[0];
    if (firstQ) {
      await answerClarification(message, firstQ, combined);
    }
  }

  /* ---------------- bot control ---------------- */
  async function runPauseAction(
    action: "pause" | "resume" | "global_pause" | "global_resume",
    senderId?: string,
    durationMs?: number | null,
  ) {
    setBusyKey(`${action}:${senderId || "global"}`);
    try {
      const body: Record<string, unknown> = { action };
      if (senderId) body.sender_id = senderId;
      if (durationMs != null) body.duration_ms = durationMs;
      if (action === "global_pause") body.reason = pauseReason || null;
      const res = await fetchWithAdmin("/api/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || "Үйлдэл амжилтгүй.");
      }
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Үйлдэл амжилтгүй.");
    } finally {
      setBusyKey("");
    }
  }

  /* ---------------- trips ---------------- */
  function beginCreateTrip() {
    setIsNewTrip(true);
    setEditingTrip(null);
    setTripDraft({ ...BLANK_TRIP_DRAFT });
  }

  function beginEditTrip(trip: TravelTrip) {
    setIsNewTrip(false);
    setEditingTrip(trip);
    setTripDraft({
      category: trip.category || "",
      operator_name: trip.operator_name || "",
      route_name: trip.route_name || "",
      duration_text: trip.duration_text || "",
      adult_price: trip.adult_price == null ? "" : String(trip.adult_price),
      child_price: trip.child_price == null ? "" : String(trip.child_price),
      currency: trip.currency || "MNT",
      seats_total: trip.seats_total == null ? "" : String(trip.seats_total),
      seats_left: trip.seats_left == null ? "" : String(trip.seats_left),
      departure_dates: (trip.departure_dates || []).join(", "),
      status: trip.status || "active",
      has_food:
        trip.has_food == null ? "unknown" : trip.has_food ? "true" : "false",
      notes: trip.notes || "",
      source_description: trip.source_description || "",
    });
  }

  const tripModalOpen = isNewTrip || editingTrip != null;

  function closeTripModal() {
    setEditingTrip(null);
    setIsNewTrip(false);
  }

  async function saveTrip() {
    const fields = {
      category: tripDraft.category || "",
      operator_name: tripDraft.operator_name || "",
      route_name: tripDraft.route_name || "",
      duration_text: tripDraft.duration_text || "",
      adult_price: asInt(tripDraft.adult_price || ""),
      child_price: asInt(tripDraft.child_price || ""),
      currency: tripDraft.currency || "MNT",
      seats_total: asInt(tripDraft.seats_total || ""),
      seats_left: asInt(tripDraft.seats_left || ""),
      status: tripDraft.status || "active",
      has_food:
        tripDraft.has_food === "unknown"
          ? null
          : tripDraft.has_food === "true",
      notes: tripDraft.notes || "",
      departure_dates: (tripDraft.departure_dates || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      source_description: tripDraft.source_description || "",
    };
    if (!fields.route_name.trim() && !fields.operator_name.trim()) {
      toast.error("Маршрут эсвэл операторын нэр оруулна уу.");
      return;
    }
    if (isNewTrip) {
      const duplicate = trips.find(
        (t) =>
          t.operator_name.trim().toLowerCase() ===
            fields.operator_name.trim().toLowerCase() &&
          t.route_name.trim().toLowerCase() ===
            fields.route_name.trim().toLowerCase(),
      );
      if (duplicate) {
        toast.error(
          `"${fields.operator_name} — ${fields.route_name}" нэртэй аялал аль хэдийн байна. Засах товч дарж шинэчилнэ үү.`,
        );
        return;
      }
    }
    setBusyKey("save-trip");
    try {
      const res = await fetchWithAdmin("/api/admin/trips", {
        method: isNewTrip ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isNewTrip ? { fields } : { id: editingTrip?.id, fields },
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Хадгалж чадсангүй.");
      toast.success(isNewTrip ? "Шинэ аялал нэмэгдлээ." : "Аялал шинэчлэгдлээ.");
      closeTripModal();
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  async function confirmDeleteTrip() {
    if (!deletingTrip) return;
    setBusyKey(`delete-trip-${deletingTrip.id}`);
    const trip = deletingTrip;
    setDeletingTrip(null);
    try {
      const res = await fetchWithAdmin(
        `/api/admin/trips?id=${encodeURIComponent(trip.id)}`,
        { method: "DELETE" },
      );
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(String(json?.error || "Устгаж чадсангүй."));
      toast.success(`"${trip.route_name || trip.operator_name}" устгагдлаа.`);
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Устгаж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  async function markLeadSeen(lead: TravelLead) {
    // Optimistic update so the badge/list react instantly.
    setLeads((prev) =>
      prev.map((item) =>
        item.id === lead.id ? { ...item, status: "seen" } : item,
      ),
    );
    setNewLeadCount((count) => Math.max(0, count - 1));
    try {
      const res = await fetchWithAdmin("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      toast.error("Тэмдэглэж чадсангүй. Дахин оролдоно уу.");
      await loadLeadsState({ showLoading: true });
    }
  }

  /* ---------------- settings ---------------- */
  async function saveSettings() {
    if (!settingsForm) return;
    setBusyKey("save-settings");
    try {
      const fields = {
        business_name: settingsForm.business_name.trim(),
        system_prompt: settingsForm.system_prompt.trim(),
        quick_info_reply: settingsForm.quick_info_reply.trim(),
        quick_info_keywords: splitLines(settingsForm.quick_info_keywords),
        comment_trigger_patterns: splitLines(
          settingsForm.comment_trigger_patterns,
        ),
        comment_public_reply: settingsForm.comment_public_reply.trim(),
        comment_dm_reply: settingsForm.comment_dm_reply.trim(),
        special_offers: settingsForm.special_offers,
        discount_policies: settingsForm.discount_policies,
        verified_credentials: settingsForm.verified_credentials,
        faq: settingsForm.faq,
        handoff_enabled: settingsForm.handoff_enabled,
        handoff_keywords: splitLines(settingsForm.handoff_keywords),
        handoff_reply: settingsForm.handoff_reply.trim(),
        handoff_pause_minutes: asInt(settingsForm.handoff_pause_minutes) ?? 60,
      };
      const res = await fetchWithAdmin("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Тохиргоо хадгалж чадсангүй.");
      if (json?.settings) {
        setSettings(json.settings as TravelBotSettings);
        setSettingsForm(settingsToForm(json.settings as TravelBotSettings));
      }
      toast.success("Тохиргоо хадгалагдлаа.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  /* ---------------- render ---------------- */
  const botPaused = Boolean(control?.bot_paused);

  if (requiresAuth || (!openAccess && !secret.trim())) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
        <Head>
          <title>Админ — нэвтрэх</title>
        </Head>
        <Card className="w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold text-ink">Админ удирдлага</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Үргэлжлүүлэхийн тулд админ нууц үгээ оруулна уу.
          </p>
          <div className="mt-4 space-y-3">
            <Input
              type="password"
              placeholder="Админ нууц үг"
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void applySecret();
              }}
            />
            <Button block onClick={() => void applySecret()}>
              Нэвтрэх
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const tabs: Array<{
    key: TabKey;
    label: string;
    icon: ReactNode;
    badge?: number;
  }> = [
    { key: "assistant", label: "AI Туслах", icon: <Icons.ai size={17} /> },
    { key: "trips", label: "Аяллууд", icon: <Icons.trips size={17} /> },
    { key: "bot", label: "Бот удирдлага", icon: <Icons.control size={17} /> },
    {
      key: "leads",
      label: "Хүсэлтүүд",
      icon: <Icons.alert size={17} />,
      badge: newLeadCount,
    },
    { key: "settings", label: "Тохиргоо", icon: <Icons.settings size={17} /> },
  ];

  return (
    <div className="min-h-dvh bg-canvas pb-16">
      <Head>
        <title>Аяллын удирдлагын самбар</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-ink">
                Аяллын удирдлага
              </h1>
              <p className="truncate text-xs text-ink-subtle">
                {settings?.business_name || "Аяллын чатбот"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {handoffRows.length > 0 && (
                <button type="button" onClick={() => setTab("bot")}>
                  <Badge tone="warning" dot>
                    🙋 {handoffRows.length}
                  </Badge>
                </button>
              )}
              <Badge tone={botPaused ? "danger" : "success"} dot>
                {botPaused ? "Зогссон" : "Идэвхтэй"}
              </Badge>
              <Badge tone={dbInfo?.configured ? "neutral" : "danger"}>
                {dbInfo?.trips ?? trips.length} аялал
              </Badge>
            </div>
          </div>

          {/* Tabs */}
          <nav className="scroll-area -mx-1 mt-3 flex gap-1 overflow-x-auto">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cx(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  tab === item.key
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-surface-sunken",
                )}
              >
                {item.icon}
                {item.label}
                {item.badge != null && item.badge > 0 && (
                  <span
                    className={cx(
                      "ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold",
                      tab === item.key
                        ? "bg-white text-brand"
                        : "bg-danger text-white",
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-4">
        {botPaused && (
          <div className="mb-4">
            <Alert tone="warning">
              Бот түр зогссон байна. Хэрэглэгчид автомат хариу авахгүй.{" "}
              {control?.pause_reason ? `Шалтгаан: ${control.pause_reason}` : ""}
            </Alert>
          </div>
        )}

        {!dbInfo?.configured && (
          <div className="mb-4">
            <Alert tone="danger">
              Өгөгдлийн сан холбогдоогүй байна. Мэдээлэл хадгалагдахгүй.
            </Alert>
          </div>
        )}

        {readiness && readiness.issues.length > 0 && (
          <div className="mb-4">
            <Alert
              tone={
                readiness.issues.some((issue) => issue.severity === "critical")
                  ? "danger"
                  : "warning"
              }
            >
              Бэлэн байдлын оноо {readiness.score}/10.{" "}
              {readiness.issues
                .slice(0, 2)
                .map((issue) => issue.message)
                .join(" ")}
            </Alert>
          </div>
        )}

        {tab === "assistant" && (
          <AssistantTab
            messages={chatMessages}
            aiInput={aiInput}
            setAiInput={setAiInput}
            attachedFiles={attachedFiles}
            onRemoveAttachedFile={removeAttachedFile}
            dragOver={dragOver}
            setDragOver={setDragOver}
            busy={busyKey === "ai-send"}
            busyLabel={aiBusyLabel}
            applyBusyId={
              busyKey.startsWith("apply-")
                ? busyKey.slice(6)
                : busyKey.startsWith("rollback-")
                  ? busyKey.slice(9)
                  : ""
            }
            clarifyBusyId={
              busyKey.startsWith("clarify-") ? busyKey.slice(8) : ""
            }
            onSend={() => void sendAssistant()}
            onApply={(message) => void applyProposal(message)}
            onRollback={(message) => void rollbackProposal(message)}
            onSubmitClarificationForm={(message, answers) =>
              void submitClarificationForm(message, answers)
            }
            onCancelProposal={(id) =>
              setProposalMessage(id, { status: "cancelled" })
            }
            onToggleConfirm={(id, value) =>
              setProposalMessage(id, { confirmChecked: value })
            }
            onPickFile={() => fileInputRef.current?.click()}
            onDropFiles={(files) => void attachFiles(files)}
            chatEndRef={chatEndRef}
            inputRef={inputRef}
          />
        )}

        {tab === "trips" && (
          <TripsTab
            trips={trips}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            loading={loading}
            onRefresh={() =>
              void loadTrips(searchRef.current, statusFilterRef.current, {
                showLoading: true,
              })
            }
            onCreate={beginCreateTrip}
            onEdit={beginEditTrip}
            onDelete={(trip) => setDeletingTrip(trip)}
          />
        )}

        {tab === "bot" && (
          <BotTab
            control={control}
            pauseReason={pauseReason}
            setPauseReason={setPauseReason}
            recentRows={recentRows}
            pausedRows={pausedRows}
            pausedIds={pausedIds}
            busyKey={busyKey}
            tick={tick}
            onPauseAction={(action, senderId, ms) =>
              void runPauseAction(action, senderId, ms)
            }
          />
        )}

        {tab === "leads" && (
          <LeadsTab
            leads={leads}
            stats={leadStats}
            loading={loading}
            onRefresh={() => void loadLeadsState({ showLoading: true })}
            onMarkSeen={(lead) => void markLeadSeen(lead)}
          />
        )}

        {tab === "settings" && settingsForm && (
          <SettingsTab
            form={settingsForm}
            setForm={setSettingsForm}
            updatedAt={settings?.updated_at}
            busy={busyKey === "save-settings"}
            driveSync={driveSync}
            syncBusy={busyKey === "drive-sync"}
            onSyncDriveNow={() => void syncDriveNow()}
            onSave={() => void saveSettings()}
            onRequestClear={() => setConfirmClear(true)}
          />
        )}
      </main>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_FILES}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) void attachFiles(files);
          e.target.value = "";
        }}
      />

      {/* Trip edit / create modal */}
      <Modal
        open={tripModalOpen}
        onClose={closeTripModal}
        title={isNewTrip ? "Шинэ аялал нэмэх" : "Аялал засах"}
        description={
          isNewTrip ? undefined : editingTrip?.route_name || undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeTripModal}>
              Болих
            </Button>
            <Button
              loading={busyKey === "save-trip"}
              onClick={() => void saveTrip()}
            >
              Хадгалах
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Маршрут"
            value={tripDraft.route_name}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, route_name: e.target.value }))
            }
          />
          <Input
            label="Оператор"
            value={tripDraft.operator_name}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, operator_name: e.target.value }))
            }
          />
          <Input
            label="Ангилал"
            value={tripDraft.category}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, category: e.target.value }))
            }
          />
          <Input
            label="Хугацаа (ж: 5ш6ө)"
            value={tripDraft.duration_text}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, duration_text: e.target.value }))
            }
          />
          <Input
            label="Том хүний үнэ"
            inputMode="numeric"
            value={tripDraft.adult_price}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, adult_price: e.target.value }))
            }
          />
          <Input
            label="Хүүхдийн үнэ"
            inputMode="numeric"
            value={tripDraft.child_price}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, child_price: e.target.value }))
            }
          />
          <Select
            label="Валют"
            value={tripDraft.currency}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, currency: e.target.value }))
            }
          >
            <option value="MNT">MNT (₮)</option>
            <option value="CNY">CNY (юань)</option>
            <option value="USD">USD ($)</option>
          </Select>
          <Select
            label="Төлөв"
            value={tripDraft.status}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, status: e.target.value }))
            }
          >
            <option value="active">Идэвхтэй</option>
            <option value="cancelled">Цуцлагдсан</option>
            <option value="sold_out">Суудал дууссан</option>
            <option value="draft">Ноорог</option>
          </Select>
          <Input
            label="Нийт суудал"
            inputMode="numeric"
            value={tripDraft.seats_total}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, seats_total: e.target.value }))
            }
          />
          <Input
            label="Үлдсэн суудал"
            inputMode="numeric"
            value={tripDraft.seats_left}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, seats_left: e.target.value }))
            }
          />
          <Select
            label="Хоол"
            value={tripDraft.has_food}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, has_food: e.target.value }))
            }
          >
            <option value="unknown">Тодорхойгүй</option>
            <option value="true">Багтсан</option>
            <option value="false">Багтаагүй</option>
          </Select>
          <Input
            label="Гарах өдөр (таслалаар)"
            value={tripDraft.departure_dates}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, departure_dates: e.target.value }))
            }
          />
        </div>
        <div className="mt-3">
          <Textarea
            label="Эх сурвалжийн тайлбар"
            rows={2}
            value={tripDraft.source_description}
            onChange={(e) =>
              setTripDraft((p) => ({
                ...p,
                source_description: e.target.value,
              }))
            }
          />
        </div>
        <div className="mt-3">
          <Textarea
            label="Тэмдэглэл"
            rows={2}
            value={tripDraft.notes}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, notes: e.target.value }))
            }
          />
        </div>
      </Modal>

      {/* Delete trip confirmation modal */}
      <Modal
        open={deletingTrip != null}
        onClose={() => setDeletingTrip(null)}
        title="Аяллыг устгах уу?"
        description={`"${deletingTrip?.route_name || deletingTrip?.operator_name}" — энэ үйлдлийг буцаах боломжгүй.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeletingTrip(null)}>
              Болих
            </Button>
            <Button
              variant="danger"
              loading={busyKey.startsWith("delete-trip-")}
              onClick={() => void confirmDeleteTrip()}
            >
              Устгах
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Устгасны дараа бот энэ аяллын мэдээллийг хариултдаа ашиглахгүй болно.
        </p>
      </Modal>

      {/* Clear settings confirmation modal */}
      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Текст цэвэрлэх үү?"
        description="Түлхүүр үгийн хариу, FAQ, тусгай санал болон бусад мэдээллийг устгана."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              Болих
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                setSettingsForm((prev) =>
                  prev
                    ? {
                        ...prev,
                        quick_info_reply: "",
                        quick_info_keywords: "",
                        comment_trigger_patterns: "",
                        comment_public_reply: "",
                        comment_dm_reply: "",
                        faq: [],
                        special_offers: [],
                        discount_policies: [],
                        verified_credentials: [],
                      }
                    : prev,
                );
              }}
            >
              Цэвэрлэх
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Системийн зааварчилга болон бизнесийн нэр хадгалагдана.
        </p>
      </Modal>
    </div>
  );
}

/* ----------------------------------------------------------------
   Attached-file chip
   ---------------------------------------------------------------- */
function fileGlyph(file: AttachedFile): string {
  const name = file.name.toLowerCase();
  const mime = (file.mimeType || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/.test(name))
    return "🖼️";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "📕";
  if (/\.(xlsx|xlsm|xls|csv)$/.test(name) || mime.includes("sheet")) return "📊";
  if (/\.(txt|text|md|log)$/.test(name) || mime.startsWith("text/")) return "📝";
  return "📎";
}

function FileChip({
  file,
  onRemove,
}: {
  file: AttachedFile;
  onRemove: () => void;
}) {
  return (
    <span
      className="flex max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-surface py-1 pl-2 pr-1 text-xs text-ink"
      title={`${file.name} • ${formatBytes(file.sizeBytes)}`}
    >
      <span aria-hidden="true" className="shrink-0 text-sm leading-none">
        {fileGlyph(file)}
      </span>
      <span className="truncate font-medium" style={{ maxWidth: "11rem" }}>
        {file.name}
      </span>
      <span className="shrink-0 text-ink-subtle">{formatBytes(file.sizeBytes)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${file.name} устгах`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-surface-sunken hover:text-danger"
      >
        <Icons.close size={13} />
      </button>
    </span>
  );
}

/* ----------------------------------------------------------------
   Assistant tab
   ---------------------------------------------------------------- */
function AssistantTab({
  messages,
  aiInput,
  setAiInput,
  attachedFiles,
  onRemoveAttachedFile,
  dragOver,
  setDragOver,
  busy,
  busyLabel,
  applyBusyId,
  clarifyBusyId,
  onSend,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onToggleConfirm,
  onPickFile,
  onDropFiles,
  chatEndRef,
  inputRef,
}: {
  messages: ChatMessage[];
  aiInput: string;
  setAiInput: (value: string) => void;
  attachedFiles: AttachedFile[];
  onRemoveAttachedFile: (fileId: string) => void;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
  busy: boolean;
  busyLabel: string;
  applyBusyId: string;
  clarifyBusyId: string;
  onSend: () => void;
  onApply: (message: ProposalMsg) => void;
  onRollback: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
  onPickFile: () => void;
  onDropFiles: (files: FileList | File[]) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const attachedTotalBytes = attachedFiles.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );

  return (
    <div className="space-y-4">
      <Card
        className={cx(
          "flex flex-col overflow-hidden",
          dragOver && "ring-2 ring-brand",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = e.dataTransfer.files;
          if (files?.length) onDropFiles(files);
        }}
      >
        <div className="scroll-area max-h-[55dvh] min-h-70 space-y-3 overflow-y-auto p-3.5">
          {messages.map((message) => (
            <ChatBubbleV2
              key={message.id}
              message={message}
              applyBusy={applyBusyId === message.id}
              clarifyBusy={clarifyBusyId === message.id}
              onApply={onApply}
              onRollback={onRollback}
              onSubmitClarificationForm={onSubmitClarificationForm}
              onCancelProposal={onCancelProposal}
              onToggleConfirm={onToggleConfirm}
            />
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-line bg-surface px-4 py-3 shadow-sm">
                <div className="flex items-center gap-1">
                  {[0, 1, 2].map((n) => (
                    <span
                      key={n}
                      className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
                      style={{ animationDelay: `${n * 0.15}s` }}
                    />
                  ))}
                </div>
                {busyLabel && (
                  <span className="text-xs text-ink-muted">{busyLabel}</span>
                )}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="scroll-area flex gap-1.5 overflow-x-auto border-t border-line bg-surface-sunken px-3 py-2">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setAiInput(action.prompt);
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-muted hover:border-brand hover:text-brand"
            >
              {action.label}
            </button>
          ))}
        </div>

        {attachedFiles.length > 0 && (
          <div className="border-t border-line bg-surface-sunken px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">
                {attachedFiles.length} файл бэлэн • ~{formatBytes(attachedTotalBytes)}
              </span>
              <button
                type="button"
                onClick={() =>
                  attachedFiles.forEach((file) => onRemoveAttachedFile(file.id))
                }
                className="text-xs font-medium text-brand hover:opacity-70"
              >
                Бүгдийг арилгах
              </button>
            </div>
            <div className="scroll-area flex flex-wrap gap-1.5">
              {attachedFiles.map((file) => (
                <FileChip
                  key={file.id}
                  file={file}
                  onRemove={() => onRemoveAttachedFile(file.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-line p-2.5">
          <button
            type="button"
            onClick={onPickFile}
            aria-label="Attach files"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
          >
            <Icons.plus size={18} />
          </button>
          <textarea
            ref={inputRef}
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            maxLength={MAX_AI_INPUT_CHARS}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder="Ж: «Бангкок аяллыг цуцал» эсвэл прайс жагсаалт файл хавсаргах"
            className="scroll-area max-h-32 min-h-10 flex-1 resize-none rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
          />
          <Button
            onClick={onSend}
            disabled={busy || (!aiInput.trim() && attachedFiles.length === 0)}
            className="h-10 shrink-0"
          >
            Илгээх
          </Button>
        </div>
      </Card>

      <p className="px-1 text-xs text-ink-subtle">
        Хүссэн тооны файл, ямар ч хэмжээтэйгээр оруулж болно. Том файлыг систем автоматаар хэсэглэн уншина. Google Drive линк ч хүссэн тоогоор уншуулж болно.
      </p>

    </div>
  );
}
function ChatBubbleV2({
  message,
  applyBusy,
  clarifyBusy,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onToggleConfirm: _onToggleConfirm,
}: {
  message: ChatMessage;
  applyBusy: boolean;
  clarifyBusy: boolean;
  onApply: (message: ProposalMsg) => void;
  onRollback: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
}) {
  void _onToggleConfirm;
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  if (message.role === "admin") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">
          <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
        </div>
      </div>
    );
  }

  if (message.kind === "note") {
    const tone =
      message.tone === "error"
        ? "danger"
        : message.tone === "success"
          ? "success"
          : "info";
    return (
      <div className="max-w-[92%]">
        <Alert tone={tone}>{message.text}</Alert>
      </div>
    );
  }

  const { proposal } = message;
  const previewActions = proposal.actions.slice(0, 4).map(describeAction);
  const hiddenActionCount = Math.max(
    0,
    proposal.actions.length - previewActions.length,
  );
  const compactWarnings = Array.from(
    new Set(proposal.conflicts.map(summarizeConflict).filter(Boolean)),
  ).slice(0, 3);
  const reviewCount = message.clarifications.length;
  const isReadyToApply = message.status === "pending" && reviewCount === 0;

  return (
    <div className="max-w-[92%]">
      <div className="rounded-xl rounded-bl-sm border border-line bg-surface p-3.5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{proposal.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="neutral">{proposal.actions.length} өөрчлөлт</Badge>
              {reviewCount > 0 ? (
                <Badge tone="warning">{reviewCount} шийдвэр хэрэгтэй</Badge>
              ) : (
                <Badge tone="success">Шууд хадгалахад бэлэн</Badge>
              )}
            </div>
          </div>
          <Badge tone={isReadyToApply ? "success" : "warning"}>
            {isReadyToApply ? "Бэлэн" : "Хянах"}
          </Badge>
        </div>

        {compactWarnings.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900">
              Анхаарах зүйл
            </p>
            <div className="mt-1 space-y-1">
              {compactWarnings.map((item) => (
                <p key={item} className="text-xs text-amber-900/90">
                  {item}
                </p>
              ))}
            </div>
          </div>
        )}

        {previewActions.length > 0 && (
          <details className="mt-3 rounded-md border border-line bg-surface-sunken px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
              Өөрчлөлтийн товч жагсаалт
            </summary>
            <div className="mt-2 space-y-2">
              {previewActions.map((described, index) => (
                <div key={`${described.verb}:${described.target}:${index}`}>
                  <p className="text-sm font-medium text-ink">
                    {index + 1}. {described.verb} · {described.target}
                  </p>
                  {described.changes.length > 0 && (
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {described.changes.slice(0, 2).join(" • ")}
                    </p>
                  )}
                </div>
              ))}
              {hiddenActionCount > 0 && (
                <p className="text-xs text-ink-subtle">
                  +{hiddenActionCount} нэмэлт өөрчлөлт байна.
                </p>
              )}
            </div>
          </details>
        )}

        {message.clarificationAnswers.length > 0 && (
          <details className="mt-3 rounded-md border border-line bg-brand-soft px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-brand">
              Өмнө сонгосон хариултууд ({message.clarificationAnswers.length})
            </summary>
            <div className="mt-2 space-y-2">
              {message.clarificationAnswers.map((item) => (
                <div key={item.questionId} className="rounded-md bg-white/70 px-2.5 py-2">
                  <p className="text-xs text-ink-muted">{item.prompt}</p>
                  <p className="mt-1 text-sm text-ink">{item.answer}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {message.status === "pending" && (
          <div className="mt-3 border-t border-line pt-3">
            {message.clarifications.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-ink">Тодруулах зүйлс</p>
                {message.clarifications.map((q) => {
                  const selected = formDraft[q.id] ?? "";
                  return (
                    <div
                      key={q.id}
                      className="rounded-md border border-line bg-surface-sunken px-3 py-3"
                    >
                      <p className="text-xs font-semibold text-ink-muted">
                        Тодруулга
                      </p>
                      <p className="mt-1 text-sm font-medium text-ink">{q.prompt}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {q.options.map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            disabled={clarifyBusy}
                            onClick={() =>
                              setFormDraft((prev) => ({ ...prev, [q.id]: opt.answer }))
                            }
                            className={cx(
                              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                              selected === opt.answer
                                ? "border-brand bg-brand text-white"
                                : "border-line-strong bg-white text-ink hover:border-brand hover:text-brand",
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      {q.allowCustom && (
                        <input
                          value={
                            q.options.some((o) => o.answer === selected) ? "" : selected
                          }
                          onChange={(e) =>
                            setFormDraft((prev) => ({ ...prev, [q.id]: e.target.value }))
                          }
                          placeholder={q.customPlaceholder || "Өөрийн хариуг бичнэ үү"}
                          className="mt-2 h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink focus:border-brand"
                        />
                      )}
                    </div>
                  );
                })}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={clarifyBusy}
                    disabled={
                      clarifyBusy ||
                      message.clarifications.some((q) => !(formDraft[q.id] ?? "").trim())
                    }
                    onClick={() => {
                      onSubmitClarificationForm(message, formDraft);
                      setFormDraft({});
                    }}
                  >
                    Шийдвэрүүдийг хадгалах
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onCancelProposal(message.id)}
                  >
                    Болих
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mb-2 text-xs text-ink-muted">
                {proposal.conflicts.length > 0
                  ? "Тодорхойгүй байсан зүйлсийг нарийвчилсан. Зөв харагдвал хэрэгжүүлж болно."
                  : "Бүх зүйл тодорхой байна. Өөрчлөлтийг хэрэгжүүлж болно."}
              </p>
            )}
            {message.clarifications.length === 0 && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="success"
                  loading={applyBusy}
                  onClick={() => onApply(message)}
                >
                  <Icons.check size={15} />
                  Зөвшөөрч хадгалах
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onCancelProposal(message.id)}
                >
                  Болих
                </Button>
              </div>
            )}
          </div>
        )}

        {message.status === "applied" && (
          <div className="mt-3 space-y-2 border-t border-line pt-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-success">
              <Icons.check size={14} />
              Хадгалагдлаа. {message.resultText}
            </div>
            {message.requestId != null && (
              <Button
                size="sm"
                variant="secondary"
                loading={applyBusy}
                onClick={() => onRollback(message)}
              >
                Буцаах
              </Button>
            )}
          </div>
        )}
        {message.status === "reverted" && (
          <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2 text-xs font-medium text-warning">
            <Icons.alert size={14} />
            Өөрчлөлт буцаагдлаа. {message.resultText}
          </div>
        )}
        {message.status === "cancelled" && (
          <p className="mt-3 border-t border-line pt-2 text-xs text-ink-subtle">
            Цуцлагдсан.
          </p>
        )}
        {message.status === "error" && (
          <p className="mt-3 border-t border-line pt-2 text-xs text-danger">
            {message.resultText || "Алдаа гарлаа."}
          </p>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Trips tab
   ---------------------------------------------------------------- */
function TripsTab({
  trips,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  loading,
  onRefresh,
  onCreate,
  onEdit,
  onDelete,
}: {
  trips: TravelTrip[];
  search: string;
  setSearch: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (trip: TravelTrip) => void;
  onDelete: (trip: TravelTrip) => void;
}) {
  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Маршрут эсвэл оператор хайх…"
              className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
            />
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Шинэчлэх"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
            >
              {loading ? <Spinner /> : <Icons.refresh size={17} />}
            </button>
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink focus:border-brand"
            >
              <option value="">Бүх төлөв</option>
              <option value="active">Идэвхтэй</option>
              <option value="cancelled">Цуцлагдсан</option>
              <option value="sold_out">Суудал дууссан</option>
              <option value="draft">Ноорог</option>
            </select>
            <Button onClick={onCreate} className="shrink-0">
              <Icons.plus size={16} />
              Шинэ аялал
            </Button>
          </div>
        </div>
      </Card>

      {trips.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.trips size={26} />}
            title="Аялал олдсонгүй"
            description="Шинэ аялал нэмэх, эсвэл AI Туслахаар прайс жагсаалт оруулна уу."
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {trips.map((trip) => (
            <TripCard
              key={trip.id}
              trip={trip}
              onEdit={() => onEdit(trip)}
              onDelete={() => onDelete(trip)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TripCard({
  trip,
  onEdit,
  onDelete,
}: {
  trip: TravelTrip;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const facts: string[] = [];
  if (trip.seats_left != null || trip.seats_total != null) {
    facts.push(
      `Суудал: ${trip.seats_left ?? "?"}/${trip.seats_total ?? "?"}`,
    );
  }
  if (trip.adult_price != null) {
    facts.push(`Том хүн: ${trip.adult_price.toLocaleString()}${trip.currency}`);
  }
  if (trip.child_price != null) {
    facts.push(`Хүүхэд: ${trip.child_price.toLocaleString()}${trip.currency}`);
  }
  if (trip.has_food != null) {
    facts.push(`Хоол: ${trip.has_food ? "багтсан" : "багтаагүй"}`);
  }
  if (trip.duration_text) facts.push(trip.duration_text);
  if (trip.departure_dates.length) {
    facts.push(`${trip.departure_dates.length} гарах өдөр`);
  }

  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{trip.route_name || "—"}</p>
          <p className="text-xs text-ink-subtle">
            {trip.operator_name}
            {trip.category ? ` · ${trip.category}` : ""}
          </p>
        </div>
        <Badge tone={STATUS_TONE[trip.status]}>
          {STATUS_LABELS[trip.status]}
        </Badge>
      </div>
      {facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {facts.map((fact, i) => (
            <span
              key={i}
              className="rounded-md bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
            >
              {fact}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-subtle">
          Шинэчилсэн: {formatTime(trip.updated_at)}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Icons.edit size={15} />
            Засах
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>
            <Icons.trash size={15} />
            Устгах
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Leads tab — human-handoff requests & booking-intent captures
   ---------------------------------------------------------------- */
function LeadsDashboard({ stats }: { stats: LeadStats }) {
  const platformLabel = (p: string) =>
    p === "instagram" ? "Instagram" : p === "facebook" ? "Facebook" : p;

  // Build a continuous 7-day series (fill gaps with 0) for the mini bar chart.
  const days: Array<{ day: string; count: number; label: string }> = [];
  const byDay = new Map(stats.daily.map((d) => [d.day, d.count]));
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      day: key,
      count: byDay.get(key) ?? 0,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
    });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  const cards = [
    { label: "Шинэ хүсэлт", value: stats.new_count, tone: "text-danger" },
    { label: "Өнөөдөр", value: stats.today, tone: "text-brand" },
    { label: "7 хоногт", value: stats.last7days, tone: "text-ink" },
    { label: "Нийт", value: stats.total, tone: "text-ink" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="p-3">
            <p className="text-xs text-ink-subtle">{c.label}</p>
            <p className={cx("mt-1 text-2xl font-bold tabular-nums", c.tone)}>
              {c.value}
            </p>
          </Card>
        ))}
      </div>

      <Card className="p-3.5">
        <p className="mb-3 text-sm font-medium text-ink">
          Сүүлийн 7 хоногийн хүсэлт
        </p>
        <div className="flex h-28 items-end justify-between gap-1.5">
          {days.map((d) => (
            <div
              key={d.day}
              className="flex flex-1 flex-col items-center gap-1"
              title={`${d.label}: ${d.count}`}
            >
              <span className="text-xs font-medium tabular-nums text-ink-muted">
                {d.count > 0 ? d.count : ""}
              </span>
              <div
                className="w-full rounded-t bg-brand/80"
                style={{
                  height: `${Math.max(4, (d.count / maxCount) * 80)}px`,
                }}
              />
              <span className="text-[10px] text-ink-subtle">{d.label}</span>
            </div>
          ))}
        </div>
      </Card>

      {stats.by_platform.length > 0 && (
        <Card className="p-3.5">
          <p className="mb-2 text-sm font-medium text-ink">Сувгаар</p>
          <div className="flex flex-wrap gap-2">
            {stats.by_platform.map((p) => (
              <span
                key={p.platform}
                className="rounded-md border border-line bg-surface-sunken px-2.5 py-1 text-xs text-ink"
              >
                {platformLabel(p.platform)}:{" "}
                <span className="font-semibold tabular-nums">{p.count}</span>
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function LeadsTab({
  leads,
  stats,
  loading,
  onRefresh,
  onMarkSeen,
}: {
  leads: TravelLead[];
  stats: LeadStats | null;
  loading: boolean;
  onRefresh: () => void;
  onMarkSeen: (lead: TravelLead) => void;
}) {
  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Хэрэглэгчийн хүсэлтүүд</p>
            <p className="text-xs text-ink-subtle">
              Хүнтэй ярих хүсэлт болон захиалгын сонирхол гаргасан хэрэглэгчид.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Шинэчлэх"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
          >
            {loading ? <Spinner /> : <Icons.refresh size={17} />}
          </button>
        </div>
      </Card>

      {stats && <LeadsDashboard stats={stats} />}

      {leads.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.alert size={26} />}
            title="Хүсэлт алга"
            description="Хэрэглэгч хүнтэй ярих эсвэл захиалга хийх сонирхол гаргавал энд харагдана."
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onMarkSeen={() => onMarkSeen(lead)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  onMarkSeen,
}: {
  lead: TravelLead;
  onMarkSeen: () => void;
}) {
  const isNew = lead.status === "new";
  const isBooking = lead.kind === "booking";
  const channel = lead.platform === "instagram" ? "Instagram" : "Facebook";

  return (
    <Card className={cx("p-3.5", !isNew && "opacity-65")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isBooking ? "success" : "warning"} dot>
            {isBooking ? "Захиалгын сонирхол" : "Хүн ярих хүсэлт"}
          </Badge>
          <span className="text-xs text-ink-subtle">{channel}</span>
        </div>
        {isNew && (
          <Badge tone="danger">Шинэ</Badge>
        )}
      </div>

      <p className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-sm text-ink">
        {lead.customer_message || "(хоосон зурвас)"}
      </p>

      {lead.contact_phone && (
        <p className="mt-2 text-sm font-semibold text-ink">
          ☎ Утас:{" "}
          <a href={`tel:${lead.contact_phone}`} className="text-brand">
            {lead.contact_phone}
          </a>
        </p>
      )}

      {lead.context && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">
            Харилцааны түүх
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-canvas/60 px-2.5 py-2 text-xs text-ink-muted">
            {lead.context}
          </p>
        </details>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-subtle">
          {formatTime(lead.created_at)} · ID …{lead.sender_id.slice(-6)}
        </span>
        {isNew ? (
          <Button size="sm" variant="secondary" onClick={onMarkSeen}>
            <Icons.check size={15} />
            Хариуцсан
          </Button>
        ) : (
          <span className="flex items-center gap-1 text-xs text-ink-subtle">
            <Icons.check size={13} />
            Харсан
          </span>
        )}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Bot tab
   ---------------------------------------------------------------- */
function BotTab({
  control,
  pauseReason,
  setPauseReason,
  recentRows,
  pausedRows,
  pausedIds,
  busyKey,
  tick,
  onPauseAction,
}: {
  control: ControlState | null;
  pauseReason: string;
  setPauseReason: (value: string) => void;
  recentRows: RecentRow[];
  pausedRows: PauseRow[];
  pausedIds: Set<string>;
  busyKey: string;
  tick: number;
  onPauseAction: (
    action: "pause" | "resume" | "global_pause" | "global_resume",
    senderId?: string,
    ms?: number | null,
  ) => void;
}) {
  const botPaused = Boolean(control?.bot_paused);
  const handoffRows = pausedRows.filter((row) => row.reason === "handoff");
  const handoffIds = new Set(handoffRows.map((row) => row.sender_id));
  return (
    <div className="space-y-3">
      {handoffRows.length > 0 && (
        <Card className="border-warning/40 bg-warning-soft p-4">
          <div className="flex items-start gap-2">
            <span className="text-lg leading-none">🙋</span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink">
                Хүнтэй ярихыг хүссэн ({handoffRows.length})
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Эдгээр хэрэглэгч ажилтантай ярихыг хүссэн. Messenger дээр
                очиж хариулна уу. Бот тэдэнд автоматаар хариулахгүй.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {handoffRows.map((row) => (
              <div
                key={row.sender_id}
                className="rounded-md border border-warning/40 bg-surface p-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-ink">
                    {shortId(row.sender_id)}
                  </p>
                    <p className="text-xs text-ink-subtle">
                    Хүссэн: {formatTime(row.paused_at)} · Дуусах:{" "}
                    {tick >= 0 ? timeLeft(row.expires_at) : ""}
                    </p>
                  </div>
                <Button
                  size="sm"
                  variant="success"
                  disabled={
                    busyKey === `resume:${row.sender_id}` ||
                    busyKey === `pause:${row.sender_id}`
                  }
                  onClick={() => onPauseAction("resume", row.sender_id)}
                >
                  Ботыг сэргээх
                </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[
                    { label: "30 мин", ms: 30 * 60 * 1000 },
                    { label: "1 цаг", ms: 60 * 60 * 1000 },
                    { label: "Гараар", ms: null },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      disabled={
                        busyKey === `pause:${row.sender_id}` ||
                        busyKey === `resume:${row.sender_id}`
                      }
                      onClick={() =>
                        onPauseAction("pause", row.sender_id, option.ms)
                      }
                      className="rounded-md border border-warning/40 bg-warning-soft px-2 py-1 text-xs font-medium text-warning hover:border-warning"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <SectionHeading
          title="Ботын төлөв"
          description="Мэдээлэл их хэмжээгээр шинэчлэх үед ботыг түр зогсоож болно."
        />
        <div className="mt-3 flex items-center gap-2">
          <Badge tone={botPaused ? "danger" : "success"} dot>
            {botPaused ? "Бот зогссон" : "Бот идэвхтэй"}
          </Badge>
          <span className="text-xs text-ink-subtle">
            {formatTime(control?.updated_at)}
          </span>
        </div>
        <div className="mt-3 space-y-2">
          <input
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="Зогсоох шалтгаан (сонголттой)"
            className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              block
              disabled={busyKey === "global_pause:global" || botPaused}
              onClick={() => onPauseAction("global_pause")}
            >
              <Icons.pause size={16} />
              Бот зогсоох
            </Button>
            <Button
              variant="success"
              block
              disabled={busyKey === "global_resume:global" || !botPaused}
              onClick={() => onPauseAction("global_resume")}
            >
              <Icons.play size={16} />
              Бот сэргээх
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Сүүлийн харилцагчид"
          description="Тодорхой хэрэглэгчийн ботыг түр зогсоох/сэргээх."
        />
        <div className="mt-3 space-y-2">
          {recentRows.length === 0 && (
            <p className="text-sm text-ink-subtle">
              Сүүлийн харилцан яриа алга.
            </p>
          )}
          {recentRows.map((row) => {
            const isPaused = pausedIds.has(row.sender_id);
            const pauseRow = pausedRows.find(
              (p) => p.sender_id === row.sender_id,
            );
            const wantsHuman = handoffIds.has(row.sender_id);
            return (
              <div
                key={row.sender_id}
                className={cx(
                  "rounded-md border p-2.5",
                  wantsHuman
                    ? "border-warning/40 bg-warning-soft"
                    : "border-line bg-surface-sunken",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate font-mono text-xs text-ink">
                      {shortId(row.sender_id)}
                      {wantsHuman && (
                        <span className="shrink-0 rounded-full bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">
                          🙋 хүн хүсэв
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-ink-subtle">
                      {formatTime(row.last_seen)}
                      {isPaused && pauseRow
                        ? ` · ${tick >= 0 ? timeLeft(pauseRow.expires_at) : ""}`
                        : ""}
                    </p>
                  </div>
                  {isPaused ? (
                    <Button
                      size="sm"
                      variant="success"
                      disabled={busyKey === `resume:${row.sender_id}`}
                      onClick={() => onPauseAction("resume", row.sender_id)}
                    >
                      Сэргээх
                    </Button>
                  ) : (
                    <div className="flex gap-1">
                      {DURATIONS.map((duration) => (
                        <button
                          key={duration.label}
                          type="button"
                          disabled={busyKey === `pause:${row.sender_id}`}
                          onClick={() =>
                            onPauseAction("pause", row.sender_id, duration.ms)
                          }
                          className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-ink-muted hover:border-danger hover:text-danger"
                        >
                          {duration.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------
   Settings tab
   ---------------------------------------------------------------- */
function SettingsTab({
  form,
  setForm,
  updatedAt,
  busy,
  driveSync,
  syncBusy,
  onSyncDriveNow,
  onSave,
  onRequestClear,
}: {
  form: SettingsForm;
  setForm: React.Dispatch<React.SetStateAction<SettingsForm | null>>;
  updatedAt?: string;
  busy: boolean;
  driveSync: DriveSyncDiagnostics | null;
  syncBusy: boolean;
  onSyncDriveNow: () => void;
  onSave: () => void;
  onRequestClear: () => void;
}) {
  function patch(partial: Partial<SettingsForm>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  const handoffDurationMode = handoffDurationSelectValue(form.handoff_pause_minutes);
  const [showOptionalData, setShowOptionalData] = useState(false);

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <SectionHeading
          title="Google Drive Sync"
          description="Drive folder-оос өөрчлөгдсөн файлуудыг автоматаар уншиж, аюулгүй бол шууд хадгална."
          action={
            <Button size="sm" loading={syncBusy} onClick={onSyncDriveNow}>
              <Icons.refresh size={15} />
              Sync now
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={driveSync?.enabled ? "success" : "neutral"} dot>
              {driveSync?.enabled ? "Идэвхтэй" : "Унтраалттай"}
            </Badge>
            <Badge tone={driveSyncTone(driveSync?.state.status)}>
              {driveSync?.state.status || "idle"}
            </Badge>
            <span className="text-xs text-ink-subtle">
              Давтамж: {driveSync?.interval_minutes ?? 30} мин
            </span>
            <span className="text-xs text-ink-subtle">
              Дээд файл: {driveSync?.file_limit ?? 0}
            </span>
          </div>

          {!driveSync?.configured ? (
            <Alert tone="warning">
              GOOGLE_DRIVE_SYNC_ENABLED-ийг асаахаас гадна folder ID, service account
              email, private key-гээ env-д тохируулна. Дараа нь тухайн Drive folder-оо
              service account хаягтай share хийнэ.
            </Alert>
          ) : (
            <div className="rounded-lg border border-line bg-surface-sunken p-3 text-sm text-ink-muted">
              <p>Folder ID: {driveSync.folder_id || "—"}</p>
              <p>Service account: {driveSync.service_account_email || "—"}</p>
              <p>Сүүлд шалгасан: {formatTime(driveSync.state.last_checked_at)}</p>
              <p>Сүүлд дууссан: {formatTime(driveSync.state.last_synced_at)}</p>
              <p>
                Үзсэн {driveSync.state.files_examined} · Өөрчлөгдсөн{" "}
                {driveSync.state.files_changed} · Автоматаар хадгалсан{" "}
                {driveSync.state.files_applied} · Хяналт шаардлагатай{" "}
                {driveSync.state.files_blocked}
              </p>
              {driveSync.state.last_summary && (
                <p className="mt-2 whitespace-pre-wrap text-ink">
                  {driveSync.state.last_summary}
                </p>
              )}
              {driveSync.state.last_error && (
                <p className="mt-2 whitespace-pre-wrap text-danger">
                  {driveSync.state.last_error}
                </p>
              )}
            </div>
          )}

          {driveSync?.recent_files?.length ? (
            <div className="space-y-2">
              {driveSync.recent_files.slice(0, 4).map((file) => (
                <div
                  key={file.file_id}
                  className="rounded-md border border-line bg-surface px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">
                      {file.file_name || file.file_id}
                    </p>
                    <Badge tone={driveSyncTone(file.last_status as DriveSyncDiagnostics["state"]["status"])}>
                      {file.last_status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {formatTime(file.updated_at)}
                    {file.request_id ? ` · Request #${file.request_id}` : ""}
                  </p>
                  {file.last_error && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-danger">
                      {file.last_error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Үндсэн мэдээлэл"
          description={
            updatedAt
              ? `Шинэчилсэн: ${formatTime(updatedAt)}`
              : 'Бизнесийн нэр болон ботын үндсэн дүрэм.'
          }
          action={
            <Button size="sm" variant="ghost" onClick={onRequestClear}>
              Текст цэвэрлэх
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <Input
            label="Бизнесийн нэр"
            value={form.business_name}
            onChange={(e) => patch({ business_name: e.target.value })}
          />
          <Textarea
            label="Системийн зааварчилга"
            hint="Хэрэглэгчтэй харилцах ботын үндсэн дүрэм."
            rows={4}
            value={form.system_prompt}
            onChange={(e) => patch({ system_prompt: e.target.value })}
          />
          <Textarea
            label="Түлхүүр үгийн хариу"
            hint="Хэрэглэгч доорх түлхүүр үг бичвэл бот энэ хариуг автоматаар илгээнэ."
            rows={3}
            value={form.quick_info_reply}
            onChange={(e) => patch({ quick_info_reply: e.target.value })}
          />
          <Textarea
            label="Түлхүүр үгс"
            hint="Нэг мөрт нэг түлхүүр үг эсвэл хэллэг."
            rows={3}
            value={form.quick_info_keywords}
            onChange={(e) => patch({ quick_info_keywords: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Коммент автомат хариу"
          description="Facebook пост дээрх комментэд хариулах тохиргоо."
        />
        <div className="mt-3 space-y-3">
          <Textarea
            label="Коммент илэрхийлэх түлхүүр үгс"
            hint="Нэг мөрт нэг түлхүүр үг эсвэл хэллэг."
            rows={3}
            value={form.comment_trigger_patterns}
            onChange={(e) =>
              patch({ comment_trigger_patterns: e.target.value })
            }
          />
          <Textarea
            label="Нийтийн хариу (комментэд)"
            hint="Хэрэглэгчийн комментийн доор харагдах хариу."
            rows={2}
            value={form.comment_public_reply}
            onChange={(e) => patch({ comment_public_reply: e.target.value })}
          />
          <Textarea
            label="Хувийн мессеж (DM)"
            hint="Хэрэглэгчид шууд илгээх нууц хариу."
            rows={3}
            value={form.comment_dm_reply}
            onChange={(e) => patch({ comment_dm_reply: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Хүнд шилжүүлэх"
          description="Хэрэглэгч ажилтантай ярихыг хүсвэл бот зогсож, та хариулна."
        />
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2.5 rounded-md border border-line bg-surface-sunken p-3">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.handoff_enabled}
              onChange={(e) => patch({ handoff_enabled: e.target.checked })}
            />
            <span className="text-sm font-medium text-ink">
              Хүнд шилжүүлэх идэвхжүүлэх
            </span>
          </label>
          <Textarea
            label="Илэрхийлэх түлхүүр үгс"
            hint="Хэрэглэгчийн мессежэд эдгээр үг байвал бот зогсч ажилтанд шилжинэ."
            rows={4}
            value={form.handoff_keywords}
            onChange={(e) => patch({ handoff_keywords: e.target.value })}
          />
          <Textarea
            label="Хэрэглэгчид илгээх хариу"
            rows={2}
            value={form.handoff_reply}
            onChange={(e) => patch({ handoff_reply: e.target.value })}
          />
          <Select
            label="Зогсоох хугацаа"
            hint="Тогтмол хугацаа сонгоно уу, эсвэл доорх минутын талбарт өөрийн утга оруулна уу."
            value={handoffDurationMode}
            onChange={(e) => {
              const next = e.target.value;
              patch({
                handoff_pause_minutes:
                  next === HANDOFF_DURATION_CUSTOM
                    ? form.handoff_pause_minutes
                    : next,
              });
            }}
          >
            {HANDOFF_DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={HANDOFF_DURATION_CUSTOM}>Өөр хугацаа</option>
          </Select>
          <Input
            label="Зогсоох минут"
            hint="Энэ хугацааны дараа бот автоматаар сэргэнэ. 0 оруулбал гараар сэргээх болно."
            inputMode="numeric"
            value={form.handoff_pause_minutes}
            onChange={(e) => patch({ handoff_pause_minutes: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Нэмэлт ботын мэдлэг"
          description="FAQ, тусгай санал, хөнгөлөлт, итгэмжлэл нэмэхийг хүсвэл нээнэ үү."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowOptionalData((prev) => !prev)}
            >
              {showOptionalData ? 'Нуух' : 'Нээх'}
            </Button>
          }
        />
        {showOptionalData ? (
          <div className="mt-3 space-y-3">
            <StructuredEditor
              title="Түгээмэл асуулт (FAQ)"
              addLabel="Асуулт нэмэх"
              fields={[
                { key: 'question', label: 'Асуулт' },
                { key: 'answer', label: 'Хариулт' },
              ]}
              rows={form.faq}
              onChange={(rows) => patch({ faq: rows })}
            />
            <StructuredEditor
              title="Тусгай санал"
              addLabel="Санал нэмэх"
              fields={[
                { key: 'name', label: 'Нэр' },
                { key: 'duration', label: 'Хугацаа' },
                { key: 'price', label: 'Үнэ' },
                { key: 'target', label: 'Зорилтот' },
                { key: 'eligibility', label: 'Нөхцөл' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.special_offers}
              onChange={(rows) => patch({ special_offers: rows })}
            />
            <StructuredEditor
              title="Хөнгөлөлтийн бодлого"
              addLabel="Хөнгөлөлт нэмэх"
              fields={[
                { key: 'name', label: 'Нэр' },
                { key: 'discount', label: 'Хөнгөлөлт' },
                { key: 'applies_to', label: 'Хамаарах' },
                { key: 'eligibility', label: 'Нөхцөл' },
                { key: 'verification', label: 'Баталгаажуулалт' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.discount_policies}
              onChange={(rows) => patch({ discount_policies: rows })}
            />
            <StructuredEditor
              title="Итгэмжлэл"
              addLabel="Итгэмжлэл нэмэх"
              fields={[
                { key: 'title', label: 'Гарчиг' },
                { key: 'issuer', label: 'Олгогч' },
                { key: 'issued_on', label: 'Олгосон огноо' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.verified_credentials}
              onChange={(rows) => patch({ verified_credentials: rows })}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            Хуудсыг энгийн байлгахын тулд нуусан. FAQ эсвэл тусгай санал нэмэхийг хүсвэл нээнэ үү.
          </p>
        )}
      </Card>

      <div className="sticky bottom-3 z-10">
        <Button block size="lg" loading={busy} onClick={onSave}>
          Тохиргоо хадгалах
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white">
            <Icons.ai size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Бот туршиж үзэх</p>
            <p className="text-xs text-ink-muted">Хэрэглэгч шиг асуугаад хариуг шалгаарай</p>
          </div>
          <Badge tone="success" dot className="ml-auto shrink-0">
            Идэвхтэй
          </Badge>
        </div>
        <EmbeddedTestBot />
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------
   Embedded test bot (in SettingsTab) — Messenger style
   ---------------------------------------------------------------- */
type TestChatMsg = { from: "user" | "bot"; text: string };

const TEST_SUGGESTIONS = [
  "Хөх хот аяллын үнэ хэд вэ?",
  "Ирэх сард ямар аяллууд байгаа вэ?",
  "Суудал хэд үлдсэн бэ?",
  "Хоол багтдаг уу?",
];

function EmbeddedTestBot() {
  const [messages, setMessages] = useState<TestChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Client-only init from storage; safe one-shot setState on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversationId(getTestBotConversationId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(textOverride?: string) {
    const payload = (textOverride ?? input).trim();
    if (!payload || sending || !conversationId) return;
    setMessages((prev) => [...prev, { from: "user", text: payload }]);
    setInput("");
    setSending(true);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload, conversationId }),
      });
      const json = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          from: "bot",
          text:
            typeof json?.reply === "string" && json.reply.trim()
              ? json.reply
              : "Хариу үүсгэх үед алдаа гарлаа.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: "Уучлаарай, сервертэй холбогдоход алдаа гарлаа." },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Suggestion chips */}
      <div className="scroll-area flex gap-2 overflow-x-auto border-b border-line bg-surface-sunken px-4 py-2.5">
        {TEST_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={sending || !conversationId}
            onClick={() => void send(s)}
            className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Message area */}
      <div className="scroll-area h-72 overflow-y-auto bg-[#f0f2f5] px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Icons.ai size={24} />
            </div>
            <p className="text-sm text-ink-muted">
              Хэрэглэгч шиг асуулт бичээрэй — бот хэрхэн хариулахыг шалгаарай.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {messages.map((msg, i) => {
              const isUser = msg.from === "user";
              const showAvatar =
                !isUser &&
                (i === 0 || messages[i - 1]?.from === "user");
              return (
                <div
                  key={i}
                  className={cx(
                    "flex items-end gap-2",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  {!isUser && (
                    <div
                      className={cx(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white text-xs font-bold",
                        !showAvatar && "opacity-0",
                      )}
                    >
                      AI
                    </div>
                  )}
                  <div
                    className={cx(
                      "max-w-[75%] px-4 py-2.5 text-sm leading-relaxed",
                      isUser
                        ? "rounded-[20px] rounded-br-[4px] bg-brand text-white"
                        : "rounded-[20px] rounded-bl-[4px] bg-white text-ink shadow-sm",
                    )}
                  >
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="flex items-end gap-2 justify-start">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white text-xs font-bold">
                  AI
                </div>
                <div className="rounded-[20px] rounded-bl-[4px] bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-1">
                    {[0, 1, 2].map((n) => (
                      <span
                        key={n}
                        className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
                        style={{ animationDelay: `${n * 0.15}s` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar — Messenger style */}
      <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2.5">
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            title="Чат цэвэрлэх"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-subtle hover:bg-surface-sunken hover:text-ink"
          >
            <Icons.trash size={16} />
          </button>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void send(); }
          }}
          placeholder="Мессеж бичих…"
          disabled={sending || !conversationId}
          className="h-10 min-w-0 flex-1 rounded-full border border-line-strong bg-surface-sunken px-4 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:bg-surface focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          disabled={sending || !input.trim() || !conversationId}
          onClick={() => void send()}
          className={cx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
            input.trim() && !sending
              ? "bg-brand text-white hover:opacity-90"
              : "bg-surface-sunken text-ink-subtle cursor-not-allowed",
          )}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
