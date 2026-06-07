import { createSign, randomUUID } from "crypto";
import { parseUpload, type ParsedUpload } from "./fileParse";
import { getEnv } from "./env";
import { extractGoogleDriveFileIds } from "./googleDriveLinks";
import { logError, logInfo, recordCounter } from "./observability";
import { queryNeon, withNeonClient } from "./neonDb";
import {
  applyAIRequest,
  ensureTravelSchema,
  generateAIProposalFromContentBatched,
} from "./travelOps";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_SYNC_LOCK_ID = 420451;
const DRIVE_LINK_PDF_CHUNK_BYTES = 4 * 1024 * 1024;
const env = getEnv();

type DriveSyncStatus = "idle" | "running" | "success" | "warning" | "error";

type GoogleDriveTokenCache = {
  accessToken: string;
  expiresAt: number;
};

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  md5Checksum?: string;
  size?: string;
};

type DriveDownloadSpec = {
  filename: string;
  mimeType: string;
  url: string;
};

export type DriveLinkedParsedFile = {
  fileId: string;
  name: string;
  mimeType: string;
  parsedUploads: ParsedUpload[];
};

type DriveSyncFileState = {
  file_id: string;
  file_name: string;
  mime_type: string;
  fingerprint: string;
  modified_time: string | null;
  last_seen_at: string;
  last_synced_at: string | null;
  last_status: string;
  last_error: string;
  request_id: number | null;
  updated_at: string;
};

export type DriveSyncDiagnostics = {
  enabled: boolean;
  configured: boolean;
  folder_id: string | null;
  service_account_email: string | null;
  interval_minutes: number;
  file_limit: number;
  state: {
    status: DriveSyncStatus;
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
  recent_files: DriveSyncFileState[];
};

export type DriveSyncRunResult = {
  ok: boolean;
  skipped: "disabled" | "not_configured" | "not_due" | "busy" | null;
  status: DriveSyncStatus;
  summary: string;
  diagnostics: DriveSyncDiagnostics;
};

let tokenCache: GoogleDriveTokenCache | null = null;
let syncInFlight: Promise<DriveSyncRunResult> | null = null;

function normalizedPrivateKey() {
  return env.googleDrivePrivateKey?.replace(/\\n/g, "\n").trim() || null;
}

function isDriveSyncConfigured() {
  return Boolean(
    env.googleDriveSyncEnabled &&
      env.googleDriveFolderId &&
      env.googleDriveServiceAccountEmail &&
      normalizedPrivateKey(),
  );
}

function isDriveLinkAccessConfigured() {
  return Boolean(
    env.googleDriveServiceAccountEmail &&
      normalizedPrivateKey(),
  );
}

function base64UrlEncode(input: Buffer | string) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildServiceAccountAssertion() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: env.googleDriveServiceAccountEmail,
    scope: DRIVE_READONLY_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: issuedAt + 3600,
    iat: issuedAt,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizedPrivateKey() || "");
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getDriveAccessToken() {
  if (tokenCache && tokenCache.expiresAt - Date.now() > 60_000) {
    return tokenCache.accessToken;
  }

  const assertion = buildServiceAccountAssertion();
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const raw = (await response.text()).slice(0, 500);
    throw new Error(`Google token request failed (${response.status}): ${raw}`);
  }

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Google token response did not include an access token.");
  }

  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in || 3600)) * 1000,
  };
  return tokenCache.accessToken;
}

async function fetchDriveJson<T>(url: URL, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const raw = (await response.text()).slice(0, 500);
    throw new Error(`Google Drive API failed (${response.status}): ${raw}`);
  }
  return (await response.json()) as T;
}

async function listDriveFiles(accessToken: string): Promise<DriveFileMeta[]> {
  const files: DriveFileMeta[] = [];
  let pageToken = "";

  while (files.length < env.googleDriveSyncFileLimit) {
    const url = new URL(DRIVE_API_BASE);
    url.searchParams.set(
      "q",
      `'${env.googleDriveFolderId}' in parents and trashed = false`,
    );
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)",
    );
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set(
      "pageSize",
      String(Math.min(env.googleDriveSyncFileLimit, 200)),
    );
    url.searchParams.set("supportsAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const json = await fetchDriveJson<{
      nextPageToken?: string;
      files?: DriveFileMeta[];
    }>(url, accessToken);
    for (const file of json.files || []) {
      files.push(file);
      if (files.length >= env.googleDriveSyncFileLimit) break;
    }

    if (!json.nextPageToken || files.length >= env.googleDriveSyncFileLimit) {
      break;
    }
    pageToken = json.nextPageToken;
  }

  return files;
}

