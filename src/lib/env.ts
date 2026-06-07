import { logStartupDiagnostics } from "./observability";

export type ValidatedEnv = {
  agencyName: string;
  geminiApiKey: string;
  verifyToken: string;
  tokenPage: string;
  facebookPageId: string;
  metaAppSecret: string;
  adminSecret: string;
  adminOpenAccess: boolean;
  allowAdminSecretQuery: boolean;
  trustProxyHeaders: boolean;
  neonDatabaseUrl: string | null;
  redisStateEnabled: boolean;
  redisRateLimitEnabled: boolean;
  redisReplayEnabled: boolean;
  redisConversationEnabled: boolean;
  redisPauseEnabled: boolean;
  redisUrl: string | null;
  redisKeyPrefix: string;
  redisConnectTimeoutMs: number;
  redisCommandTimeoutMs: number;
  redisLockTtlMs: number;
  observabilityLogSinkUrl: string | null;
  observabilityErrorSinkUrl: string | null;
  observabilitySinkToken: string | null;
  observabilitySinkTimeoutMs: number;
  observabilitySinkBatchSize: number;
  demoMaxTextChars: number;
  demoGlobalRateLimit: number;
  adminAuthRateLimit: number;
  webhookMaxBodyBytes: number;
  rateLimitMaxBuckets: number;
  rateLimitSweepInterval: number;
  conversationMaxSessions: number;
  pauseMaxSenders: number;
  geminiTimeoutMs: number;
  geminiMaxRetries: number;
  geminiRetryBaseDelayMs: number;
  geminiCircuitFailureThreshold: number;
  geminiCircuitCooldownMs: number;
  metaApiTimeoutMs: number;
  metaSubscribeMaxRetries: number;
  metaRetryBaseDelayMs: number;
  webhookMaxPendingConversations: number;
  staffNotifyPsids: string[];
  googleDriveSyncEnabled: boolean;
  googleDriveFolderId: string | null;
  googleDriveServiceAccountEmail: string | null;
  googleDrivePrivateKey: string | null;
  googleDriveSyncIntervalMinutes: number;
  googleDriveSyncFileLimit: number;
};

let cachedEnv: ValidatedEnv | null = null;

function readRequiredString(
  name: string,
  source: NodeJS.ProcessEnv,
  errors: string[],
): string {
  const raw = source[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    errors.push(`${name} is required and must be a non-empty string`);
    return "";
  }
  return raw.trim();
}

