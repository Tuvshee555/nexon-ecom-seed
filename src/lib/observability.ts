import { createHash, randomUUID } from "crypto";

type Primitive = string | number | boolean | null;
type LogValue = Primitive | LogValue[] | { [key: string]: LogValue };
type Tags = Record<string, string | number | boolean | null | undefined>;
type HeadersLike = Record<string, string | string[] | undefined>;
type SinkTarget = "log" | "error";

export type RequestTrace = {
  requestId: string;
  correlationId: string;
  route: string;
  method: string;
  path: string;
  startedAtMs: number;
};

export type ErrorClassification = {
  category:
    | "timeout"
    | "network"
    | "upstream_4xx"
    | "upstream_5xx"
    | "rate_limited"
    | "unauthorized"
    | "invalid_input"
    | "circuit_open"
    | "unknown";
  retryable: boolean;
  statusCode?: number;
  code?: string;
};

const REDACT_KEY_PATTERN =
  /(authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token_page|page_token|admin_secret|gemini_api_key|google_api_key|meta_app_secret)/i;
const REDACT_EXCEPTIONS = new Set(["allowadminsecretquery"]);
const MAX_LOG_DEPTH = 4;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 60;
const MAX_STRING_LEN = 500;
const GAUGE_ALERT_THRESHOLD = 50_000;
const SERVICE_NAME = "nexon-travel-ai";
const SINK_MAX_QUEUE = 1000;
const SINK_FLUSH_INTERVAL_MS = 2000;

type SinkItem = {
  target: SinkTarget;
  record: Record<string, LogValue>;
};

type CounterMetric = {
  name: string;
  tags: Record<string, string>;
  value: number;
};
type HistogramMetric = {
  name: string;
  tags: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
};
type GaugeMetric = {
  name: string;
  tags: Record<string, string>;
  value: number;
  maxObserved: number;
};

const counters = new Map<string, CounterMetric>();
const histograms = new Map<string, HistogramMetric>();
const gauges = new Map<string, GaugeMetric>();
const startupDiagnosticsFlags = (
  globalThis as typeof globalThis & {
    __startupDiagnosticsFlags?: Set<string>;
  }
).__startupDiagnosticsFlags ?? new Set<string>();
(
  globalThis as typeof globalThis & {
    __startupDiagnosticsFlags?: Set<string>;
  }
).__startupDiagnosticsFlags = startupDiagnosticsFlags;
const sinkQueue: SinkItem[] = [];

let sinkFlushActive = false;
let sinkFlushTimerStarted = false;
let sinkDroppedCount = 0;

function toConsoleMethod(level: "debug" | "info" | "warn" | "error") {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  if (level === "debug") return console.debug;
  return console.info;
}

function toSafeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  return String(value);
}

function optionalEnv(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

const OBSERVABILITY_LOG_SINK_URL = optionalEnv("OBSERVABILITY_LOG_SINK_URL");
const OBSERVABILITY_ERROR_SINK_URL = optionalEnv("OBSERVABILITY_ERROR_SINK_URL");
const OBSERVABILITY_SINK_TOKEN = optionalEnv("OBSERVABILITY_SINK_TOKEN");
const OBSERVABILITY_SINK_TIMEOUT_MS = numberEnv(
  "OBSERVABILITY_SINK_TIMEOUT_MS",
  2000,
  100,
  10000,
);
const OBSERVABILITY_SINK_BATCH_SIZE = numberEnv(
  "OBSERVABILITY_SINK_BATCH_SIZE",
  20,
  1,
  200,
);
const OBSERVABILITY_HTTP_TRACE_ENABLED = booleanEnv(
  "OBSERVABILITY_HTTP_TRACE_ENABLED",
  process.env.NODE_ENV !== "development",
);

function headerValue(headers: HeadersLike | undefined, key: string) {
  if (!headers) return "";
  const direct = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (Array.isArray(direct)) return direct[0] ?? "";
  return direct ?? "";
}

function sanitizeLogValue(
  value: unknown,
  depth = 0,
  keyHint = "",
): LogValue {
  if (depth > MAX_LOG_DEPTH) return "[depth_limited]";
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LEN) return value;
    return `${value.slice(0, MAX_STRING_LEN)}...[truncated]`;
  }

  if (typeof value === "bigint") return Number(value);

  if (Array.isArray(value)) {
    const slice = value.slice(0, MAX_ARRAY_ITEMS);
    const sanitized = slice.map((item) => sanitizeLogValue(item, depth + 1, keyHint));
    if (value.length > MAX_ARRAY_ITEMS) sanitized.push("[array_truncated]");
    return sanitized;
  }

  if (typeof value === "object") {
    const out: Record<string, LogValue> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_OBJECT_KEYS,
    );
    for (const [key, raw] of entries) {
      const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      const isException = REDACT_EXCEPTIONS.has(normalizedKey);
      if (!isException && (REDACT_KEY_PATTERN.test(key) || REDACT_KEY_PATTERN.test(keyHint))) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeLogValue(raw, depth + 1, key);
    }
    if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) {
      out.__truncated__ = true;
    }
    return out;
  }

  return toSafeString(value);
}