async function getDriveFileMeta(
  accessToken: string,
  fileId: string,
): Promise<DriveFileMeta> {
  const url = new URL(`${DRIVE_API_BASE}/${encodeURIComponent(fileId)}`);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,md5Checksum,size",
  );
  url.searchParams.set("supportsAllDrives", "true");
  return fetchDriveJson<DriveFileMeta>(url, accessToken);
}

function extensionOf(filename: string) {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

function isSupportedBlobFile(name: string, mimeType: string) {
  const extension = extensionOf(name);
  return (
    ["xlsx", "xlsm", "csv", "pdf", "png", "jpg", "jpeg", "webp", "gif", "txt", "md", "log"].includes(
      extension,
    ) ||
    mimeType === "text/csv" ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("text/")
  );
}

function resolveDriveDownloadSpec(file: DriveFileMeta): DriveDownloadSpec | null {
  const encodedId = encodeURIComponent(file.id);
  const baseName = file.name.trim() || file.id;

  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    return {
      filename: `${baseName}.xlsx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      url: `${DRIVE_API_BASE}/${encodedId}/export?mimeType=${encodeURIComponent(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )}&supportsAllDrives=true`,
    };
  }
  if (file.mimeType === "application/vnd.google-apps.document") {
    return {
      filename: `${baseName}.md`,
      mimeType: "text/markdown",
      url: `${DRIVE_API_BASE}/${encodedId}/export?mimeType=${encodeURIComponent(
        "text/markdown",
      )}&supportsAllDrives=true`,
    };
  }
  if (file.mimeType === "application/vnd.google-apps.presentation") {
    return {
      filename: `${baseName}.pdf`,
      mimeType: "application/pdf",
      url: `${DRIVE_API_BASE}/${encodedId}/export?mimeType=${encodeURIComponent(
        "application/pdf",
      )}&supportsAllDrives=true`,
    };
  }
  if (file.mimeType === "application/vnd.google-apps.drawing") {
    return {
      filename: `${baseName}.png`,
      mimeType: "image/png",
      url: `${DRIVE_API_BASE}/${encodedId}/export?mimeType=${encodeURIComponent(
        "image/png",
      )}&supportsAllDrives=true`,
    };
  }
  if (isSupportedBlobFile(baseName, file.mimeType)) {
    return {
      filename: baseName,
      mimeType: file.mimeType,
      url: `${DRIVE_API_BASE}/${encodedId}?alt=media&supportsAllDrives=true`,
    };
  }
  return null;
}

function buildFingerprint(file: DriveFileMeta) {
  return [
    file.mimeType || "",
    file.modifiedTime || "",
    file.md5Checksum || "",
    file.size || "",
    file.name || "",
  ].join("|");
}

function asStatus(value: unknown): DriveSyncStatus {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "success") return "success";
  if (normalized === "warning") return "warning";
  if (normalized === "error") return "error";
  return "idle";
}

async function readTrackedFiles(fileIds: string[]) {
  if (fileIds.length === 0) return new Map<string, DriveSyncFileState>();
  const result = await queryNeon<DriveSyncFileState>(
    `
      SELECT *
      FROM travel_drive_sync_files
      WHERE file_id = ANY($1::text[])
    `,
    [fileIds],
  );
  const map = new Map<string, DriveSyncFileState>();
  for (const row of result?.rows || []) {
    map.set(row.file_id, row);
  }
  return map;
}

async function upsertTrackedFile(input: {
  file: DriveFileMeta;
  fingerprint: string;
  status: string;
  error?: string;
  requestId?: number | null;
}) {
  await queryNeon(
    `
      INSERT INTO travel_drive_sync_files (
        file_id,
        file_name,
        mime_type,
        fingerprint,
        modified_time,
        last_seen_at,
        last_synced_at,
        last_status,
        last_error,
        request_id,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5::timestamptz, NOW(), NOW(), $6, $7, $8, NOW()
      )
      ON CONFLICT (file_id)
      DO UPDATE SET
        file_name = EXCLUDED.file_name,
        mime_type = EXCLUDED.mime_type,
        fingerprint = EXCLUDED.fingerprint,
        modified_time = EXCLUDED.modified_time,
        last_seen_at = NOW(),
        last_synced_at = NOW(),
        last_status = EXCLUDED.last_status,
        last_error = EXCLUDED.last_error,
        request_id = EXCLUDED.request_id,
        updated_at = NOW()
    `,
    [
      input.file.id,
      input.file.name,
      input.file.mimeType,
      input.fingerprint,
      input.file.modifiedTime || null,
      input.status,
      (input.error || "").slice(0, 4000),
      input.requestId ?? null,
    ],
  );
}

async function markFileSeenOnly(file: DriveFileMeta, fingerprint: string) {
  await queryNeon(
    `
      INSERT INTO travel_drive_sync_files (
        file_id,
        file_name,
        mime_type,
        fingerprint,
        modified_time,
        last_seen_at,
        last_status,
        last_error,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), 'unchanged', '', NOW())
      ON CONFLICT (file_id)
      DO UPDATE SET
        file_name = EXCLUDED.file_name,
        mime_type = EXCLUDED.mime_type,
        fingerprint = EXCLUDED.fingerprint,
        modified_time = EXCLUDED.modified_time,
        last_seen_at = NOW(),
        updated_at = NOW()
    `,
    [file.id, file.name, file.mimeType, fingerprint, file.modifiedTime || null],
  );
}

async function writeSyncState(input: {
  status: DriveSyncStatus;
  lastError?: string;
  lastSummary?: string;
  lastRunId?: string;
  filesExamined?: number;
  filesChanged?: number;
  filesApplied?: number;
  filesBlocked?: number;
  markChecked?: boolean;
}) {
  await queryNeon(
    `
      UPDATE travel_drive_sync_state
      SET
        last_status = $1,
        last_error = $2,
        last_summary = $3,
        last_run_id = $4,
        files_examined = $5,
        files_changed = $6,
        files_applied = $7,
        files_blocked = $8,
        last_checked_at = CASE WHEN $9 THEN NOW() ELSE last_checked_at END,
        last_synced_at = CASE WHEN $9 THEN NOW() ELSE last_synced_at END,
        updated_at = NOW()
      WHERE id = TRUE
    `,
    [
      input.status,
      (input.lastError || "").slice(0, 4000),
      (input.lastSummary || "").slice(0, 4000),
      input.lastRunId || "",
      input.filesExamined ?? 0,
      input.filesChanged ?? 0,
      input.filesApplied ?? 0,
      input.filesBlocked ?? 0,
      Boolean(input.markChecked),
    ],
  );
}

export async function getDriveSyncDiagnostics(): Promise<DriveSyncDiagnostics> {
  const configured = isDriveSyncConfigured();
  const ready = await ensureTravelSchema();
  if (!ready) {
    return {
      enabled: env.googleDriveSyncEnabled,
      configured,
      folder_id: env.googleDriveFolderId,
      service_account_email: env.googleDriveServiceAccountEmail,
      interval_minutes: env.googleDriveSyncIntervalMinutes,
      file_limit: env.googleDriveSyncFileLimit,
      state: {
        status: "idle",
        last_checked_at: null,
        last_synced_at: null,
        last_error: "Database is not configured.",
        last_summary: "",
        last_run_id: "",
        files_examined: 0,
        files_changed: 0,
        files_applied: 0,
        files_blocked: 0,
        updated_at: null,
      },
      recent_files: [],
    };
  }

  const [stateResult, filesResult] = await Promise.all([
    queryNeon<Record<string, unknown>>(
      `
        SELECT *
        FROM travel_drive_sync_state
        WHERE id = TRUE
        LIMIT 1
      `,
    ),
    queryNeon<DriveSyncFileState>(
      `
        SELECT *
        FROM travel_drive_sync_files
        ORDER BY updated_at DESC
        LIMIT 8
      `,
    ),
  ]);

  const row = stateResult?.rows?.[0] || {};
  return {
    enabled: env.googleDriveSyncEnabled,
    configured,
    folder_id: env.googleDriveFolderId,
    service_account_email: env.googleDriveServiceAccountEmail,
    interval_minutes: env.googleDriveSyncIntervalMinutes,
    file_limit: env.googleDriveSyncFileLimit,
    state: {
      status: asStatus(row.last_status),
      last_checked_at: row.last_checked_at ? String(row.last_checked_at) : null,
      last_synced_at: row.last_synced_at ? String(row.last_synced_at) : null,
      last_error: String(row.last_error || ""),
      last_summary: String(row.last_summary || ""),
      last_run_id: String(row.last_run_id || ""),
      files_examined: Number(row.files_examined || 0),
      files_changed: Number(row.files_changed || 0),
      files_applied: Number(row.files_applied || 0),
      files_blocked: Number(row.files_blocked || 0),
      updated_at: row.updated_at ? String(row.updated_at) : null,
    },
    recent_files: filesResult?.rows || [],
  };
}

async function shouldSkipForInterval(force: boolean) {
  if (force) return false;
  const diagnostics = await getDriveSyncDiagnostics();
  const lastCheckedAt = diagnostics.state.last_checked_at
    ? new Date(diagnostics.state.last_checked_at).getTime()
    : 0;
  if (!lastCheckedAt) return false;
  const dueAfterMs = env.googleDriveSyncIntervalMinutes * 60 * 1000;
  return Date.now() - lastCheckedAt < dueAfterMs;
}

async function downloadDriveFile(
  accessToken: string,
  spec: DriveDownloadSpec,
): Promise<Buffer> {
  const response = await fetch(spec.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const raw = (await response.text()).slice(0, 500);
    throw new Error(
      `Google Drive download failed (${response.status}) for ${spec.filename}: ${raw}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error(`Downloaded file is empty: ${spec.filename}`);
  }
  return buffer;
}