function readOptionalString(
  name: string,
  source: NodeJS.ProcessEnv,
): string | null {
  const raw = source[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function buildRedisUrlFromUpstashRest(
  source: NodeJS.ProcessEnv,
  errors: string[],
): string | null {
  const restUrl = readOptionalString("UPSTASH_REDIS_REST_URL", source);
  const restToken = readOptionalString("UPSTASH_REDIS_REST_TOKEN", source);
  if (!restUrl && !restToken) return null;

  if (!restUrl || !restToken) {
    errors.push(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together",
    );
    return null;
  }

  try {
    const parsed = new URL(restUrl);
    if (parsed.protocol !== "https:") {
      errors.push("UPSTASH_REDIS_REST_URL must start with https://");
      return null;
    }
    const host = parsed.hostname;
    if (!host) {
      errors.push("UPSTASH_REDIS_REST_URL must include a host");
      return null;
    }
    const encodedToken = encodeURIComponent(restToken);
    return `rediss://default:${encodedToken}@${host}:6379`;
  } catch {
    errors.push("UPSTASH_REDIS_REST_URL must be a valid URL");
    return null;
  }
}

function readRequiredStringFromNames(
  names: string[],
  source: NodeJS.ProcessEnv,
  errors: string[],
): string {
  for (const name of names) {
    const raw = source[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  const primary = names[0];
  const aliases = names.slice(1);
  if (aliases.length) {
    errors.push(
      `${primary} is required and must be a non-empty string (accepted aliases: ${aliases.join(", ")})`,
    );
  } else {
    errors.push(`${primary} is required and must be a non-empty string`);
  }
  return "";
}

function readBoolean(
  name: string,
  source: NodeJS.ProcessEnv,
  defaultValue: boolean,
  errors: string[],
): boolean {
  const raw = source[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  errors.push(`${name} must be "true" or "false"`);
  return defaultValue;
}

function readPositiveInt(
  name: string,
  source: NodeJS.ProcessEnv,
  defaultValue: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = source[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    errors.push(`${name} must be an integer`);
    return defaultValue;
  }
  if (parsed < min) {
    errors.push(`${name} must be >= ${min}`);
    return defaultValue;
  }
  if (parsed > max) {
    errors.push(`${name} must be <= ${max}`);
    return defaultValue;
  }
  return parsed;
}

function readPositiveIntFromNames(
  names: string[],
  source: NodeJS.ProcessEnv,
  defaultValue: number,
  min: number,
  max: number,
  errors: string[],
): number {
  for (const name of names) {
    const raw = source[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return readPositiveInt(name, source, defaultValue, min, max, errors);
    }
  }
  return defaultValue;
}

export function getEnv(): ValidatedEnv {
  if (cachedEnv) return cachedEnv;

  const source = process.env;
  const errors: string[] = [];

  const agencyName =
    readOptionalString("AGENCY_NAME", source) || "Travel Agency";
  const geminiApiKey = readRequiredStringFromNames(
    ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    source,
    errors,
  );
  const verifyToken = readRequiredString("VERIFY_TOKEN", source, errors);
  const tokenPage = readRequiredString("TOKEN_PAGE", source, errors);
  const facebookPageId = readRequiredString("FACEBOOK_PAGE_ID", source, errors);
  const metaAppSecret = readRequiredStringFromNames(
    ["META_APP_SECRET", "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_SECRET_KEY"],
    source,
    errors,
  );
  const adminSecret = readRequiredString("ADMIN_SECRET", source, errors);
  const adminOpenAccess = readBoolean(
    "ADMIN_OPEN_ACCESS",
    source,
    false,
    errors,
  );
  const neonDatabaseUrl =
    readOptionalString("NEON_DATABASE_URL", source) ||
    readOptionalString("DATABASE_URL", source);

  const trustProxyHeaders = readBoolean(
    "TRUST_PROXY_HEADERS",
    source,
    Boolean(source.VERCEL),
    errors,
  );
  const allowAdminSecretQuery = readBoolean(
    "ALLOW_ADMIN_SECRET_QUERY",
    source,
    false,
    errors,
  );
  const redisConfigured = Boolean(
    source.REDIS_URL ||
      (source.UPSTASH_REDIS_REST_URL && source.UPSTASH_REDIS_REST_TOKEN),
  );
  const redisStateEnabled = readBoolean(
    "REDIS_STATE_ENABLED",
    source,
    redisConfigured,
    errors,
  );
  const redisRateLimitEnabled = readBoolean(
    "REDIS_RATE_LIMIT_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisReplayEnabled = readBoolean(
    "REDIS_REPLAY_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisConversationEnabled = readBoolean(
    "REDIS_CONVERSATION_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisPauseEnabled = readBoolean(
    "REDIS_PAUSE_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisUrl =
    readOptionalString("REDIS_URL", source) ||
    buildRedisUrlFromUpstashRest(source, errors);
  const redisKeyPrefix =
    readOptionalString("REDIS_KEY_PREFIX", source) || "travelbot";

  const redisConnectTimeoutMs = readPositiveInt(
    "REDIS_CONNECT_TIMEOUT_MS",
    source,
    1500,
    100,
    30000,
    errors,
  );
  const redisCommandTimeoutMs = readPositiveInt(
    "REDIS_COMMAND_TIMEOUT_MS",
    source,
    750,
    50,
    10000,
    errors,
  );
  const redisLockTtlMs = readPositiveInt(
    "REDIS_LOCK_TTL_MS",
    source,
    30000,
    5000,
    300000,
    errors,
  );

  const observabilityLogSinkUrl = readOptionalString(
    "OBSERVABILITY_LOG_SINK_URL",
    source,
  );
  const observabilityErrorSinkUrl = readOptionalString(
    "OBSERVABILITY_ERROR_SINK_URL",
    source,
  );
  const observabilitySinkToken = readOptionalString(
    "OBSERVABILITY_SINK_TOKEN",
    source,
  );
  const observabilitySinkTimeoutMs = readPositiveInt(
    "OBSERVABILITY_SINK_TIMEOUT_MS",
    source,
    2000,
    100,
    10000,
    errors,
  );
  const observabilitySinkBatchSize = readPositiveInt(
    "OBSERVABILITY_SINK_BATCH_SIZE",
    source,
    20,
    1,
    200,
    errors,
  );

  const demoMaxTextChars = readPositiveInt(
    "DEMO_MAX_TEXT_CHARS",
    source,
    1000,
    1,
    10000,
    errors,
  );
  const demoGlobalRateLimit = readPositiveInt(
    "DEMO_GLOBAL_RATE_LIMIT",
    source,
    240,
    1,
    100000,
    errors,
  );
  const adminAuthRateLimit = readPositiveInt(
    "ADMIN_AUTH_RATE_LIMIT",
    source,
    20,
    1,
    100000,
    errors,
  );
  const webhookMaxBodyBytes = readPositiveInt(
    "WEBHOOK_MAX_BODY_BYTES",
    source,
    1024 * 1024,
    64 * 1024,
    4 * 1024 * 1024,
    errors,
  );
  const rateLimitMaxBuckets = readPositiveInt(
    "RATE_LIMIT_MAX_BUCKETS",
    source,
    20000,
    1000,
    200000,
    errors,
  );
  const rateLimitSweepInterval = readPositiveInt(
    "RATE_LIMIT_SWEEP_INTERVAL",
    source,
    200,
    1,
    100000,
    errors,
  );
  const conversationMaxSessions = readPositiveInt(
    "CONVERSATION_MAX_SESSIONS",
    source,
    5000,
    100,
    50000,
    errors,
  );
  const pauseMaxSenders = readPositiveInt(
    "PAUSE_MAX_SENDERS",
    source,
    5000,
    100,
    50000,
    errors,
  );
  const geminiTimeoutMs = readPositiveIntFromNames(
    ["GEMINI_TIMEOUT_MS", "OPENAI_TIMEOUT_MS"],
    source,
    15_000,
    1_000,
    60_000,
    errors,
  );
  const geminiMaxRetries = readPositiveIntFromNames(
    ["GEMINI_MAX_RETRIES", "OPENAI_MAX_RETRIES"],
    source,
    2,
    0,
    5,
    errors,
  );
  const geminiRetryBaseDelayMs = readPositiveIntFromNames(
    ["GEMINI_RETRY_BASE_DELAY_MS", "OPENAI_RETRY_BASE_DELAY_MS"],
    source,
    300,
    50,
    10_000,
    errors,
  );
  const geminiCircuitFailureThreshold = readPositiveIntFromNames(
    ["GEMINI_CIRCUIT_FAILURE_THRESHOLD", "OPENAI_CIRCUIT_FAILURE_THRESHOLD"],
    source,
    5,
    1,
    50,
    errors,
  );
  const geminiCircuitCooldownMs = readPositiveIntFromNames(
    ["GEMINI_CIRCUIT_COOLDOWN_MS", "OPENAI_CIRCUIT_COOLDOWN_MS"],
    source,
    30_000,
    1_000,
    300_000,
    errors,
  );
  const metaApiTimeoutMs = readPositiveInt(
    "META_API_TIMEOUT_MS",
    source,
    12_000,
    1_000,
    60_000,
    errors,
  );
  const metaSubscribeMaxRetries = readPositiveInt(
    "META_SUBSCRIBE_MAX_RETRIES",
    source,
    1,
    0,
    5,
    errors,
  );
  const metaRetryBaseDelayMs = readPositiveInt(
    "META_RETRY_BASE_DELAY_MS",
    source,
    300,
    50,
    10_000,
    errors,
  );
  const webhookMaxPendingConversations = readPositiveInt(
    "WEBHOOK_MAX_PENDING_CONVERSATIONS",
    source,
    5000,
    100,
    100_000,
    errors,
  );
  const staffNotifyPsids = (readOptionalString("STAFF_NOTIFY_PSIDS", source) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const googleDriveSyncEnabled = readBoolean(
    "GOOGLE_DRIVE_SYNC_ENABLED",
    source,
    false,
    errors,
  );
  const googleDriveFolderId = readOptionalString("GOOGLE_DRIVE_FOLDER_ID", source);
  const googleDriveServiceAccountEmail = readOptionalString(
    "GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL",
    source,
  );
  const googleDrivePrivateKey = readOptionalString(
    "GOOGLE_DRIVE_PRIVATE_KEY",
    source,
  );
  const googleDriveSyncIntervalMinutes = readPositiveInt(
    "GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES",
    source,
    30,
    1,
    24 * 60,
    errors,
  );
  const googleDriveSyncFileLimit = readPositiveInt(
    "GOOGLE_DRIVE_SYNC_FILE_LIMIT",
    source,
    50,
    1,
    500,
    errors,
  );

  const anyRedisFeatureEnabled =
    redisRateLimitEnabled ||
    redisReplayEnabled ||
    redisConversationEnabled ||
    redisPauseEnabled;
  if (anyRedisFeatureEnabled && !redisUrl) {
    errors.push(
      "REDIS_URL is required when any REDIS_*_ENABLED feature flag is true",
    );
  }
  if (adminOpenAccess && source.NODE_ENV === "production") {
    errors.push(
      "ADMIN_OPEN_ACCESS cannot be true in production. Set ADMIN_OPEN_ACCESS=false and require authenticated admin access.",
    );
  }
  if (
    googleDriveSyncEnabled &&
    (!googleDriveFolderId ||
      !googleDriveServiceAccountEmail ||
      !googleDrivePrivateKey)
  ) {
    errors.push(
      "GOOGLE_DRIVE_SYNC_ENABLED requires GOOGLE_DRIVE_FOLDER_ID, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_DRIVE_PRIVATE_KEY",
    );
  }

  if (errors.length) {
    throw new Error(
      `Invalid server environment configuration:\n- ${errors.join("\n- ")}`,
    );
  }

  cachedEnv = {
    geminiApiKey,
    verifyToken,
    tokenPage,
    facebookPageId,
    metaAppSecret,
    adminSecret,
    adminOpenAccess,
    allowAdminSecretQuery,
    trustProxyHeaders,
    neonDatabaseUrl,
    agencyName,
    redisStateEnabled,
    redisRateLimitEnabled,
    redisReplayEnabled,
    redisConversationEnabled,
    redisPauseEnabled,
    redisUrl,
    redisKeyPrefix,
    redisConnectTimeoutMs,
    redisCommandTimeoutMs,
    redisLockTtlMs,
    observabilityLogSinkUrl,
    observabilityErrorSinkUrl,
    observabilitySinkToken,
    observabilitySinkTimeoutMs,
    observabilitySinkBatchSize,
    demoMaxTextChars,
    demoGlobalRateLimit,
    adminAuthRateLimit,
    webhookMaxBodyBytes,
    rateLimitMaxBuckets,
    rateLimitSweepInterval,
    conversationMaxSessions,
    pauseMaxSenders,
    geminiTimeoutMs,
    geminiMaxRetries,
    geminiRetryBaseDelayMs,
    geminiCircuitFailureThreshold,
    geminiCircuitCooldownMs,
    metaApiTimeoutMs,
    metaSubscribeMaxRetries,
    metaRetryBaseDelayMs,
    webhookMaxPendingConversations,
    staffNotifyPsids,
    googleDriveSyncEnabled,
    googleDriveFolderId,
    googleDriveServiceAccountEmail,
    googleDrivePrivateKey,
    googleDriveSyncIntervalMinutes,
    googleDriveSyncFileLimit,
  };

  logStartupDiagnostics("env", {
    trustProxyHeaders: cachedEnv.trustProxyHeaders,
    allowAdminSecretQuery: cachedEnv.allowAdminSecretQuery,
    redisStateEnabled: cachedEnv.redisStateEnabled,
    redisRateLimitEnabled: cachedEnv.redisRateLimitEnabled,
    redisReplayEnabled: cachedEnv.redisReplayEnabled,
    redisConversationEnabled: cachedEnv.redisConversationEnabled,
    redisPauseEnabled: cachedEnv.redisPauseEnabled,
    redisConfigured: Boolean(cachedEnv.redisUrl),
    redisKeyPrefix: cachedEnv.redisKeyPrefix,
    redisConnectTimeoutMs: cachedEnv.redisConnectTimeoutMs,
    redisCommandTimeoutMs: cachedEnv.redisCommandTimeoutMs,
    redisLockTtlMs: cachedEnv.redisLockTtlMs,
    observabilityLogSinkEnabled: Boolean(cachedEnv.observabilityLogSinkUrl),
    observabilityErrorSinkEnabled: Boolean(cachedEnv.observabilityErrorSinkUrl),
    observabilitySinkTimeoutMs: cachedEnv.observabilitySinkTimeoutMs,
    observabilitySinkBatchSize: cachedEnv.observabilitySinkBatchSize,
    webhookMaxBodyBytes: cachedEnv.webhookMaxBodyBytes,
    rateLimitMaxBuckets: cachedEnv.rateLimitMaxBuckets,
    conversationMaxSessions: cachedEnv.conversationMaxSessions,
    pauseMaxSenders: cachedEnv.pauseMaxSenders,
    geminiTimeoutMs: cachedEnv.geminiTimeoutMs,
    geminiMaxRetries: cachedEnv.geminiMaxRetries,
    metaApiTimeoutMs: cachedEnv.metaApiTimeoutMs,
    metaSubscribeMaxRetries: cachedEnv.metaSubscribeMaxRetries,
    webhookMaxPendingConversations: cachedEnv.webhookMaxPendingConversations,
    googleDriveSyncEnabled: cachedEnv.googleDriveSyncEnabled,
    googleDriveFolderConfigured: Boolean(cachedEnv.googleDriveFolderId),
    googleDriveServiceAccountConfigured: Boolean(
      cachedEnv.googleDriveServiceAccountEmail &&
        cachedEnv.googleDrivePrivateKey,
    ),
    googleDriveSyncIntervalMinutes: cachedEnv.googleDriveSyncIntervalMinutes,
    googleDriveSyncFileLimit: cachedEnv.googleDriveSyncFileLimit,
    runtime: {
      nodeEnv: source.NODE_ENV || null,
      vercel: Boolean(source.VERCEL),
      vercelEnv: source.VERCEL_ENV || null,
    },
    adminOpenAccess: cachedEnv.adminOpenAccess,
    neonDbConfigured: Boolean(cachedEnv.neonDatabaseUrl),
  });

  return cachedEnv;
}

export function resetEnvCacheForTests() {
  cachedEnv = null;
}