function normalizeTags(tags: Tags | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!tags) return safe;
  for (const [key, value] of Object.entries(tags)) {
    if (value == null) continue;
    safe[key] = toSafeString(value);
  }
  return safe;
}

function metricKey(name: string, tags: Record<string, string>) {
  const tagPairs = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
  return `${name}|${tagPairs}`;
}

function sinkUrlForTarget(target: SinkTarget) {
  if (target === "error") {
    return OBSERVABILITY_ERROR_SINK_URL || OBSERVABILITY_LOG_SINK_URL;
  }
  return OBSERVABILITY_LOG_SINK_URL;
}

function sinkHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (OBSERVABILITY_SINK_TOKEN) {
    headers.Authorization = `Bearer ${OBSERVABILITY_SINK_TOKEN}`;
  }
  return headers;
}

function startSinkFlushTimerIfNeeded() {
  if (sinkFlushTimerStarted) return;
  if (!OBSERVABILITY_LOG_SINK_URL && !OBSERVABILITY_ERROR_SINK_URL) return;
  sinkFlushTimerStarted = true;
  const interval = setInterval(() => {
    void flushSink("interval");
  }, SINK_FLUSH_INTERVAL_MS);
  if (typeof (interval as NodeJS.Timeout).unref === "function") {
    (interval as NodeJS.Timeout).unref();
  }
}

function queueSinkRecord(record: Record<string, LogValue>) {
  startSinkFlushTimerIfNeeded();
  const target: SinkTarget = record.level === "error" ? "error" : "log";
  const sinkUrl = sinkUrlForTarget(target);
  if (!sinkUrl) return;

  if (sinkQueue.length >= SINK_MAX_QUEUE) {
    sinkQueue.shift();
    sinkDroppedCount += 1;
    recordCounter("observability.sink_dropped_total", 1, {
      reason: "queue_full",
      target,
    });
  }

  sinkQueue.push({ target, record });
  setGauge("observability.sink_queue_depth", sinkQueue.length, {});

  if (sinkQueue.length >= OBSERVABILITY_SINK_BATCH_SIZE) {
    void flushSink("threshold");
  }
}