async function createPdfChunk(
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

async function splitDrivePdfForParsing(
  filename: string,
  buffer: Buffer,
): Promise<Array<{ filename: string; mimeType: string; dataBase64: string }>> {
  if (buffer.byteLength <= DRIVE_LINK_PDF_CHUNK_BYTES) {
    return [
      {
        filename,
        mimeType: "application/pdf",
        dataBase64: buffer.toString("base64"),
      },
    ];
  }

  const { PDFDocument } = await import("pdf-lib");
  const sourcePdf = await PDFDocument.load(buffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const uploads: Array<{ filename: string; mimeType: string; dataBase64: string }> =
    [];
  let currentPages: number[] = [];

  const flush = async () => {
    if (currentPages.length === 0) return;
    const chunkBytes = await createPdfChunk(sourcePdf, currentPages);
    uploads.push({
      filename: `${filename}.part-${String(uploads.length + 1).padStart(3, "0")}.pdf`,
      mimeType: "application/pdf",
      dataBase64: Buffer.from(chunkBytes).toString("base64"),
    });
    currentPages = [];
  };

  for (let pageIndex = 0; pageIndex < sourcePdf.getPageCount(); pageIndex += 1) {
    const candidatePages = [...currentPages, pageIndex];
    const candidateBytes = await createPdfChunk(sourcePdf, candidatePages);
    if (
      candidateBytes.byteLength > DRIVE_LINK_PDF_CHUNK_BYTES &&
      currentPages.length > 0
    ) {
      await flush();
      currentPages = [pageIndex];
      continue;
    }
    currentPages = candidatePages;
  }

  await flush();
  return uploads;
}

async function buildDriveParseUploads(
  spec: DriveDownloadSpec,
  buffer: Buffer,
): Promise<Array<{ filename: string; mimeType: string; dataBase64: string }>> {
  if (spec.mimeType === "application/pdf") {
    return splitDrivePdfForParsing(spec.filename, buffer);
  }
  return [
    {
      filename: spec.filename,
      mimeType: spec.mimeType,
      dataBase64: buffer.toString("base64"),
    },
  ];
}

export { extractGoogleDriveFileIds };

export function canReadGoogleDriveLinks() {
  return isDriveLinkAccessConfigured();
}

export async function parseGoogleDriveFileId(
  fileId: string,
): Promise<DriveLinkedParsedFile> {
  if (!isDriveLinkAccessConfigured()) {
    throw new Error("Google Drive service account credentials are not configured.");
  }

  const accessToken = await getDriveAccessToken();
  const file = await getDriveFileMeta(accessToken, fileId);
  const spec = resolveDriveDownloadSpec(file);
  if (!spec) {
    throw new Error(`Unsupported Google Drive file type: ${file.mimeType}`);
  }

  const buffer = await downloadDriveFile(accessToken, spec);
  const uploads = await buildDriveParseUploads(spec, buffer);
  const parsedUploads: ParsedUpload[] = [];
  for (const upload of uploads) {
    parsedUploads.push(await parseUpload(upload));
  }

  return {
    fileId,
    name: file.name,
    mimeType: file.mimeType,
    parsedUploads,
  };
}

async function withDriveSyncLock<T>(task: () => Promise<T>): Promise<T | null> {
  return withNeonClient(async (client) => {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [DRIVE_SYNC_LOCK_ID],
    );
    const locked = Boolean(result.rows[0]?.locked);
    if (!locked) return null;
    try {
      return await task();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [DRIVE_SYNC_LOCK_ID]);
    }
  });
}

