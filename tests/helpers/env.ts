const REQUIRED_BASE_ENV: Record<string, string> = {
  GEMINI_API_KEY: "test-gemini-key",
  VERIFY_TOKEN: "test-verify-token",
  TOKEN_PAGE: "test-page-token",
  FACEBOOK_PAGE_ID: "1234567890",
  META_APP_SECRET: "test-meta-secret",
  ADMIN_SECRET: "test-admin-secret",
};

const DEFAULT_NUMERIC_ENV: Record<string, string> = {
  DEMO_MAX_TEXT_CHARS: "1000",
  DEMO_GLOBAL_RATE_LIMIT: "240",
  ADMIN_AUTH_RATE_LIMIT: "20",
  WEBHOOK_MAX_BODY_BYTES: "1048576",
  REDIS_CONNECT_TIMEOUT_MS: "1500",
  REDIS_COMMAND_TIMEOUT_MS: "750",
  REDIS_LOCK_TTL_MS: "30000",
  OBSERVABILITY_SINK_TIMEOUT_MS: "2000",
  OBSERVABILITY_SINK_BATCH_SIZE: "20",
  RATE_LIMIT_MAX_BUCKETS: "20000",
  RATE_LIMIT_SWEEP_INTERVAL: "1",
  CONVERSATION_MAX_SESSIONS: "5000",
  PAUSE_MAX_SENDERS: "5000",
  GEMINI_TIMEOUT_MS: "2000",
  GEMINI_MAX_RETRIES: "1",
  GEMINI_RETRY_BASE_DELAY_MS: "50",
  GEMINI_CIRCUIT_FAILURE_THRESHOLD: "2",
  GEMINI_CIRCUIT_COOLDOWN_MS: "1000",
  META_API_TIMEOUT_MS: "2000",
  META_SUBSCRIBE_MAX_RETRIES: "1",
  META_RETRY_BASE_DELAY_MS: "50",
  WEBHOOK_MAX_PENDING_CONVERSATIONS: "5000",
  GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES: "30",
  GOOGLE_DRIVE_SYNC_FILE_LIMIT: "50",
};

const DEFAULT_BOOLEAN_ENV: Record<string, string> = {
  ADMIN_OPEN_ACCESS: "false",
  TRUST_PROXY_HEADERS: "true",
  ALLOW_ADMIN_SECRET_QUERY: "false",
  REDIS_STATE_ENABLED: "false",
  REDIS_RATE_LIMIT_ENABLED: "false",
  REDIS_REPLAY_ENABLED: "false",
  REDIS_CONVERSATION_ENABLED: "false",
  REDIS_PAUSE_ENABLED: "false",
  GOOGLE_DRIVE_SYNC_ENABLED: "false",
};

const DEFAULT_OPTIONAL_ENV: Record<string, string> = {
  NODE_ENV: "test",
  REDIS_KEY_PREFIX: "nexonbot-test",
};

const RESET_ONLY_ENV_KEYS = [
  "AGENCY_NAME",
  "DATABASE_URL",
  "NEON_DATABASE_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "OBSERVABILITY_LOG_SINK_URL",
  "OBSERVABILITY_ERROR_SINK_URL",
  "OBSERVABILITY_SINK_TOKEN",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
];

const KNOWN_TEST_ENV_KEYS = [
  ...Object.keys(REQUIRED_BASE_ENV),
  ...Object.keys(DEFAULT_NUMERIC_ENV),
  ...Object.keys(DEFAULT_BOOLEAN_ENV),
  ...Object.keys(DEFAULT_OPTIONAL_ENV),
  ...RESET_ONLY_ENV_KEYS,
];

export function applyTestEnv(overrides: Record<string, string | undefined> = {}) {
  for (const key of KNOWN_TEST_ENV_KEYS) {
    delete process.env[key];
  }

  Object.assign(
    process.env,
    REQUIRED_BASE_ENV,
    DEFAULT_NUMERIC_ENV,
    DEFAULT_BOOLEAN_ENV,
    DEFAULT_OPTIONAL_ENV,
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
