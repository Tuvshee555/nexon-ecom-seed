import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  MAX_PARSE_UPLOAD_DECODED_BYTES,
  MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES,
  parseUpload,
  type ParsedUpload,
} from "../../../lib/fileParse";
import { getClientKey, rateLimitAsync } from "../../../lib/rateLimit";
import {
  extractGoogleDriveFileIds,
  parseGoogleDriveFileId,
} from "../../../lib/googleDriveSync";
import {
  generateAIProposalFromContentBatched,
  getAIProposalFailureResponse,
} from "../../../lib/travelOps";
import {
  beginRequestTrace,
  finishRequestTrace,
  recordCounter,
} from "../../../lib/observability";
import {
  PayloadTooLargeError,
  readRawBodyLimited,
} from "../../../lib/webhookSecurity";

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 180,
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type UploadPayload = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

// Vercel hard-caps a serverless request body at ~4.5MB — this stays under it.
// This is the one ceiling we cannot lift; the client chunker keeps every
// request well below it.
const ADMIN_PARSE_BODY_MAX_BYTES = 4_500_000;
// Generous rate window: a large multi-chunk file (e.g. a long PDF) fans out
// into many one-chunk requests, so the limit must comfortably exceed the
// chunk count of a single big upload to avoid mid-upload throttling.
const ADMIN_PARSE_RATE_LIMIT = 1_000;
const ADMIN_PARSE_RATE_WINDOW_MS = 10 * 60 * 1000;
// Latent per-request safety nets (the client sends one unit per request, so
// these are effectively never hit) — kept high so no future batching trips them.
const MAX_UPLOADS_PER_REQUEST = 1_000;
const MAX_DRIVE_FILE_IDS_PER_REQUEST = 1_000;
const MAX_NOTE_CHARS = 4_000;

function collectUploads(body: Record<string, unknown>): UploadPayload[] {
  if (Array.isArray(body.uploads)) {
    return body.uploads
      .map((item) => {
        const entry = item && typeof item === "object" ? item : {};
        return {
          filename: asText((entry as Record<string, unknown>).filename) || "upload",
          mimeType: asText((entry as Record<string, unknown>).mimeType),
          dataBase64:
            typeof (entry as Record<string, unknown>).dataBase64 === "string"
              ? String((entry as Record<string, unknown>).dataBase64)
              : "",
        };
      })
      .filter((item) => item.dataBase64);
  }

  const fallback = {
    filename: asText(body.filename) || "upload",
    mimeType: asText(body.mimeType),
    dataBase64: typeof body.dataBase64 === "string" ? body.dataBase64 : "",
  };
  return fallback.dataBase64 ? [fallback] : [];
}

function collectDriveFileIds(body: Record<string, unknown>, note: string): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const id of extractGoogleDriveFileIds(value)) {
      if (!ids.includes(id)) ids.push(id);
    }
    const trimmed = value.trim();
    if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed) && !ids.includes(trimmed)) {
      ids.push(trimmed);
    }
  };

  if (Array.isArray(body.driveLinks)) {
    body.driveLinks.forEach(add);
  }
  if (Array.isArray(body.driveFileIds)) {
    body.driveFileIds.forEach(add);
  }
  add(note);
  return ids;
}

function estimateDecodedBytes(dataBase64: string) {
  const cleaned = dataBase64.includes(",")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;
  const compact = cleaned.replace(/\s/g, "");
  return (
    Math.ceil((compact.length * 3) / 4) -
    (compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0)
  );
}

async function readJsonBody(req: NextApiRequest): Promise<Record<string, unknown>> {
  const contentLengthHeader = req.headers["content-length"];
  const contentLengthRaw = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader;
  const raw = (
    await readRawBodyLimited(
      req,
      ADMIN_PARSE_BODY_MAX_BYTES,
      contentLengthRaw,
    )
  )
    .toString("utf8")
    .trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.parse_file",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.parse_file");
    if (!allowed) return;

    if (req.method !== "POST") return res.status(405).end();

    const clientKey = getClientKey(req);
    const limit = await rateLimitAsync(
      `admin-ai:parse-file:${clientKey}`,
      ADMIN_PARSE_RATE_LIMIT,
      ADMIN_PARSE_RATE_WINDOW_MS,
    );
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.admin.parse_file",
        scope: "admin_ai",
      });
      return res.status(429).json({
        error: "rate_limited",
        reset: limit.reset,
        retry_after_ms: Math.max(0, limit.reset - Date.now()),
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return res.status(413).json({
          error: "upload_payload_too_large",
          max_bytes: ADMIN_PARSE_BODY_MAX_BYTES,
        });
      }
      return res.status(400).json({ error: "Invalid JSON upload payload." });
    }
    const note = asText((body as Record<string, unknown>).note);
    if (note.length > MAX_NOTE_CHARS) {
      return res.status(413).json({
        error: "note_too_long",
        max_chars: MAX_NOTE_CHARS,
      });
    }
    const uploads = collectUploads(body);
    const driveFileIds = collectDriveFileIds(body, note);

    if (uploads.length === 0 && driveFileIds.length === 0) {
      return res.status(400).json({ error: "No uploaded file data was provided." });
    }
    if (uploads.length > MAX_UPLOADS_PER_REQUEST) {
      return res.status(413).json({
        error: "too_many_uploads",
        max_uploads: MAX_UPLOADS_PER_REQUEST,
      });
    }
    let totalUploadBytes = 0;
    for (const upload of uploads) {
      const uploadBytes = estimateDecodedBytes(upload.dataBase64);
      if (uploadBytes > MAX_PARSE_UPLOAD_DECODED_BYTES) {
        return res.status(413).json({
          error: "upload_file_too_large",
          max_file_bytes: MAX_PARSE_UPLOAD_DECODED_BYTES,
        });
      }
      totalUploadBytes += uploadBytes;
    }
    if (totalUploadBytes > MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES) {
      return res.status(413).json({
        error: "upload_total_too_large",
        max_total_bytes: MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES,
      });
    }
    if (driveFileIds.length > MAX_DRIVE_FILE_IDS_PER_REQUEST) {
      return res.status(413).json({
        error: "too_many_drive_files",
        max_drive_files: MAX_DRIVE_FILE_IDS_PER_REQUEST,
      });
    }

    const parsedUploads: ParsedUpload[] = [];
    try {
      for (const upload of uploads) {
        parsedUploads.push(await parseUpload(upload));
      }
      for (const fileId of driveFileIds) {
        const driveFile = await parseGoogleDriveFileId(fileId);
        parsedUploads.push(...driveFile.parsedUploads);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to parse uploaded file.";
      return res.status(/too large/i.test(message) ? 413 : 400).json({
        error: message,
      });
    }

    const result = await generateAIProposalFromContentBatched({
      note: note || undefined,
      sources: parsedUploads.map((parsed) => ({
        label: parsed.label,
        contentText: parsed.text || undefined,
        inline: parsed.inline,
      })),
    });

    const failure = getAIProposalFailureResponse(result.proposal);
    if (failure) {
      return res.status(failure.statusCode).json({
        ok: false,
        error: failure.error,
        retry_after_ms: failure.retry_after_ms,
      });
    }

    return res.status(200).json({
      ok: true,
      proposal: result.proposal,
      request_id: result.request_id,
      requires_confirmation: Boolean(result.proposal.needs_confirmation),
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error.",
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