async function flushSink(reason: "interval" | "threshold" | "manual") {
  if (sinkFlushActive) return;
  if (!sinkQueue.length) return;

  const item = sinkQueue[0];
  if (!item) return;
  const url = sinkUrlForTarget(item.target);
  if (!url) return;

  sinkFlushActive = true;
  try {
    const sameTargetBatch: SinkItem[] = [];
    for (let i = 0; i < sinkQueue.length && sameTargetBatch.length < OBSERVABILITY_SINK_BATCH_SIZE; i += 1) {
      const candidate = sinkQueue[i];
      if (!candidate || candidate.target !== item.target) continue;
      sameTargetBatch.push(candidate);
    }

    for (const batched of sameTargetBatch) {
      const index = sinkQueue.indexOf(batched);
      if (index >= 0) sinkQueue.splice(index, 1);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      OBSERVABILITY_SINK_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: sinkHeaders(),
        body: JSON.stringify({
          service: SERVICE_NAME,
          reason,
          emittedAt: new Date().toISOString(),
          target: item.target,
          records: sameTargetBatch.map((entry) => entry.record),
          dropped: sinkDroppedCount,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        recordCounter("observability.sink_failed_total", 1, {
          target: item.target,
          status_code: response.status,
        });
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            service: SERVICE_NAME,
            event: "observability.sink_failed",
            statusCode: response.status,
            target: item.target,
          }),
        );
      } else {
        recordCounter("observability.sink_sent_total", sameTargetBatch.length, {
          target: item.target,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    recordCounter("observability.sink_failed_total", 1, {
      target: item.target,
      status_code: "transport_error",
    });
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        service: SERVICE_NAME,
        event: "observability.sink_transport_error",
        target: item.target,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    sinkFlushActive = false;
    setGauge("observability.sink_queue_depth", sinkQueue.length, {});
    if (sinkQueue.length) {
      void flushSink("manual");
    }
  }
}

export function logEvent(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
) {
  const safeFields = fields
    ? (sanitizeLogValue(fields) as Record<string, LogValue>)
    : {};
  const record = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    event,
    ...safeFields,
  };
  toConsoleMethod(level)(JSON.stringify(record));
  queueSinkRecord(record as Record<string, LogValue>);
}

export function logInfo(event: string, fields?: Record<string, unknown>) {
  logEvent("info", event, fields);
}

export function logWarn(event: string, fields?: Record<string, unknown>) {
  logEvent("warn", event, fields);
}

export function logError(event: string, fields?: Record<string, unknown>) {
  logEvent("error", event, fields);
}

export function hashIdentifier(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function beginRequestTrace(input: {
  route: string;
  method?: string;
  url?: string;
  headers?: HeadersLike;
  setHeader?: (name: string, value: string) => void;
}): RequestTrace {
  const requestId = headerValue(input.headers, "x-request-id") || randomUUID();
  const correlationId =
    headerValue(input.headers, "x-correlation-id") || requestId;
  if (input.setHeader) {
    input.setHeader("x-request-id", requestId);
    input.setHeader("x-correlation-id", correlationId);
  }
  const trace: RequestTrace = {
    requestId,
    correlationId,
    route: input.route,
    method: input.method || "UNKNOWN",
    path: input.url || "",
    startedAtMs: Date.now(),
  };
  if (OBSERVABILITY_HTTP_TRACE_ENABLED) {
    logInfo("request.start", trace);
  }
  return trace;
}

export function finishRequestTrace(
  trace: RequestTrace,
  statusCode: number,
  fields?: Record<string, unknown>,
) {
  const durationMs = Date.now() - trace.startedAtMs;
  recordCounter("http_requests_total", 1, {
    route: trace.route,
    method: trace.method,
    status_code: statusCode,
  });
  recordHistogram("http_request_latency_ms", durationMs, {
    route: trace.route,
    method: trace.method,
    status_code: statusCode,
  });
  if (OBSERVABILITY_HTTP_TRACE_ENABLED) {
    logInfo("request.finish", {
      ...trace,
      statusCode,
      durationMs,
      ...fields,
    });
  }
}

export function classifyError(error: unknown): ErrorClassification {
  if (!error) return { category: "unknown", retryable: false };
  const asRecord = error as Record<string, unknown>;
  const message = toSafeString(asRecord.message || error);
  const code = toSafeString(asRecord.code);
  const name = toSafeString(asRecord.name);
  const statusMaybe =
    typeof asRecord.status === "number"
      ? asRecord.status
      : typeof asRecord.statusCode === "number"
        ? asRecord.statusCode
        : undefined;

  if (name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_ABORTED") {
    return { category: "timeout", retryable: true, code };
  }
  if (code === "CIRCUIT_OPEN") {
    return { category: "circuit_open", retryable: true, code };
  }
  if (statusMaybe === 429) {
    return { category: "rate_limited", retryable: true, statusCode: 429 };
  }
  if (statusMaybe === 401 || statusMaybe === 403) {
    return { category: "unauthorized", retryable: false, statusCode: statusMaybe };
  }
  if (statusMaybe && statusMaybe >= 400 && statusMaybe < 500) {
    return { category: "upstream_4xx", retryable: false, statusCode: statusMaybe };
  }
  if (statusMaybe && statusMaybe >= 500) {
    return { category: "upstream_5xx", retryable: true, statusCode: statusMaybe };
  }
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    message.includes("network")
  ) {
    return { category: "network", retryable: true, code };
  }
  if (
    message.includes("invalid") ||
    message.includes("missing") ||
    message.includes("malformed")
  ) {
    return { category: "invalid_input", retryable: false, code };
  }
  return { category: "unknown", retryable: false, code };
}

export function recordCounter(name: string, value = 1, tags?: Tags) {
  const normalizedTags = normalizeTags(tags);
  const key = metricKey(name, normalizedTags);
  const current = counters.get(key);
  if (!current) {
    counters.set(key, { name, tags: normalizedTags, value });
    return;
  }
  current.value += value;
}

export function recordHistogram(name: string, value: number, tags?: Tags) {
  const normalizedTags = normalizeTags(tags);
  const key = metricKey(name, normalizedTags);
  const current = histograms.get(key);
  if (!current) {
    histograms.set(key, {
      name,
      tags: normalizedTags,
      count: 1,
      sum: value,
      min: value,
      max: value,
    });
    return;
  }
  current.count += 1;
  current.sum += value;
  current.min = Math.min(current.min, value);
  current.max = Math.max(current.max, value);
}

export function setGauge(name: string, value: number, tags?: Tags) {
  const normalizedTags = normalizeTags(tags);
  const key = metricKey(name, normalizedTags);
  const current = gauges.get(key);
  if (!current) {
    gauges.set(key, {
      name,
      tags: normalizedTags,
      value,
      maxObserved: value,
    });
  } else {
    current.value = value;
    current.maxObserved = Math.max(current.maxObserved, value);
  }

  if (value >= GAUGE_ALERT_THRESHOLD) {
    logWarn("metric.gauge.high", {
      name,
      value,
      tags: normalizedTags,
      threshold: GAUGE_ALERT_THRESHOLD,
    });
  }
}

export function adjustGauge(name: string, delta: number, tags?: Tags) {
  const normalizedTags = normalizeTags(tags);
  const key = metricKey(name, normalizedTags);
  const current = gauges.get(key);
  const nextValue = (current?.value ?? 0) + delta;
  setGauge(name, nextValue, normalizedTags);
  return nextValue;
}

export function getMetricsSnapshot() {
  return {
    counters: Array.from(counters.values()),
    histograms: Array.from(histograms.values()),
    gauges: Array.from(gauges.values()),
    generatedAt: new Date().toISOString(),
  };
}

export function logStartupDiagnostics(
  key: string,
  diagnostics: Record<string, unknown>,
) {
  if (startupDiagnosticsFlags.has(key)) return;
  startupDiagnosticsFlags.add(key);
  logInfo("startup.diagnostics", { key, diagnostics });
}

logStartupDiagnostics("observability", {
  logSinkEnabled: Boolean(OBSERVABILITY_LOG_SINK_URL),
  errorSinkEnabled: Boolean(OBSERVABILITY_ERROR_SINK_URL),
  sinkBatchSize: OBSERVABILITY_SINK_BATCH_SIZE,
  sinkTimeoutMs: OBSERVABILITY_SINK_TIMEOUT_MS,
});

export function metricsSummary() {
  return {
    counterSeries: counters.size,
    histogramSeries: histograms.size,
    gaugeSeries: gauges.size,
  };
}

export function getObservabilityDiagnostics() {
  return {
    logSinkEnabled: Boolean(OBSERVABILITY_LOG_SINK_URL),
    errorSinkEnabled: Boolean(OBSERVABILITY_ERROR_SINK_URL),
    queueDepth: sinkQueue.length,
    dropped: sinkDroppedCount,
    sinkBatchSize: OBSERVABILITY_SINK_BATCH_SIZE,
    sinkTimeoutMs: OBSERVABILITY_SINK_TIMEOUT_MS,
  };
}