async function runDriveFolderSyncInternal(input: {
  force: boolean;
  source: string;
}): Promise<DriveSyncRunResult> {
  if (!env.googleDriveSyncEnabled) {
    return {
      ok: true,
      skipped: "disabled",
      status: "idle",
      summary: "Google Drive sync is disabled.",
      diagnostics: await getDriveSyncDiagnostics(),
    };
  }

  if (!isDriveSyncConfigured()) {
    return {
      ok: false,
      skipped: "not_configured",
      status: "error",
      summary: "Google Drive sync is not configured yet.",
      diagnostics: await getDriveSyncDiagnostics(),
    };
  }

  const ready = await ensureTravelSchema();
  if (!ready) {
    return {
      ok: false,
      skipped: "not_configured",
      status: "error",
      summary: "Database is not configured.",
      diagnostics: await getDriveSyncDiagnostics(),
    };
  }

  if (await shouldSkipForInterval(input.force)) {
    return {
      ok: true,
      skipped: "not_due",
      status: "idle",
      summary: "Google Drive sync is not due yet.",
      diagnostics: await getDriveSyncDiagnostics(),
    };
  }

  const locked: DriveSyncRunResult | null = await withDriveSyncLock(async () => {
    const runId = randomUUID();
    await writeSyncState({
      status: "running",
      lastRunId: runId,
      lastError: "",
      lastSummary: "Google Drive sync started.",
    });

    let filesExamined = 0;
    let filesChanged = 0;
    let filesApplied = 0;
    let filesBlocked = 0;
    let finalStatus: DriveSyncStatus = "success";
    const summaryLines: string[] = [];

    try {
      const accessToken = await getDriveAccessToken();
      const files = await listDriveFiles(accessToken);
      const trackedFiles = await readTrackedFiles(files.map((file) => file.id));

      for (const file of files) {
        filesExamined += 1;
        const fingerprint = buildFingerprint(file);
        const previous = trackedFiles.get(file.id);

        if (previous?.fingerprint === fingerprint) {
          await markFileSeenOnly(file, fingerprint);
          continue;
        }

        filesChanged += 1;
        const spec = resolveDriveDownloadSpec(file);
        if (!spec) {
          filesBlocked += 1;
          finalStatus = "warning";
          summaryLines.push(`${file.name}: unsupported file type.`);
          await upsertTrackedFile({
            file,
            fingerprint,
            status: "unsupported",
            error: "Unsupported file type for automated extraction.",
          });
          continue;
        }

        try {
          const buffer = await downloadDriveFile(accessToken, spec);
          const parsed = await parseUpload({
            filename: spec.filename,
            mimeType: spec.mimeType,
            dataBase64: buffer.toString("base64"),
          });
          const note = [
            "Automatic sync from Google Drive folder.",
            `File: ${file.name}`,
            `Modified: ${file.modifiedTime}`,
            "Only extract confirmed travel inventory changes.",
          ].join(" ");
          const proposalResult = await generateAIProposalFromContentBatched({
            note,
            sources: [
              {
                label: parsed.label,
                contentText: parsed.text || undefined,
                inline: parsed.inline,
              },
            ],
          });

          const requestId = proposalResult.request_id;
          if (proposalResult.proposal.actions.length === 0) {
            summaryLines.push(`${file.name}: no actionable trip changes found.`);
            await upsertTrackedFile({
              file,
              fingerprint,
              status: "no_changes",
              requestId,
            });
            continue;
          }

          if (
            requestId &&
            proposalResult.proposal.needs_confirmation === false &&
            proposalResult.proposal.conflicts.length === 0
          ) {
            const applied = await applyAIRequest(requestId);
            if (applied.ok) {
              filesApplied += 1;
              summaryLines.push(`${file.name}: changes applied automatically.`);
              await upsertTrackedFile({
                file,
                fingerprint,
                status: "applied",
                requestId,
              });
              continue;
            }

            filesBlocked += 1;
            finalStatus = "warning";
            summaryLines.push(`${file.name}: apply failed, manual review needed.`);
            await upsertTrackedFile({
              file,
              fingerprint,
              status: "review_required",
              error: applied.message,
              requestId,
            });
            continue;
          }

          filesBlocked += 1;
          finalStatus = "warning";
          summaryLines.push(`${file.name}: manual review required.`);
          await upsertTrackedFile({
            file,
            fingerprint,
            status: "review_required",
            error:
              proposalResult.proposal.conflicts[0] ||
              proposalResult.proposal.important_reason ||
              "Confirmation required before applying.",
            requestId,
          });
        } catch (error) {
          filesBlocked += 1;
          finalStatus = "warning";
          const message = error instanceof Error ? error.message : String(error);
          summaryLines.push(`${file.name}: ${message}`);
          await upsertTrackedFile({
            file,
            fingerprint,
            status: "error",
            error: message,
          });
        }
      }

      if (filesChanged === 0) {
        summaryLines.push("No changed Google Drive files were found.");
      }
      const summary = summaryLines.join(" ").slice(0, 3500);
      await writeSyncState({
        status: finalStatus,
        lastRunId: runId,
        lastError: "",
        lastSummary: summary,
        filesExamined,
        filesChanged,
        filesApplied,
        filesBlocked,
        markChecked: true,
      });

      recordCounter("drive.sync.completed_total", 1, {
        status: finalStatus,
        source: input.source,
      });
      logInfo("drive.sync.completed", {
        source: input.source,
        runId,
        filesExamined,
        filesChanged,
        filesApplied,
        filesBlocked,
        status: finalStatus,
      });

      return {
        ok: true,
        skipped: null,
        status: finalStatus,
        summary,
        diagnostics: await getDriveSyncDiagnostics(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeSyncState({
        status: "error",
        lastRunId: runId,
        lastError: message,
        lastSummary: "Google Drive sync failed.",
        filesExamined,
        filesChanged,
        filesApplied,
        filesBlocked,
        markChecked: true,
      });
      recordCounter("drive.sync.failed_total", 1, { source: input.source });
      logError("drive.sync.failed", {
        source: input.source,
        runId,
        message,
      });
      return {
        ok: false,
        skipped: null,
        status: "error",
        summary: message,
        diagnostics: await getDriveSyncDiagnostics(),
      };
    }
  });

  if (!locked) {
    return {
      ok: true,
      skipped: "busy",
      status: "running",
      summary: "Google Drive sync is already running.",
      diagnostics: await getDriveSyncDiagnostics(),
    };
  }

  return locked;
}

export async function runDriveFolderSync(input: {
  force?: boolean;
  source?: string;
} = {}): Promise<DriveSyncRunResult> {
  if (!syncInFlight) {
    syncInFlight = runDriveFolderSyncInternal({
      force: input.force === true,
      source: input.source || "unknown",
    }).finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

export async function maybeAutoSyncDriveFolder(input: {
  source?: string;
} = {}) {
  if (!env.googleDriveSyncEnabled || !isDriveSyncConfigured()) return;
  try {
    await runDriveFolderSync({
      force: false,
      source: input.source || "passive",
    });
  } catch (error) {
    logError("drive.sync.background_failed", {
      source: input.source || "passive",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
