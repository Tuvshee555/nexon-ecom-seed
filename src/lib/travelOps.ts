import { randomUUID } from "crypto";
import { askGeminiParts, type GeminiPart } from "./gemini";
import { getEnv } from "./env";
import { fixMojibake } from "./encoding";
import {
  classifyError,
  logError,
  logWarn,
  recordCounter,
} from "./observability";
import { queryNeon, withNeonClient } from "./neonDb";
import type {
  DiscountPolicy,
  FAQItem,
  KnowledgeData,
  ProgramPrice,
  SpecialOffer,
  VerifiedCredential,
} from "./businessData";

export type TripStatus = "active" | "cancelled" | "sold_out" | "draft";

export type TravelTrip = {
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
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type BotControl = {
  bot_paused: boolean;
  pause_reason: string | null;
  updated_at: string;
};

export type TravelBotSettings = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string[];
  comment_trigger_patterns: string[];
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: SpecialOffer[];
  discount_policies: DiscountPolicy[];
  verified_credentials: VerifiedCredential[];
  faq: FAQItem[];
  handoff_enabled: boolean;
  handoff_keywords: string[];
  handoff_reply: string;
  handoff_pause_minutes: number;
  updated_at: string;
};

export type TravelBotSettingsUpdate = Partial<
  Omit<TravelBotSettings, "updated_at">
>;

export type TripMutationFields = Partial<
  Pick<
    TravelTrip,
    | "category"
    | "operator_name"
    | "route_name"
    | "duration_text"
    | "adult_price"
    | "child_price"
    | "currency"
    | "departure_dates"
    | "seats_total"
    | "seats_left"
    | "has_food"
    | "status"
    | "notes"
    | "source_description"
    | "extra"
  >
>;

export type AITripAction = {
  action: "upsert" | "patch" | "cancel";
  trip_id?: string;
  match?: {
    operator_name?: string;
    route_name?: string;
  };
  fields?: TripMutationFields;
};

export type AIChangeProposal = {
  summary: string;
  needs_confirmation: boolean;
  important_reason: string;
  conflicts: string[];
  actions: AITripAction[];
};

export type ProposalValidationReport = {
  proposal: AIChangeProposal;
  blocking_conflicts: string[];
  auto_apply_ready: boolean;
};

type AIActionSnapshot = {
  action: AITripAction;
  trip_id: string;
  before: TravelTrip | null;
  after: TravelTrip | null;
};

export type AIProposalFailureResponse = {
  statusCode: 429 | 503 | 504;
  error: string;
  retry_after_ms: number;
};

type TripMatchSnapshot = Pick<
  TravelTrip,
  | "id"
  | "operator_name"
  | "route_name"
  | "status"
  | "seats_left"
  | "seats_total"
  | "adult_price"
  | "child_price"
  | "currency"
>;

const env = getEnv();
const AI_CHANGE_GEMINI_TIMEOUT_MS = Math.max(env.geminiTimeoutMs, 45_000);
const AI_CHANGE_GEMINI_MAX_RETRIES = 0;
const AI_CHANGE_REPAIR_TIMEOUT_MS = 15_000;
// Reading uploaded files / price lists is where accuracy matters most, so use
// the stronger Pro model there (overridable via GEMINI_FILE_PARSE_MODEL). Quick
// text commands keep the default fast model. Pro is slower + pricier, which is
// an accepted trade for getting prices/dates right.
const FILE_PARSE_MODEL =
  process.env.GEMINI_FILE_PARSE_MODEL || "gemini-2.5-pro";
const FILE_PARSE_GEMINI_TIMEOUT_MS = Math.max(env.geminiTimeoutMs, 60_000);
const FILE_PARSE_GEMINI_MAX_RETRIES = Math.min(env.geminiMaxRetries, 1);
const FILE_PARSE_BATCH_DELAY_MS = 1_200;
const FILE_PARSE_TOTAL_BUDGET_MS = 150_000;
const FILE_PARSE_MIN_BATCH_TIMEOUT_MS = 10_000;
const FILE_PARSE_REPAIR_TIMEOUT_MS = 20_000;
let schemaEnsured = false;
let schemaPromise: Promise<boolean> | null = null;
let botControlCache:
  | { value: BotControl; expiresAt: number }
  | null = null;
let botSettingsCache:
  | { value: TravelBotSettings; expiresAt: number }
  | null = null;

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function coerceTripStatus(value: unknown): TripStatus {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "sold_out") return "sold_out";
  if (normalized === "draft") return "draft";
  return "active";
}

function cleanFields(input: TripMutationFields): TripMutationFields {
  const cleaned: TripMutationFields = {};
  if (typeof input.category === "string") cleaned.category = input.category.trim();
  if (typeof input.operator_name === "string") cleaned.operator_name = input.operator_name.trim();
  if (typeof input.route_name === "string") cleaned.route_name = input.route_name.trim();
  if (typeof input.duration_text === "string") cleaned.duration_text = input.duration_text.trim();
  if (typeof input.currency === "string" && input.currency.trim()) {
    cleaned.currency = input.currency.trim().toUpperCase();
  }
  if (Array.isArray(input.departure_dates)) {
    cleaned.departure_dates = input.departure_dates
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 60);
  }
  if (input.adult_price === null || typeof input.adult_price === "number") {
    cleaned.adult_price = input.adult_price;
  }
  if (input.child_price === null || typeof input.child_price === "number") {
    cleaned.child_price = input.child_price;
  }
  if (input.seats_total === null || typeof input.seats_total === "number") {
    cleaned.seats_total = input.seats_total;
  }
  if (input.seats_left === null || typeof input.seats_left === "number") {
    cleaned.seats_left = input.seats_left;
  }
  if (input.has_food === null || typeof input.has_food === "boolean") {
    cleaned.has_food = input.has_food;
  }
  if (typeof input.status !== "undefined") {
    cleaned.status = coerceTripStatus(input.status);
  }
  if (typeof input.notes === "string") cleaned.notes = input.notes.trim();
  if (typeof input.source_description === "string") {
    cleaned.source_description = input.source_description.trim();
  }
  if (input.extra && typeof input.extra === "object" && !Array.isArray(input.extra)) {
    cleaned.extra = input.extra;
  }
  return cleaned;
}

// Agency-name header detection is config-driven via AGENCY_NAME so this works for
// any tenant, not a hardcoded one. e.g. AGENCY_NAME="Uudam Travel" recognizes
// "uudam travel" / "uudam travel agency" as header rows, not real trips.
function agencyHeaderVariants(): string[] {
  const agency = normalizeLookupText(getEnv().agencyName || "");
  const variants = new Set<string>(["travel agency", "agency"]);
  if (agency) {
    variants.add(agency);
    variants.add(`${agency} agency`);
    variants.add(`${agency} travel`);
    variants.add(`${agency} travel agency`);
  }
  return [...variants];
}

function isAgencyHeaderName(value: string | null | undefined): boolean {
  const normalized = normalizeLookupText(value || "");
  return agencyHeaderVariants().includes(normalized);
}

function isAgencyHeaderConflict(value: string): boolean {
  const normalized = normalizeLookupText(value);
  return agencyHeaderVariants().some(
    (header) => header !== "agency" && normalized.includes(header),
  );
}

export async function ensureTravelSchema() {
  if (schemaEnsured) return true;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const created = await withNeonClient(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_trip_entries (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT '',
          operator_name TEXT NOT NULL,
          route_name TEXT NOT NULL,
          duration_text TEXT NOT NULL DEFAULT '',
          adult_price INTEGER NULL,
          child_price INTEGER NULL,
          currency TEXT NOT NULL DEFAULT 'MNT',
          departure_dates TEXT[] NOT NULL DEFAULT '{}',
          seats_total INTEGER NULL,
          seats_left INTEGER NULL,
          has_food BOOLEAN NULL,
          status TEXT NOT NULL DEFAULT 'active',
          notes TEXT NOT NULL DEFAULT '',
          source_description TEXT NOT NULL DEFAULT '',
          extra JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_trip_entries_operator
          ON travel_trip_entries (operator_name);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_trip_entries_route
          ON travel_trip_entries (route_name);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_trip_entries_status
          ON travel_trip_entries (status);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_bot_control (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          bot_paused BOOLEAN NOT NULL DEFAULT FALSE,
          pause_reason TEXT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        INSERT INTO travel_bot_control (id, bot_paused, pause_reason)
        VALUES (TRUE, FALSE, NULL)
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_ai_change_requests (
          id BIGSERIAL PRIMARY KEY,
          instruction TEXT NOT NULL,
          proposal_json JSONB NOT NULL,
          conflicts TEXT[] NOT NULL DEFAULT '{}',
          needs_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          applied_at TIMESTAMPTZ NULL
        );
      `);
      await client.query(`
        ALTER TABLE travel_ai_change_requests
          ADD COLUMN IF NOT EXISTS rollback_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_bot_settings (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          business_name TEXT NOT NULL DEFAULT '',
          system_prompt TEXT NOT NULL DEFAULT '',
          quick_info_reply TEXT NOT NULL DEFAULT '',
          quick_info_keywords TEXT[] NOT NULL DEFAULT '{}',
          comment_trigger_patterns TEXT[] NOT NULL DEFAULT '{}',
          comment_public_reply TEXT NOT NULL DEFAULT '',
          comment_dm_reply TEXT NOT NULL DEFAULT '',
          special_offers JSONB NOT NULL DEFAULT '[]'::jsonb,
          discount_policies JSONB NOT NULL DEFAULT '[]'::jsonb,
          verified_credentials JSONB NOT NULL DEFAULT '[]'::jsonb,
          faq JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      // Human-handoff columns — added via ALTER so existing databases migrate.
      await client.query(`
        ALTER TABLE travel_bot_settings
          ADD COLUMN IF NOT EXISTS handoff_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          ADD COLUMN IF NOT EXISTS handoff_keywords TEXT[] NOT NULL DEFAULT '{}'::text[],
          ADD COLUMN IF NOT EXISTS handoff_reply TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS handoff_pause_minutes INTEGER NOT NULL DEFAULT 60;
      `);
      await client.query(`
        INSERT INTO travel_bot_settings (id)
        VALUES (TRUE)
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_leads (
          id BIGSERIAL PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'handoff',
          platform TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL DEFAULT '',
          customer_message TEXT NOT NULL DEFAULT '',
          contact_phone TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'new',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          seen_at TIMESTAMPTZ NULL
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_leads_status_created
          ON travel_leads (status, created_at DESC);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_drive_sync_state (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          last_checked_at TIMESTAMPTZ NULL,
          last_synced_at TIMESTAMPTZ NULL,
          last_status TEXT NOT NULL DEFAULT 'idle',
          last_error TEXT NOT NULL DEFAULT '',
          last_summary TEXT NOT NULL DEFAULT '',
          last_run_id TEXT NOT NULL DEFAULT '',
          files_examined INTEGER NOT NULL DEFAULT 0,
          files_changed INTEGER NOT NULL DEFAULT 0,
          files_applied INTEGER NOT NULL DEFAULT 0,
          files_blocked INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        INSERT INTO travel_drive_sync_state (id)
        VALUES (TRUE)
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_drive_sync_files (
          file_id TEXT PRIMARY KEY,
          file_name TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT '',
          fingerprint TEXT NOT NULL DEFAULT '',
          modified_time TIMESTAMPTZ NULL,
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_synced_at TIMESTAMPTZ NULL,
          last_status TEXT NOT NULL DEFAULT 'seen',
          last_error TEXT NOT NULL DEFAULT '',
          request_id BIGINT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_drive_sync_files_updated
          ON travel_drive_sync_files (updated_at DESC);
      `);
      return true;
    });

    if (!created) {
      schemaEnsured = false;
      return false;
    }

    schemaEnsured = true;
    return true;
  })()
    .catch((error) => {
      schemaEnsured = false;
      logError("travel.schema.ensure_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    })
    .finally(() => {
      schemaPromise = null;
    });

  return schemaPromise;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredText(value: unknown): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return "";

  const fixed = fixMojibake(trimmed).replaceAll("\uFFFD", "").trim();
  const compact = fixed.replace(/\s+/g, "");
  const questionMarks = (compact.match(/\?/g) || []).length;
  if (compact.length >= 8 && questionMarks / compact.length > 0.25) {
    return "";
  }
  return fixed;
}

function normalizeStoredTextArray(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = normalizeStoredText(item);
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeTextArray(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asTrimmedString(item);
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeProgramPrice(value: unknown): ProgramPrice {
  const parsed = parseInteger(value);
  return parsed == null ? ("NEEDS_MANUAL_FIX" as ProgramPrice) : parsed;
}

function normalizeSpecialOffers(value: unknown): SpecialOffer[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        name: normalizeStoredText(item.name),
        duration: normalizeStoredText(item.duration),
        price: normalizeProgramPrice(item.price),
        target: normalizeStoredText(item.target),
        description: normalizeStoredText(item.description),
        eligibility: normalizeStoredText(item.eligibility),
      };
    });
}

function normalizeDiscountPolicies(value: unknown): DiscountPolicy[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        name: normalizeStoredText(item.name),
        discount: normalizeStoredText(item.discount),
        applies_to: normalizeStoredText(item.applies_to),
        eligibility: normalizeStoredText(item.eligibility),
        description: normalizeStoredText(item.description),
        verification: normalizeStoredText(item.verification),
      };
    });
}

function normalizeVerifiedCredentials(value: unknown): VerifiedCredential[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        title: normalizeStoredText(item.title),
        issuer: normalizeStoredText(item.issuer),
        issued_on: normalizeStoredText(item.issued_on),
        description: normalizeStoredText(item.description),
      };
    });
}

function normalizeFaq(value: unknown): FAQItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        question: normalizeStoredText(item.question),
        answer: normalizeStoredText(item.answer),
      };
    })
    .filter((item) => item.question || item.answer);
}

function normalizePauseMinutes(value: unknown): number {
  const parsed = parseInteger(value);
  if (parsed == null) return 60;
  return Math.min(Math.max(parsed, 0), 24 * 60);
}

function emptyTravelBotSettings(): TravelBotSettings {
  return {
    business_name: "",
    system_prompt: "",
    quick_info_reply: "",
    quick_info_keywords: [],
    comment_trigger_patterns: [],
    comment_public_reply: "",
    comment_dm_reply: "",
    special_offers: [],
    discount_policies: [],
    verified_credentials: [],
    faq: [],
    handoff_enabled: true,
    handoff_keywords: [],
    handoff_reply: "",
    handoff_pause_minutes: 60,
    updated_at: new Date().toISOString(),
  };
}

function mapBotSettingsRow(row: Record<string, unknown> | undefined): TravelBotSettings {
  if (!row) return emptyTravelBotSettings();
  return {
    business_name: normalizeStoredText(row.business_name),
    system_prompt: normalizeStoredText(row.system_prompt),
    quick_info_reply: normalizeStoredText(row.quick_info_reply),
    quick_info_keywords: normalizeStoredTextArray(row.quick_info_keywords),
    comment_trigger_patterns: normalizeStoredTextArray(row.comment_trigger_patterns),
    comment_public_reply: normalizeStoredText(row.comment_public_reply),
    comment_dm_reply: normalizeStoredText(row.comment_dm_reply),
    special_offers: normalizeSpecialOffers(row.special_offers),
    discount_policies: normalizeDiscountPolicies(row.discount_policies),
    verified_credentials: normalizeVerifiedCredentials(row.verified_credentials),
    faq: normalizeFaq(row.faq),
    handoff_enabled: row.handoff_enabled == null ? true : Boolean(row.handoff_enabled),
    handoff_keywords: normalizeStoredTextArray(row.handoff_keywords),
    handoff_reply: normalizeStoredText(row.handoff_reply),
    handoff_pause_minutes: normalizePauseMinutes(row.handoff_pause_minutes),
    updated_at: String(row.updated_at || new Date().toISOString()),
  };
}

export async function getTravelBotSettings(): Promise<TravelBotSettings> {
  if (botSettingsCache && botSettingsCache.expiresAt > Date.now()) {
    return botSettingsCache.value;
  }

  const ready = await ensureTravelSchema();
  if (!ready) return emptyTravelBotSettings();

  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        business_name,
        system_prompt,
        quick_info_reply,
        quick_info_keywords,
        comment_trigger_patterns,
        comment_public_reply,
        comment_dm_reply,
        special_offers,
        discount_policies,
        verified_credentials,
        faq,
        handoff_enabled,
        handoff_keywords,
        handoff_reply,
        handoff_pause_minutes,
        updated_at
      FROM travel_bot_settings
      WHERE id = TRUE
      LIMIT 1
    `,
  );

  const value = mapBotSettingsRow(result?.rows?.[0]);
  botSettingsCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

export async function updateTravelBotSettings(
  fields: TravelBotSettingsUpdate,
): Promise<TravelBotSettings> {
  const ready = await ensureTravelSchema();
  if (!ready) return emptyTravelBotSettings();

  const values: unknown[] = [];
  const sets: string[] = [];
  const push = (column: string, value: unknown, cast = "") => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  if (typeof fields.business_name === "string") {
    push("business_name", fields.business_name.trim());
  }
  if (typeof fields.system_prompt === "string") {
    push("system_prompt", fields.system_prompt.trim());
  }
  if (typeof fields.quick_info_reply === "string") {
    push("quick_info_reply", fields.quick_info_reply.trim());
  }
  if (typeof fields.comment_public_reply === "string") {
    push("comment_public_reply", fields.comment_public_reply.trim());
  }
  if (typeof fields.comment_dm_reply === "string") {
    push("comment_dm_reply", fields.comment_dm_reply.trim());
  }
  if (typeof fields.quick_info_keywords !== "undefined") {
    push("quick_info_keywords", normalizeTextArray(fields.quick_info_keywords), "::text[]");
  }
  if (typeof fields.comment_trigger_patterns !== "undefined") {
    push(
      "comment_trigger_patterns",
      normalizeTextArray(fields.comment_trigger_patterns),
      "::text[]",
    );
  }
  if (typeof fields.special_offers !== "undefined") {
    push("special_offers", JSON.stringify(normalizeSpecialOffers(fields.special_offers)), "::jsonb");
  }
  if (typeof fields.discount_policies !== "undefined") {
    push(
      "discount_policies",
      JSON.stringify(normalizeDiscountPolicies(fields.discount_policies)),
      "::jsonb",
    );
  }
  if (typeof fields.verified_credentials !== "undefined") {
    push(
      "verified_credentials",
      JSON.stringify(normalizeVerifiedCredentials(fields.verified_credentials)),
      "::jsonb",
    );
  }
  if (typeof fields.faq !== "undefined") {
    push("faq", JSON.stringify(normalizeFaq(fields.faq)), "::jsonb");
  }
  if (typeof fields.handoff_enabled === "boolean") {
    push("handoff_enabled", fields.handoff_enabled);
  }
  if (typeof fields.handoff_reply === "string") {
    push("handoff_reply", fields.handoff_reply.trim());
  }
  if (typeof fields.handoff_keywords !== "undefined") {
    push("handoff_keywords", normalizeTextArray(fields.handoff_keywords), "::text[]");
  }
  if (typeof fields.handoff_pause_minutes !== "undefined") {
    push("handoff_pause_minutes", normalizePauseMinutes(fields.handoff_pause_minutes));
  }

  if (!sets.length) {
    return getTravelBotSettings();
  }

  const result = await queryNeon<Record<string, unknown>>(
    `
      UPDATE travel_bot_settings
      SET
        ${sets.join(", ")},
        updated_at = NOW()
      WHERE id = TRUE
      RETURNING
        business_name,
        system_prompt,
        quick_info_reply,
        quick_info_keywords,
        comment_trigger_patterns,
        comment_public_reply,
        comment_dm_reply,
        special_offers,
        discount_policies,
        verified_credentials,
        faq,
        handoff_enabled,
        handoff_keywords,
        handoff_reply,
        handoff_pause_minutes,
        updated_at
    `,
    values,
  );

  const updated = mapBotSettingsRow(result?.rows?.[0]);
  botSettingsCache = { value: updated, expiresAt: Date.now() + 5_000 };
  return updated;
}

function mapTripRow(row: Record<string, unknown>): TravelTrip {
  return {
    id: String(row.id || ""),
    category: normalizeStoredText(row.category),
    operator_name: normalizeStoredText(row.operator_name),
    route_name: normalizeStoredText(row.route_name),
    duration_text: normalizeStoredText(row.duration_text),
    adult_price: parseInteger(row.adult_price),
    child_price: parseInteger(row.child_price),
    currency: normalizeStoredText(row.currency) || "MNT",
    departure_dates: Array.isArray(row.departure_dates)
      ? row.departure_dates.map((value) => normalizeStoredText(value)).filter(Boolean)
      : [],
    seats_total: parseInteger(row.seats_total),
    seats_left: parseInteger(row.seats_left),
    has_food:
      typeof row.has_food === "boolean"
        ? row.has_food
        : row.has_food == null
          ? null
          : Boolean(row.has_food),
    status: coerceTripStatus(row.status),
    notes: normalizeStoredText(row.notes),
    source_description: normalizeStoredText(row.source_description),
    extra:
      row.extra && typeof row.extra === "object" && !Array.isArray(row.extra)
        ? (row.extra as Record<string, unknown>)
        : {},
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

export async function listTrips(options?: {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return [] as TravelTrip[];

  const search = options?.search?.trim() || null;
  const status = options?.status?.trim() || null;
  const limit = Math.min(Math.max(Number(options?.limit || 150), 1), 1000);
  const offset = Math.max(Number(options?.offset || 0), 0);

  const rows = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        id,
        category,
        operator_name,
        route_name,
        duration_text,
        adult_price,
        child_price,
        currency,
        departure_dates,
        seats_total,
        seats_left,
        has_food,
        status,
        notes,
        source_description,
        extra,
        created_at,
        updated_at
      FROM travel_trip_entries
      WHERE
        ($1::text IS NULL OR (
          category ILIKE '%' || $1 || '%' OR
          operator_name ILIKE '%' || $1 || '%' OR
          route_name ILIKE '%' || $1 || '%' OR
          source_description ILIKE '%' || $1 || '%'
        ))
        AND ($2::text IS NULL OR status = $2)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $3
      OFFSET $4
    `,
    [search, status, limit, offset],
  );
  if (!rows) return [] as TravelTrip[];
  return rows.rows.map(mapTripRow);
}

async function getTripById(id: string): Promise<TravelTrip | null> {
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        id,
        category,
        operator_name,
        route_name,
        duration_text,
        adult_price,
        child_price,
        currency,
        departure_dates,
        seats_total,
        seats_left,
        has_food,
        status,
        notes,
        source_description,
        extra,
        created_at,
        updated_at
      FROM travel_trip_entries
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  return result?.rows?.[0] ? mapTripRow(result.rows[0]) : null;
}

export async function getBotControl(): Promise<BotControl> {
  if (botControlCache && botControlCache.expiresAt > Date.now()) {
    return botControlCache.value;
  }
  const ready = await ensureTravelSchema();
  if (!ready) {
    return {
      bot_paused: false,
      pause_reason: null,
      updated_at: new Date().toISOString(),
    };
  }
  const result = await queryNeon<Record<string, unknown>>(
    `SELECT bot_paused, pause_reason, updated_at FROM travel_bot_control WHERE id = TRUE LIMIT 1`,
  );
  const row = result?.rows?.[0];
  const value = {
    bot_paused: Boolean(row?.bot_paused),
    pause_reason: row?.pause_reason ? String(row.pause_reason) : null,
    updated_at: String(row?.updated_at || new Date().toISOString()),
  };
  botControlCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

export async function setBotPaused(paused: boolean, reason?: string | null) {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `
      INSERT INTO travel_bot_control (id, bot_paused, pause_reason, updated_at)
      VALUES (TRUE, $1, $2, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        bot_paused = EXCLUDED.bot_paused,
        pause_reason = EXCLUDED.pause_reason,
        updated_at = NOW()
    `,
    [paused, reason || null],
  );
  botControlCache = null;
  return Boolean(result);
}

export async function isBotGloballyPaused() {
  const control = await getBotControl();
  return control.bot_paused;
}

export async function upsertTrip(input: {
  id?: string;
  fields: TripMutationFields;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return null;

  const cleaned = cleanFields(input.fields);
  const id = input.id?.trim() || `trip-${randomUUID()}`;
  const row: TravelTrip = {
    id,
    category: cleaned.category || "",
    operator_name: cleaned.operator_name || "Unknown operator",
    route_name: cleaned.route_name || "Unnamed route",
    duration_text: cleaned.duration_text || "",
    adult_price:
      typeof cleaned.adult_price === "number" ? Math.trunc(cleaned.adult_price) : null,
    child_price:
      typeof cleaned.child_price === "number" ? Math.trunc(cleaned.child_price) : null,
    currency: cleaned.currency || "MNT",
    departure_dates: cleaned.departure_dates || [],
    seats_total:
      typeof cleaned.seats_total === "number" ? Math.trunc(cleaned.seats_total) : null,
    seats_left:
      typeof cleaned.seats_left === "number" ? Math.trunc(cleaned.seats_left) : null,
    has_food:
      typeof cleaned.has_food === "boolean" || cleaned.has_food === null
        ? cleaned.has_food
        : null,
    status: coerceTripStatus(cleaned.status),
    notes: cleaned.notes || "",
    source_description: cleaned.source_description || "",
    extra: cleaned.extra || {},
    created_at: "",
    updated_at: "",
  };

  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_trip_entries (
        id,
        category,
        operator_name,
        route_name,
        duration_text,
        adult_price,
        child_price,
        currency,
        departure_dates,
        seats_total,
        seats_left,
        has_food,
        status,
        notes,
        source_description,
        extra,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16::jsonb, NOW()
      )
      ON CONFLICT (id)
      DO UPDATE SET
        category = EXCLUDED.category,
        operator_name = EXCLUDED.operator_name,
        route_name = EXCLUDED.route_name,
        duration_text = EXCLUDED.duration_text,
        adult_price = EXCLUDED.adult_price,
        child_price = EXCLUDED.child_price,
        currency = EXCLUDED.currency,
        departure_dates = EXCLUDED.departure_dates,
        seats_total = EXCLUDED.seats_total,
        seats_left = EXCLUDED.seats_left,
        has_food = EXCLUDED.has_food,
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        source_description = EXCLUDED.source_description,
        extra = EXCLUDED.extra,
        updated_at = NOW()
      RETURNING *
    `,
    [
      row.id,
      row.category,
      row.operator_name,
      row.route_name,
      row.duration_text,
      row.adult_price,
      row.child_price,
      row.currency,
      row.departure_dates,
      row.seats_total,
      row.seats_left,
      row.has_food,
      row.status,
      row.notes,
      row.source_description,
      JSON.stringify(row.extra),
    ],
  );
  return result?.rows?.[0] ? mapTripRow(result.rows[0]) : null;
}

export async function patchTrip(id: string, fields: TripMutationFields) {
  const ready = await ensureTravelSchema();
  if (!ready) return null;

  const cleaned = cleanFields(fields);
  const keys = Object.keys(cleaned) as Array<keyof TripMutationFields>;
  if (!keys.length) return null;

  const columnMap: Record<keyof TripMutationFields, string> = {
    category: "category",
    operator_name: "operator_name",
    route_name: "route_name",
    duration_text: "duration_text",
    adult_price: "adult_price",
    child_price: "child_price",
    currency: "currency",
    departure_dates: "departure_dates",
    seats_total: "seats_total",
    seats_left: "seats_left",
    has_food: "has_food",
    status: "status",
    notes: "notes",
    source_description: "source_description",
    extra: "extra",
  };

  const values: unknown[] = [];
  const sets: string[] = [];

  keys.forEach((key, index) => {
    values.push(
      key === "extra"
        ? JSON.stringify((cleaned[key] as Record<string, unknown>) || {})
        : cleaned[key],
    );
    const column = columnMap[key];
    const placeholder = key === "departure_dates" ? `$${index + 1}::text[]` : `$${index + 1}`;
    const jsonbPlaceholder = key === "extra" ? `${placeholder}::jsonb` : placeholder;
    sets.push(`${column} = ${jsonbPlaceholder}`);
  });

  values.push(id);
  const result = await queryNeon<Record<string, unknown>>(
    `
      UPDATE travel_trip_entries
      SET
        ${sets.join(", ")},
        updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `,
    values,
  );
  return result?.rows?.[0] ? mapTripRow(result.rows[0]) : null;
}

export async function deleteTrip(id: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `DELETE FROM travel_trip_entries WHERE id = $1`,
    [id],
  );
  return (result?.rowCount ?? 0) > 0;
}

async function resolveTripIdByMatch(match?: {
  operator_name?: string;
  route_name?: string;
}) {
  if (!match?.route_name && !match?.operator_name) return { id: null, conflict: null as string | null };
  const operator = match.operator_name?.trim() || null;
  const route = match.route_name?.trim() || null;
  const found = await queryNeon<{ id: string }>(
    `
      SELECT id
      FROM travel_trip_entries
      WHERE
        ($1::text IS NULL OR operator_name ILIKE $1)
        AND ($2::text IS NULL OR route_name ILIKE $2)
      ORDER BY updated_at DESC
      LIMIT 2
    `,
    [operator, route],
  );
  if (!found || found.rows.length === 0) {
    return { id: null, conflict: "Matching trip not found." };
  }
  if (found.rows.length > 1) {
    return { id: null, conflict: "Multiple trips match the same operator/route." };
  }
  return { id: found.rows[0].id, conflict: null as string | null };
}

function cleanAIText(text: string): string {
  return text.replace(/```json|```/gi, "").trim();
}

function estimateInlineBytes(data?: string | null): number {
  if (!data) return 0;
  return Math.floor((data.length * 3) / 4);
}

function parseJsonFromModel(text: string): AIChangeProposal | null {
  const cleaned = cleanAIText(text);
  try {
    return JSON.parse(cleaned) as AIChangeProposal;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as AIChangeProposal;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function proposalFallbackFromRawText(text: string): AIChangeProposal {
  const cleaned = cleanAIText(text).trim();
  const preview = cleaned.slice(0, 900);
  return {
    summary: preview
      ? "AI returned text, but it was not valid JSON yet."
      : "AI did not return valid JSON.",
    needs_confirmation: true,
    important_reason:
      "The uploaded files were read, but the model response could not be converted into the required action format automatically.",
    conflicts: preview
      ? [`Raw AI output preview: ${preview}`]
      : ["AI response was empty or not valid JSON."],
    actions: [],
  };
}

function normalizeProposal(input: AIChangeProposal | null): AIChangeProposal {
  if (!input) {
    return {
      summary: "AI хариуг parse хийж чадсангүй.",
      needs_confirmation: true,
      important_reason: "JSON бүтэц буруу байсан тул баталгаажуулалт шаардлагатай.",
      conflicts: ["AI хариу JSON биш байна."],
      actions: [],
    };
  }
  return {
    summary: String(input.summary || "AI саналыг үүсгэлээ."),
    needs_confirmation: Boolean(input.needs_confirmation),
    important_reason: String(input.important_reason || ""),
    conflicts: Array.isArray(input.conflicts)
      ? input.conflicts.map((value) => String(value))
      : [],
    actions: Array.isArray(input.actions)
      ? input.actions.filter((action) => action && typeof action === "object")
      : [],
  };
}

export function getAIProposalFailureResponse(
  proposal: AIChangeProposal | undefined,
): AIProposalFailureResponse | null {
  if (!proposal || proposal.actions.length > 0) return null;

  const text = [
    proposal.summary,
    proposal.important_reason,
    ...(proposal.conflicts || []),
  ]
    .join(" ")
    .toLowerCase();

  if (
    /\b429\b|rate.?limit|quota|resource.?exhausted/.test(text)
  ) {
    return {
      statusCode: 429,
      error:
        "AI service is temporarily rate limited. Please wait a minute and try again.",
      retry_after_ms: 60_000,
    };
  }

  if (/timeout|timed out|etimedout/.test(text)) {
    return {
      statusCode: 504,
      error:
        "AI service took too long to answer. Please try again with a shorter instruction.",
      retry_after_ms: 20_000,
    };
  }

  if (/circuit|upstream|temporarily|took too long|could not finish reading batch/.test(text)) {
    return {
      statusCode: 503,
      error: "AI service is temporarily unavailable. Please try again shortly.",
      retry_after_ms: 30_000,
    };
  }

  return null;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = String(value || "").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

function normalizeLookupText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDateText(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[./]/g, "-");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!match) return trimmed;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return trimmed;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Phrases that describe a repeating departure schedule rather than a single
// calendar date. Kept in sync with the client copy in admin.tsx — update both.
const RECURRING_DEPARTURE_TOKENS = [
  // Daily — the common "өдөр бүр / daily / everyday" the admin asks for.
  "өдөр бүр",
  "өдөр болгон",
  "өдөр тутам",
  "daily",
  "every day",
  "everyday",
  // Weekly / per-weekday.
  "гараг бүр",
  "долоо хоног бүр",
  "долоохоног бүр",
  "every week",
  "weekly",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "даваа",
  "мягмар",
  "лхагва",
  "пүрэв",
  "баасан",
  "бямба",
  "ням",
  // Monthly / periodic.
  "сар бүр",
  "monthly",
  "every month",
  "хоног тутам",
];

function isRecurringDepartureText(value: string): boolean {
  const normalized = normalizeLookupText(value);
  if (!normalized) return false;
  return RECURRING_DEPARTURE_TOKENS.some((token) => normalized.includes(token));
}

function findTripMatches(
  trips: TripMatchSnapshot[],
  operatorName?: string,
  routeName?: string,
): TripMatchSnapshot[] {
  const operator = operatorName ? normalizeLookupText(operatorName) : "";
  const route = routeName ? normalizeLookupText(routeName) : "";
  if (!operator && !route) return [];

  return trips.filter((trip) => {
    const tripOperator = normalizeLookupText(trip.operator_name || "");
    const tripRoute = normalizeLookupText(trip.route_name || "");
    if (operator && tripOperator !== operator) return false;
    if (route && tripRoute !== route) return false;
    return true;
  });
}

function buildConflictLabel(routeName?: string, operatorName?: string): string {
  if (routeName && operatorName) return `"${routeName}" / "${operatorName}"`;
  if (routeName) return `"${routeName}"`;
  if (operatorName) return `"${operatorName}"`;
  return "энэ аялал";
}

function isReasonableMoney(value: number | null | undefined) {
  return value == null || (Number.isFinite(value) && value >= 0 && value <= 100_000_000);
}

function isReasonableSeats(value: number | null | undefined) {
  return value == null || (Number.isFinite(value) && value >= 0 && value <= 10_000);
}

function isGenericConfirmationText(value: string | null | undefined): boolean {
  const normalized = normalizeLookupText(value || "");
  if (!normalized) return true;
  return (
    normalized.includes("файлнаас шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("баталгаажуулалт шаардлагатай") ||
    normalized.includes("баталгаажуулах шаардлагатай") ||
    (normalized.includes("new trip") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("review"))
  );
}

function isOptionalAddOnCostConflict(value: string): boolean {
  const normalized = normalizeLookupText(value);
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

function isDocumentedMealExceptionConflict(value: string): boolean {
  const normalized = normalizeLookupText(value);
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

function isCompleteCleanAction(action: AITripAction): boolean {
  const verb = String(action.action || "").trim().toLowerCase();
  const fields = action.fields || {};
  const hasTarget = Boolean(action.trip_id || action.match?.route_name || action.match?.operator_name);
  if (verb === "patch") return hasTarget && Object.keys(fields).length > 0;
  if (verb !== "upsert") return false;

  const routeName = fields.route_name?.trim() || action.match?.route_name?.trim() || "";
  const operatorName = fields.operator_name?.trim() || action.match?.operator_name?.trim() || "";
  const hasPrice =
    typeof fields.adult_price === "number" || typeof fields.child_price === "number";
  const hasDates =
    Array.isArray(fields.departure_dates) && fields.departure_dates.length > 0;
  const hasDuration = Boolean(fields.duration_text?.trim());

  return Boolean(routeName && operatorName && hasPrice && hasDates && hasDuration);
}

export function validateAIChangeProposal(
  proposal: AIChangeProposal | null,
  existingTrips: TripMatchSnapshot[] = [],
): ProposalValidationReport {
  const normalized = normalizeProposal(proposal);
  const blockingConflicts: string[] = [];
  const confirmationConflicts = normalized.conflicts.filter(
    (conflict) =>
      !isAgencyHeaderConflict(conflict) &&
      !isGenericConfirmationText(conflict) &&
      !isOptionalAddOnCostConflict(conflict) &&
      !isDocumentedMealExceptionConflict(conflict),
  );
  const sanitizedActions: AITripAction[] = [];

  for (const rawAction of normalized.actions) {
    if (!rawAction || typeof rawAction !== "object") continue;

    const verb = String(rawAction.action || "").trim().toLowerCase();
    const tripId = rawAction.trip_id?.trim() || undefined;
    const cleanedFields = cleanFields(rawAction.fields || {});
    const match = {
      operator_name: rawAction.match?.operator_name?.trim() || undefined,
      route_name: rawAction.match?.route_name?.trim() || undefined,
    };
    const routeName = cleanedFields.route_name || match.route_name || "";
    const operatorName = cleanedFields.operator_name || match.operator_name || "";
    const label = buildConflictLabel(routeName, operatorName);
    const matchingTrips = findTripMatches(existingTrips, match.operator_name, match.route_name);

    if (isAgencyHeaderName(routeName)) {
      continue;
    }

    if (verb !== "upsert" && verb !== "patch" && verb !== "cancel") {
      blockingConflicts.push(`${label}: unsupported action "${verb || "unknown"}".`);
      continue;
    }

    if (!isReasonableMoney(cleanedFields.adult_price)) {
      blockingConflicts.push(`${label}: adult price is outside the allowed range.`);
      continue;
    }
    if (!isReasonableMoney(cleanedFields.child_price)) {
      blockingConflicts.push(`${label}: child price is outside the allowed range.`);
      continue;
    }
    if (!isReasonableSeats(cleanedFields.seats_total)) {
      blockingConflicts.push(`${label}: total seats is outside the allowed range.`);
      continue;
    }
    if (!isReasonableSeats(cleanedFields.seats_left)) {
      blockingConflicts.push(`${label}: seats left is outside the allowed range.`);
      continue;
    }

    if (
      typeof cleanedFields.adult_price === "number" &&
      typeof cleanedFields.child_price === "number" &&
      cleanedFields.child_price > cleanedFields.adult_price
    ) {
      confirmationConflicts.push(
        `${label}: child price (${cleanedFields.child_price}) is higher than adult price (${cleanedFields.adult_price}).`,
      );
    }

    if (
      typeof cleanedFields.seats_total === "number" &&
      typeof cleanedFields.seats_left === "number" &&
      cleanedFields.seats_left > cleanedFields.seats_total
    ) {
      confirmationConflicts.push(
        `${label}: seats left (${cleanedFields.seats_left}) is greater than total seats (${cleanedFields.seats_total}).`,
      );
    }

    if (
      cleanedFields.status === "sold_out" &&
      typeof cleanedFields.seats_left === "number" &&
      cleanedFields.seats_left > 0
    ) {
      confirmationConflicts.push(
        `${label}: status is sold_out but seats left is ${cleanedFields.seats_left}.`,
      );
    }

    if (Array.isArray(cleanedFields.departure_dates)) {
      const validDates: string[] = [];
      const invalidDates: string[] = [];
      for (const value of cleanedFields.departure_dates) {
        const normalizedDate = normalizeDateText(String(value || ""));
        if (!normalizedDate) continue;
        if (
          (!/\d/.test(normalizedDate) && !isRecurringDepartureText(normalizedDate)) ||
          normalizedDate.length > 60
        ) {
          invalidDates.push(String(value || "").trim());
          continue;
        }
        if (!validDates.includes(normalizedDate)) validDates.push(normalizedDate);
      }
      cleanedFields.departure_dates = validDates;
      if (invalidDates.length > 0) {
        confirmationConflicts.push(
          `${label}: some departure dates could not be trusted (${invalidDates.join(", ")}).`,
        );
      }
    }

    if ((verb === "patch" || verb === "cancel") && !tripId && !match.route_name && !match.operator_name) {
      blockingConflicts.push(`${label}: update/cancel actions must include trip_id or match fields.`);
      continue;
    }

    if (verb === "patch" && Object.keys(cleanedFields).length === 0) {
      blockingConflicts.push(`${label}: patch action has no fields to update.`);
      continue;
    }

    if (verb === "upsert") {
      const fieldsRoute = cleanedFields.route_name?.trim() || "";
      const fieldsOperator = cleanedFields.operator_name?.trim() || "";
      if (!tripId && !match.route_name && !fieldsRoute) {
        blockingConflicts.push(`${label}: new or updated trips must include a route name.`);
        continue;
      }
      if (!tripId && !match.operator_name && !fieldsOperator && !match.route_name) {
        blockingConflicts.push(`${label}: new trips must include an operator name.`);
        continue;
      }

      if (!tripId && !match.route_name && fieldsRoute && fieldsOperator) {
        const duplicateTrips = findTripMatches(existingTrips, fieldsOperator, fieldsRoute);
        if (duplicateTrips.length > 0) {
          confirmationConflicts.push(
            `${label}: an existing trip already matches this operator and route, so review before creating a duplicate.`,
          );
        }
      }
    }

    if ((verb === "patch" || verb === "cancel" || verb === "upsert") && !tripId && (match.route_name || match.operator_name)) {
      if (matchingTrips.length === 0 && verb !== "upsert") {
        blockingConflicts.push(`${label}: matching trip not found.`);
        continue;
      }
      if (matchingTrips.length > 1) {
        blockingConflicts.push(`${label}: multiple trips match the same operator/route.`);
        continue;
      }
    }

    if (verb === "cancel") {
      cleanedFields.status = "cancelled";
    }

    if (cleanedFields.status === "cancelled") {
      confirmationConflicts.push(`${label}: this action cancels a trip and should be reviewed.`);
    }

    const sanitizedAction: AITripAction = {
      action: verb as AITripAction["action"],
      ...(tripId ? { trip_id: tripId } : {}),
      ...(match.operator_name || match.route_name ? { match } : {}),
      ...(Object.keys(cleanedFields).length > 0 ? { fields: cleanedFields } : {}),
    };
    sanitizedActions.push(sanitizedAction);
  }

  const proposalConflicts = dedupeStrings([
    ...confirmationConflicts,
    ...blockingConflicts,
  ]);
  const finalActions = dedupeActions(sanitizedActions);
  const genericOnlyConfirmation =
    normalized.needs_confirmation &&
    proposalConflicts.length === 0 &&
    blockingConflicts.length === 0 &&
    finalActions.length > 0 &&
    finalActions.every(isCompleteCleanAction) &&
    isGenericConfirmationText(normalized.important_reason);
  const needsConfirmation =
    proposalConflicts.length > 0 ||
    blockingConflicts.length > 0 ||
    (normalized.needs_confirmation && !genericOnlyConfirmation);
  const finalProposal: AIChangeProposal = {
    ...normalized,
    needs_confirmation: needsConfirmation,
    important_reason: genericOnlyConfirmation ? "" : normalized.important_reason,
    conflicts: proposalConflicts,
    actions: finalActions,
  };

  return {
    proposal: finalProposal,
    blocking_conflicts: dedupeStrings(blockingConflicts),
    auto_apply_ready:
      finalProposal.actions.length > 0 &&
      finalProposal.conflicts.length === 0 &&
      finalProposal.needs_confirmation === false,
  };
}

function dedupeActions(actions: AITripAction[]): AITripAction[] {
  const seen = new Set<string>();
  const result: AITripAction[] = [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function buildProposalRepairGuide(rawText: string): string {
  return [
    "Convert the following model output into valid JSON only.",
    "Return exactly one JSON object with this schema:",
    "{",
    '  "summary": "short summary",',
    '  "needs_confirmation": true,',
    '  "important_reason": "reason",',
    '  "conflicts": ["item"],',
    '  "actions": [',
    '    { "action": "upsert|patch|cancel", "trip_id": "", "match": { "operator_name": "", "route_name": "" }, "fields": {} }',
    "  ]",
    "}",
    "Do not add markdown fences or explanation text.",
    "",
    "Model output to repair:",
    rawText,
  ].join("\n");
}

function buildProposalGuide(condensedTrips: unknown): string {
  return [
    "Та дэлгүүрийн бүтээгдэхүүн (бараа)-ны өгөгдөл уншигч туслах байна.",
    "Доорх мэдээллээс бараа (бүтээгдэхүүн)-ны өгөгдөлд хийх өөрчлөлтийг тодорхойлж, ЗӨВХӨН JSON буцаа.",
    "Тайлбар: route_name = барааны нэр, adult_price = үнэ, seats_left/seats_total = нөөц (stock), status=sold_out = дууссан/нөөц алга. Барааны худалдан авах холбоос (line/website) байвал extra.buy_url-д хадгал.",
    "Тайлбар текст, markdown, ```код```-ийн хашилт БҮҮ нэм.",
    "",
    "JSON schema:",
    "{",
    '  "summary": "товч дүгнэлт (монголоор)",',
    '  "needs_confirmation": true/false,',
    '  "important_reason": "яагаад баталгаажуулах ёстой эсэх",',
    '  "conflicts": ["зөрчил 1", "зөрчил 2"],',
    '  "actions": [',
    "    {",
    '      "action": "upsert|patch|cancel",',
    '      "trip_id": "trip id (optional)",',
    '      "match": { "operator_name": "...", "route_name": "..." },',
    '      "fields": {',
    '        "category": "", "operator_name": "", "route_name": "", "duration_text": "",',
    '        "adult_price": 0, "child_price": 0, "currency": "MNT|CNY",',
    '        "departure_dates": ["..."], "seats_total": 0, "seats_left": 0,',
    '        "has_food": true, "status": "active|cancelled|sold_out|draft",',
    '        "notes": "", "source_description": ""',
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "Баталгаажуулалт заавал true болгох нөхцөл:",
    "- Маршрут цуцлах (status=cancelled),",
    "- Үнийн том өөрчлөлт,",
    "- Суудал 0 болгох эсвэл sold_out болгох,",
    "- Нэгээс олон маршрут таарах магадлалтай үед,",
    "- Файлаас уншсан өгөгдөл бүрхэг/эргэлзээтэй үед.",
    "",
    "Дүрэм:",
    "- Одоо байгаа маршрутыг шинэчлэхдээ trip_id эсвэл match (operator_name+route_name) ашигла.",
    "- Шинэ маршрут бол action='upsert', trip_id хоосон үлдээ.",
    "- Мэдээлэл байхгүй талбарыг БҮҮ таа — fields-ээс орхи.",
    "- Үнийн валют: 'юань'/'yuan' → CNY, 'төгрөг'/'сая' эсвэл 6+ оронтой тоо → MNT.",
    "- Хэрэв ямар ч өөрчлөлт хийх шаардлагагүй бол actions хоосон массив байг.",
    "",
    "Талбар таних заавар (админ ярианы хэлээр асууж магадгүй):",
    "- 'Огноо', 'хэзээ', 'гарах өдөр', 'цаг' → departure_dates. 'өдөр бүр', 'daily', 'пүрэв гараг бүр' зэрэг давтагдах хуваарь ХҮЧИНТЭЙ departure_dates утга — огноо алга гэж бүү тооц.",
    "- Тодорхой цагийн мэдээлэл (ж: '09:00 цагт') departure_dates-д эсвэл notes-д бич.",
    "- 'Бараа', 'нэр', 'загвар', 'төрөл' → route_name (хэмжээ/өнгө гэх дэлгэрэнгүйг notes-д бич).",
    "- 'Нөөц', 'үлдэгдэл', 'ширхэг', 'тоо', 'хэдэн ширхэг' → seats_total/seats_left. 'Дууссан/нөөц алга/sold out' → status=sold_out.",
    "- Худалдан авах холбоос ('линк', 'захиалах', 'website', 'http...') → extra.buy_url.",
    "- Зөвхөн нэг талбар өөрчлөхөд action='patch' ашиглаж, бусад талбарыг БҮҮ хүр.",
    "- Админ 'үүнийг'/'энэ аяллыг' гэж тодорхойгүй заавал, аль аялал болохыг trips жагсаалтаас тааруул. Олон аялал таарвал эсвэл огт тодорхойгүй бол needs_confirmation=true болгон аль аяллыг асуу.",
    "",
    "conflicts массивын дүрэм (ЧУХАЛ) — аялалын ажилтантай ярьж байгаа мэт энгийн, эелдэг асуу:",
    "- Энгийн, ойлгомжтой ярианы хэлээр бич. Аялалын менежертэй ярьж байгаа мэт, программистын хэллэг БҮҮ хэрэглэ.",
    "- Доторх техник нэр томьёо, талбарын нэр, ID (ж: 'seed-33', 'trip_id', 'route_name', 'status=cancelled', 'departure_dates') БҮҮ дурд. Зөвхөн хүний ойлгох үг хэрэглэ.",
    "- Аль аяллын тухай вэ — маршрутын нэрийг ХАШИЛТАНД бич (ж: \"Жэжү арлын аялал 2026\"). ID биш, НЭРийг нь хэрэглэ.",
    "- Боломжтой бол сонголттой, шууд хариулж болохоор асуу (ж: \"...нэрийг шинэчлэх үү, эсвэл шинэ аялал болгох уу?\").",
    "- Аль зүйл тодорхойгүй (үнэ, гарах өдөр, хоол, суудал г.м.) болон зөрчилдөж буй яг утгуудыг энгийнээр бич.",
    "- \"Нэг аяллын...\", \"зарим аялал...\" гэх ерөнхий, бүрхэг бичлэг хатуу хориотой.",
    "- Сайн жишээ: \"\\\"Хөх хотын шинжилгээтэй аялал\\\"-ын нэрийг шинэчлэх үү, эсвэл шинэ аялал болгож нэмэх үү?\"",
    "- Сайн жишээ: \"\\\"Жэжү арлын аялал 2026\\\"-д хүүхдийн үнэ (4,900,000₮) том хүний үнэ (4,290,000₮)-өөс өндөр байна. Зөв үү?\"",
    "- Муу жишээ (БҮҮ ингэ): \"'Boogii travel'-ийн ... (ID: seed-33) маршрутын нэр ... болж шинэчлэгдэх эсвэл шинэ маршрут үүсгэх эсэх нь тодорхойгүй байна.\"",
    "",
    `Одоогийн trips (JSON): ${JSON.stringify(condensedTrips)}`,
  ].join("\n");
}

function buildBatchSourceParts(input: {
  note?: string;
  sources: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
  }>;
}) {
  const parts: GeminiPart[] = [];
  const sourceLabels = input.sources.map((source) => source.label).join(", ");
  const guidance = [
    `Sources: ${sourceLabels}`,
    input.note ? `Admin note: ${input.note}` : "",
    "Extract travel information from the attached files, images, or text, including route, operator, price, seats, departure date, meals, and status.",
    "ACCURACY IS THE TOP PRIORITY. Read carefully and do not rush.",
    "Read EVERY trip/row in the source. Do not skip rows and do not stop early. If the source lists 12 trips, return actions for all 12.",
    "Never merge two different trips into one, and never split one trip into two. Each distinct route = one action.",
    "Copy prices, seat counts, and dates EXACTLY as written in the source — digit for digit. Do not round, estimate, convert, or 'fix' numbers. If a price is 4,290,000 write 4290000, not 4300000.",
    "Only use information that is actually present in the source. Never invent or guess a price, date, or field. If a field is missing, leave it out rather than filling a plausible value.",
    "If any value is unclear or hard to read, keep needs_confirmation=true and ask about that exact value in plain language instead of guessing.",
    "Ignore logos, agency names, headers, footers, contact details, and page decorations unless they are attached to a real trip row.",
    `Do not create a trip named "${getEnv().agencyName}", "${getEnv().agencyName} TRAVEL", "${getEnv().agencyName} TRAVEL AGENCY", "TRAVEL AGENCY", or any other agency/header-only text.`,
    "Do not treat normal adult/child price differences as conflicts. Only flag child price if it is higher than adult price or the source is genuinely unclear.",
    "When a trip has base prices in MNT plus a medical/exam fee in CNY, store the base adult/child prices as MNT and write the CNY fee clearly in notes/source_description.",
    "Optional add-on costs in CNY/yuan (нэмэлт төлбөр, өөрийн зардлаар, single room fees, extra attraction tickets) are not conflicts; keep them in notes/source_description.",
    "Recurring schedules such as 'Пүрэв гараг бүр' are valid departure_dates; do not report them as missing dates.",
    "If meals are generally included but specific days/meals are self-paid or unavailable, set has_food=true and write the exceptions in notes/source_description instead of raising a meal conflict.",
    "If a source lists хөтөлбөртэй and чөлөөт package prices for the same route, prefer separate actions with route names that include the variant instead of forcing one base price.",
    "Do not infer the operator from the uploaded filename when the document content already has a brand/operator.",
    "If possible, match against existing trips to update them; otherwise propose adding new trips.",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push({ text: guidance });

  for (const source of input.sources) {
    if (source.contentText && source.contentText.trim()) {
      parts.push({
        text: `File contents (${source.label}) (HTML/text):\n${source.contentText.trim()}`,
      });
    }
    if (source.inline) {
      parts.push({ text: `Attached binary file: ${source.label}` });
      parts.push({ inlineData: source.inline });
    }
  }

  return { parts, sourceLabels };
}

function chunkProposalSources(
  sources: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
  }>,
) {
  const MAX_INLINE_SOURCES_PER_BATCH = 2;
  const MAX_INLINE_BYTES_PER_BATCH = 12 * 1024 * 1024;
  const MAX_TEXT_CHARS_PER_BATCH = 120_000;
  const batches: Array<typeof sources> = [];
  let current: typeof sources = [];
  let inlineCount = 0;
  let inlineBytes = 0;
  let textChars = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      inlineCount = 0;
      inlineBytes = 0;
      textChars = 0;
    }
  };

  for (const source of sources) {
    const sourceInlineBytes = estimateInlineBytes(source.inline?.data);
    const sourceInlineCount = source.inline ? 1 : 0;
    const sourceTextChars = source.contentText?.length ?? 0;
    const exceedsCurrentBatch =
      current.length > 0 &&
      (inlineCount + sourceInlineCount > MAX_INLINE_SOURCES_PER_BATCH ||
        inlineBytes + sourceInlineBytes > MAX_INLINE_BYTES_PER_BATCH ||
        textChars + sourceTextChars > MAX_TEXT_CHARS_PER_BATCH);

    if (exceedsCurrentBatch) {
      flush();
    }

    current.push(source);
    inlineCount += sourceInlineCount;
    inlineBytes += sourceInlineBytes;
    textChars += sourceTextChars;
  }

  flush();
  return batches;
}

function mergeBatchProposals(
  proposals: AIChangeProposal[],
  batchCount: number,
): AIChangeProposal {
  const actions = dedupeActions(proposals.flatMap((proposal) => proposal.actions || []));
  const conflicts = dedupeStrings(
    proposals.flatMap((proposal) => proposal.conflicts || []),
  );
  const importantReasons = dedupeStrings(
    proposals
      .map((proposal) => proposal.important_reason)
      .filter((value) => String(value || "").trim().length > 0),
  );
  const summaries = dedupeStrings(
    proposals
      .map((proposal) => proposal.summary)
      .filter((value) => String(value || "").trim().length > 0),
  );

  return {
    summary:
      summaries[0] && proposals.length === 1
        ? summaries[0]
        : actions.length > 0
          ? `Combined ${batchCount} file batches into ${actions.length} suggested action(s).`
          : `Processed ${batchCount} file batches, but no safe trip actions were produced automatically.`,
    needs_confirmation: proposals.some((proposal) => proposal.needs_confirmation),
    important_reason: importantReasons.join(" | "),
    conflicts,
    actions,
  };
}

async function requestProposalFromModel(opts: {
  condensedTrips: unknown;
  userParts: GeminiPart[];
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  model?: string;
}) {
  const result = await askGeminiParts(
    [{ text: buildProposalGuide(opts.condensedTrips) }, ...opts.userParts],
    {
      source: opts.source,
      jsonMode: true,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      model: opts.model,
    },
  );

  let parsed = parseJsonFromModel(result.text);
  if (!parsed) {
    try {
      const repaired = await askGeminiParts(
        [{ text: buildProposalRepairGuide(result.text) }],
        {
          source: `${opts.source}.repair`,
          jsonMode: true,
          timeoutMs: opts.repairTimeoutMs,
          maxRetries: 0,
          model: opts.model,
        },
      );
      parsed = parseJsonFromModel(repaired.text);
    } catch (error) {
      logError("travel.ai.proposal_repair_failed", {
        source: opts.source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return parsed ? normalizeProposal(parsed) : proposalFallbackFromRawText(result.text);
}

async function requestProposalFromPrompt(opts: {
  prompt: string;
  source: string;
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
}) {
  const result = await askGeminiParts([{ text: opts.prompt }], {
    source: opts.source,
    jsonMode: true,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });

  let parsed = parseJsonFromModel(result.text);
  if (!parsed) {
    try {
      const repaired = await askGeminiParts(
        [{ text: buildProposalRepairGuide(result.text) }],
        {
          source: `${opts.source}.repair`,
          jsonMode: true,
          timeoutMs: opts.repairTimeoutMs,
          maxRetries: 0,
        },
      );
      parsed = parseJsonFromModel(repaired.text);
    } catch (error) {
      logError("travel.ai.proposal_repair_failed", {
        source: opts.source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return parsed ? normalizeProposal(parsed) : proposalFallbackFromRawText(result.text);
}

async function createProposal(opts: {
  instruction: string;
  source: string;
  userParts?: GeminiPart[];
  timeoutMs?: number;
  maxRetries?: number;
  repairTimeoutMs?: number;
  buildProposal?: (condensedTrips: unknown) => Promise<AIChangeProposal>;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { proposal: normalizeProposal(null), request_id: null };
  }

  const trips = await listTrips({ limit: 250 });
  const condensedTrips = trips.map((trip) => ({
    id: trip.id,
    category: trip.category,
    operator_name: trip.operator_name,
    route_name: trip.route_name,
    status: trip.status,
    seats_left: trip.seats_left,
    seats_total: trip.seats_total,
    has_food: trip.has_food,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    currency: trip.currency,
    duration_text: trip.duration_text,
    departure_dates: trip.departure_dates,
  }));
  const tripValidationSnapshot: TripMatchSnapshot[] = trips.map((trip) => ({
    id: trip.id,
    operator_name: trip.operator_name,
    route_name: trip.route_name,
    status: trip.status,
    seats_left: trip.seats_left,
    seats_total: trip.seats_total,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    currency: trip.currency,
  }));

  let proposal = normalizeProposal(null);
  try {
    if (typeof opts.buildProposal === "function") {
      proposal = normalizeProposal(await opts.buildProposal(condensedTrips));
    } else {
      // Route through requestProposalFromModel so the text-instruction path
      // gets the same JSON-repair + graceful fallback as the file path.
      proposal = normalizeProposal(
        await requestProposalFromModel({
          condensedTrips,
          userParts: opts.userParts || [],
          source: opts.source,
          timeoutMs: opts.timeoutMs,
          maxRetries: opts.maxRetries,
          repairTimeoutMs: opts.repairTimeoutMs,
        }),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyError(error);
    logWarn("travel.ai.proposal_failed", {
      source: opts.source,
      classification,
      message,
    });
    // Surface the real reason instead of a misleading "couldn't parse JSON".
    const rateLimited = classification.category === "rate_limited";
    const timedOut = classification.category === "timeout";
    const circuitOpen = classification.category === "circuit_open";
    const failureSummary = rateLimited
      ? "AI service is temporarily rate limited."
      : timedOut
        ? "AI service took too long to answer."
        : circuitOpen
          ? "AI service is temporarily unavailable."
          : "AI service could not generate a proposal.";
    proposal = {
      summary: failureSummary,
      needs_confirmation: true,
      important_reason: message.slice(0, 300),
      conflicts: [],
      actions: [],
    };
  }
  proposal = validateAIChangeProposal(proposal, tripValidationSnapshot).proposal;

  let inserted: Awaited<ReturnType<typeof queryNeon<{ id: number }>>> = null;
  try {
    inserted = await queryNeon<{ id: number }>(
      `
        INSERT INTO travel_ai_change_requests (
          instruction,
          proposal_json,
          conflicts,
          needs_confirmation,
          status
        )
        VALUES ($1, $2::jsonb, $3::text[], $4, 'pending')
        RETURNING id
      `,
      [
        opts.instruction,
        JSON.stringify(proposal),
        proposal.conflicts,
        proposal.needs_confirmation,
      ],
    );
  } catch (insertError) {
    logError("travel.ai.proposal_insert_failed", {
      source: opts.source,
      message:
        insertError instanceof Error ? insertError.message : String(insertError),
    });
  }

  return {
    proposal,
    request_id: inserted?.rows?.[0]?.id ?? null,
  };
}

// A pasted instruction this long is almost always bulk data (a whole price
// list), not a single command. Sending it as one giant prompt is what made the
// AI time out / hit rate limits, so above this size we route it through the
// chunk-and-merge batch pipeline instead.
const LARGE_INSTRUCTION_CHARS = 6_000;

// Heuristic: does the long text look like a multi-row price list (worth
// splitting) rather than one long sentence? Many lines or repeated price/seat
// cues signal bulk data.
function looksLikeBulkPaste(instruction: string): boolean {
  const lines = instruction.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 12) return true;
  const priceCues = (instruction.match(/₮|төгрөг|\bMNT\b|\bCNY\b|юань|\d[\d ,]{4,}/gi) || [])
    .length;
  return priceCues >= 8;
}

export async function generateAIProposal(instruction: string) {
  // Big pasted price lists go through the batched (chunk + merge) pipeline so a
  // single oversized prompt can't time out or get rate-limited. Normal short
  // commands keep the fast, direct single-request path.
  if (
    instruction.length >= LARGE_INSTRUCTION_CHARS &&
    looksLikeBulkPaste(instruction)
  ) {
    return generateAIProposalFromContentBatched({
      label: "Шивсэн прайс жагсаалт",
      contentText: instruction,
    });
  }

  return createProposal({
    instruction,
    userParts: [{ text: `Хэрэглэгчийн хүсэлт: ${instruction}` }],
    source: "travel.ops.ai_change",
    timeoutMs: AI_CHANGE_GEMINI_TIMEOUT_MS,
    maxRetries: AI_CHANGE_GEMINI_MAX_RETRIES,
    repairTimeoutMs: AI_CHANGE_REPAIR_TIMEOUT_MS,
  });
}

export async function generateAIProposalFromContent(input: {
  label?: string;
  note?: string;
  contentText?: string;
  inline?: { mimeType: string; data: string } | null;
  sources?: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
  }>;
}) {
  const parts: GeminiPart[] = [];
  const sources =
    input.sources && input.sources.length > 0
      ? input.sources
      : [
          {
            label: input.label || "upload",
            contentText: input.contentText,
            inline: input.inline,
          },
        ];

  const sourceLabels = sources.map((source) => source.label).join(", ");
  const guidance = [
    `Sources: ${sourceLabels}`,
    input.note ? `Admin note: ${input.note}` : "",
    "Extract travel information from the attached files, images, or text, including route, operator, price, seats, departure date, meals, and status.",
    "ACCURACY IS THE TOP PRIORITY. Read carefully and do not rush.",
    "Read EVERY trip/row in the source. Do not skip rows and do not stop early. If the source lists 12 trips, return actions for all 12.",
    "Never merge two different trips into one, and never split one trip into two. Each distinct route = one action.",
    "Copy prices, seat counts, and dates EXACTLY as written in the source — digit for digit. Do not round, estimate, convert, or 'fix' numbers. If a price is 4,290,000 write 4290000, not 4300000.",
    "Only use information that is actually present in the source. Never invent or guess a price, date, or field. If a field is missing, leave it out rather than filling a plausible value.",
    "If any value is unclear or hard to read, keep needs_confirmation=true and ask about that exact value in plain language instead of guessing.",
    "Ignore logos, agency names, headers, footers, contact details, and page decorations unless they are attached to a real trip row.",
    "Do not treat normal adult/child price differences as conflicts. Only flag child price if it is higher than adult price or the source is genuinely unclear.",
    "Optional add-on costs in CNY/yuan (нэмэлт төлбөр, өөрийн зардлаар, single room fees, extra attraction tickets) are not conflicts; keep them in notes/source_description.",
    "Recurring schedules such as 'Пүрэв гараг бүр' are valid departure_dates; do not report them as missing dates.",
    "If meals are generally included but specific days/meals are self-paid or unavailable, set has_food=true and write the exceptions in notes/source_description instead of raising a meal conflict.",
    "If a source lists хөтөлбөртэй and чөлөөт package prices for the same route, prefer separate actions with route names that include the variant instead of forcing one base price.",
    "Do not infer the operator from the uploaded filename when the document content already has a brand/operator.",
    "If possible, match against existing trips to update them; otherwise propose adding new trips.",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push({ text: guidance });

  for (const source of sources) {
    if (source.contentText && source.contentText.trim()) {
      parts.push({
        text: `File contents (${source.label}) (HTML/text):\n${source.contentText.trim()}`,
      });
    }
    if (source.inline) {
      parts.push({ text: `Attached binary file: ${source.label}` });
      parts.push({ inlineData: source.inline });
    }
  }

  return createProposal({
    instruction: input.note
      ? `[File] ${sourceLabels} - ${input.note}`
      : `[File] ${sourceLabels}`,
    userParts: parts,
    source: "travel.ops.file_parse",
  });
}

export async function generateAIProposalFromContentBatched(input: {
  label?: string;
  note?: string;
  contentText?: string;
  inline?: { mimeType: string; data: string } | null;
  sources?: Array<{
    label: string;
    contentText?: string;
    inline?: { mimeType: string; data: string } | null;
  }>;
}) {
  const sources =
    input.sources && input.sources.length > 0
      ? input.sources
      : [
          {
            label: input.label || "upload",
            contentText: input.contentText,
            inline: input.inline,
          },
        ];

  const sourceLabels = sources.map((source) => source.label).join(", ");
  const batches = chunkProposalSources(sources);

  return createProposal({
    instruction: input.note
      ? `[File] ${sourceLabels} - ${input.note}`
      : `[File] ${sourceLabels}`,
    source: "travel.ops.file_parse",
    buildProposal: async (condensedTrips) => {
      const proposals: AIChangeProposal[] = [];
      const startedAt = Date.now();

      for (let index = 0; index < batches.length; index += 1) {
        if (index > 0) {
          await wait(FILE_PARSE_BATCH_DELAY_MS);
        }
        const remainingMs = FILE_PARSE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
        if (remainingMs <= FILE_PARSE_MIN_BATCH_TIMEOUT_MS) {
          const remainingLabels = batches
            .slice(index)
            .flatMap((batch) => batch.map((source) => source.label))
            .join(", ");
          proposals.push({
            summary: `Stopped reading remaining batches: ${remainingLabels}`,
            needs_confirmation: true,
            important_reason:
              "The upload was too large or slow for one safe AI parse request.",
            conflicts: [
              `Stopped before reading ${remainingLabels}. Split the files into smaller requests.`,
            ],
            actions: [],
          });
          break;
        }
        const batch = batches[index];
        const { parts, sourceLabels: batchLabels } = buildBatchSourceParts({
          note: input.note,
          sources: batch,
        });
        const batchTimeoutMs = Math.min(
          FILE_PARSE_GEMINI_TIMEOUT_MS,
          Math.max(FILE_PARSE_MIN_BATCH_TIMEOUT_MS, remainingMs - 5_000),
        );
        const batchRetries =
          FILE_PARSE_GEMINI_MAX_RETRIES > 0 &&
          remainingMs >
            batchTimeoutMs + FILE_PARSE_MIN_BATCH_TIMEOUT_MS + FILE_PARSE_BATCH_DELAY_MS
            ? FILE_PARSE_GEMINI_MAX_RETRIES
            : 0;
        try {
          proposals.push(
            await requestProposalFromModel({
              condensedTrips,
              userParts: parts,
              source: "travel.ops.file_parse",
              timeoutMs: batchTimeoutMs,
              maxRetries: batchRetries,
              repairTimeoutMs: FILE_PARSE_REPAIR_TIMEOUT_MS,
              model: FILE_PARSE_MODEL,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logError("travel.ai.file_batch_failed", {
            source: "travel.ops.file_parse",
            batchLabels,
            message,
          });
          proposals.push({
            summary: `Could not finish reading batch: ${batchLabels}`,
            needs_confirmation: true,
            important_reason:
              "One batch of uploaded files took too long or failed upstream, so the result may be incomplete.",
            conflicts: [`Batch failed for ${batchLabels}: ${message}`],
            actions: [],
          });
        }
      }

      return mergeBatchProposals(proposals, batches.length);
    },
  });
}

function buildProposalRevisionGuide(input: {
  instruction: string;
  currentProposal: AIChangeProposal;
  clarification: string;
  condensedTrips: unknown;
}) {
  return [
    "You are revising an existing travel-ops proposal after a short admin clarification.",
    "Return JSON only using the same schema as before.",
    "Keep high-confidence extracted data unless the clarification changes it.",
    "Resolve only the directly affected uncertainty. Do not invent missing facts.",
    "If the clarification clearly answers a conflict, remove that conflict from the output.",
    "If uncertainty still remains, keep needs_confirmation=true and keep only the unresolved conflicts.",
    "Any remaining conflict/question must be in plain, friendly Mongolian like a travel agent — never mention internal IDs or field names (no 'seed-33', 'trip_id', 'route_name', 'status='). Refer to trips by their quoted name.",
    "",
    "JSON schema:",
    "{",
    '  "summary": "short summary",',
    '  "needs_confirmation": true/false,',
    '  "important_reason": "why confirmation is still needed",',
    '  "conflicts": ["remaining conflict"],',
    '  "actions": [',
    '    { "action": "upsert|patch|cancel", "trip_id": "", "match": { "operator_name": "", "route_name": "" }, "fields": {} }',
    "  ]",
    "}",
    "",
    `Original admin request: ${input.instruction}`,
    `Admin clarification: ${input.clarification}`,
    `Current proposal JSON: ${JSON.stringify(input.currentProposal)}`,
    `Current trips (JSON): ${JSON.stringify(input.condensedTrips)}`,
  ].join("\n");
}

export async function reviseAIRequest(
  requestId: number,
  clarification: string,
) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured." };
  }

  const reqResult = await queryNeon<{
    id: number;
    instruction: string;
    proposal_json: AIChangeProposal;
    status: string;
  }>(
    `
      SELECT id, instruction, proposal_json, status
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) {
    return { ok: false, message: "Change request not found." };
  }
  if (row.status === "applied") {
    return { ok: false, message: "Request is already applied." };
  }

  const currentProposal = normalizeProposal(row.proposal_json);
  const trips = await listTrips({ limit: 250 });
  const condensedTrips = trips.map((trip) => ({
    id: trip.id,
    category: trip.category,
    operator_name: trip.operator_name,
    route_name: trip.route_name,
    status: trip.status,
    seats_left: trip.seats_left,
    seats_total: trip.seats_total,
    has_food: trip.has_food,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    currency: trip.currency,
    duration_text: trip.duration_text,
    departure_dates: trip.departure_dates,
  }));

  const prompt = buildProposalRevisionGuide({
    instruction: row.instruction,
    currentProposal,
    clarification,
    condensedTrips,
  });

  const revisedProposal = await requestProposalFromPrompt({
    prompt,
    source: "travel.ops.ai_clarify",
    timeoutMs: 30_000,
    maxRetries: 0,
    repairTimeoutMs: 15_000,
  });

  await queryNeon(
    `
      UPDATE travel_ai_change_requests
      SET
        proposal_json = $2::jsonb,
        conflicts = $3::text[],
        needs_confirmation = $4
      WHERE id = $1
    `,
    [
      requestId,
      JSON.stringify(revisedProposal),
      revisedProposal.conflicts,
      revisedProposal.needs_confirmation,
    ],
  );

  return {
    ok: true,
    proposal: revisedProposal,
    request_id: requestId,
    requires_confirmation: Boolean(revisedProposal.needs_confirmation),
  };
}

async function applyAIAction(action: AITripAction) {
  if (!action || typeof action !== "object") {
    return { ok: false, message: "Invalid action payload." };
  }

  const verb = String(action.action || "").trim().toLowerCase();
  if (!verb) return { ok: false, message: "Missing action verb." };

  if (verb === "upsert") {
    let targetId = action.trip_id?.trim() || "";
    if (!targetId && action.match) {
      const match = await resolveTripIdByMatch(action.match);
      if (
        match.conflict &&
        !/matching trip not found/i.test(match.conflict)
      ) {
        return { ok: false, message: match.conflict };
      }
      targetId = match.id || "";
    }
    const before = targetId ? await getTripById(targetId) : null;
    const updated = await upsertTrip({
      id: targetId || undefined,
      fields: action.fields || {},
    });
    if (!updated) return { ok: false, message: "Upsert failed." };
    return {
      ok: true,
      message: `Upserted ${updated.id}`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  let targetId = action.trip_id?.trim() || "";
  if (!targetId) {
    const match = await resolveTripIdByMatch(action.match);
    if (match.conflict) return { ok: false, message: match.conflict };
    targetId = match.id || "";
  }
  if (!targetId) return { ok: false, message: "Target trip not found." };

  if (verb === "cancel") {
    const before = await getTripById(targetId);
    const updated = await patchTrip(targetId, {
      status: "cancelled",
      ...(action.fields || {}),
    });
    if (!updated) return { ok: false, message: "Cancel update failed." };
    return {
      ok: true,
      message: `Cancelled ${updated.id}`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  if (verb === "patch") {
    const before = await getTripById(targetId);
    const updated = await patchTrip(targetId, action.fields || {});
    if (!updated) return { ok: false, message: "Patch update failed." };
    return {
      ok: true,
      message: `Patched ${updated.id}`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  return { ok: false, message: `Unsupported action: ${verb}` };
}

export async function applyAIRequest(requestId: number) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured." };
  }

  const reqResult = await queryNeon<{
    id: number;
    proposal_json: AIChangeProposal;
    needs_confirmation: boolean;
    status: string;
  }>(
    `
      SELECT id, proposal_json, needs_confirmation, status
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) return { ok: false, message: "Change request not found." };
  if (row.status === "applied") {
    return {
      ok: true,
      message: "Request already applied.",
      results: [] as string[],
      request_id: requestId,
    };
  }

  const proposal = normalizeProposal(row.proposal_json);
  const trips = await listTrips({ limit: 250 });
  const validation = validateAIChangeProposal(proposal, trips);
  if (validation.blocking_conflicts.length > 0) {
    await queryNeon(
      `
        UPDATE travel_ai_change_requests
        SET
          proposal_json = $2::jsonb,
          conflicts = $3::text[],
          needs_confirmation = TRUE,
          status = 'error'
        WHERE id = $1
      `,
      [
        requestId,
        JSON.stringify(validation.proposal),
        validation.proposal.conflicts,
      ],
    );
    return {
      ok: false,
      message: "Proposal failed validation before saving.",
      results: validation.blocking_conflicts,
      proposal: validation.proposal,
    };
  }

  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of validation.proposal.actions) {
    const result = await applyAIAction(action);
    results.push(result.message);
    if (result.ok && result.snapshot) snapshots.push(result.snapshot);
    if (!result.ok) failed = true;
  }

  const status = failed ? "error" : "applied";
  await queryNeon(
    `
      UPDATE travel_ai_change_requests
      SET
        status = $2,
        rollback_json = $3::jsonb,
        applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE NULL END,
        reverted_at = NULL
      WHERE id = $1
    `,
    [requestId, status, JSON.stringify(snapshots)],
  );

  return {
    ok: !failed,
    message: failed
      ? "Some actions failed. Review results."
      : "All actions applied successfully.",
    results,
    proposal: validation.proposal,
    request_id: requestId,
  };
}

export async function applyAIProposalDirect(
  proposal: AIChangeProposal,
  instruction: string,
) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured.", results: [] as string[] };
  }

  const trips = await listTrips({ limit: 250 });
  const validation = validateAIChangeProposal(proposal, trips);
  const normalised = validation.proposal;
  if (validation.blocking_conflicts.length > 0) {
    return {
      ok: false,
      message: "Proposal failed validation before saving.",
      results: validation.blocking_conflicts,
      proposal: normalised,
    };
  }
  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of normalised.actions) {
    const result = await applyAIAction(action);
    results.push(result.message);
    if (result.ok && result.snapshot) snapshots.push(result.snapshot);
    if (!result.ok) failed = true;
  }

  const status = failed ? "error" : "applied";
  let insertedRequestId: number | null = null;
  try {
    const inserted = await queryNeon<{ id: number }>(
      `
        INSERT INTO travel_ai_change_requests (
          instruction, proposal_json, conflicts, needs_confirmation, status, applied_at, rollback_json
        )
        VALUES ($1, $2::jsonb, $3::text[], $4, $5, CASE WHEN $5 = 'applied' THEN NOW() ELSE NULL END, $6::jsonb)
        RETURNING id
      `,
      [
        instruction,
        JSON.stringify(normalised),
        normalised.conflicts,
        normalised.needs_confirmation,
        status,
        JSON.stringify(snapshots),
      ],
    );
    insertedRequestId = inserted?.rows?.[0]?.id ?? null;
  } catch (insertError) {
    logError("travel.ai.direct_apply_insert_failed", {
      message:
        insertError instanceof Error ? insertError.message : String(insertError),
    });
  }

  return {
    ok: !failed,
    message: failed
      ? "Some actions failed. Review results."
      : "All actions applied successfully.",
    results,
    proposal: normalised,
    request_id: insertedRequestId,
  };
}

function normalizeActionSnapshots(value: unknown): AIActionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Partial<AIActionSnapshot>;
      const tripId = String(entry.trip_id || "").trim();
      if (!tripId) return null;
      return {
        action:
          entry.action && typeof entry.action === "object"
            ? (entry.action as AITripAction)
            : { action: "unknown" },
        trip_id: tripId,
        before: entry.before
          ? mapTripRow(entry.before as unknown as Record<string, unknown>)
          : null,
        after: entry.after
          ? mapTripRow(entry.after as unknown as Record<string, unknown>)
          : null,
      };
    })
    .filter((item): item is AIActionSnapshot => Boolean(item));
}

export async function rollbackAIRequest(requestId: number) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured.", results: [] as string[] };
  }

  const reqResult = await queryNeon<{
    id: number;
    status: string;
    rollback_json: unknown;
  }>(
    `
      SELECT id, status, rollback_json
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) {
    return { ok: false, message: "Change request not found.", results: [] as string[] };
  }
  if (row.status === "reverted") {
    return { ok: true, message: "Request is already rolled back.", results: [] as string[] };
  }

  const snapshots = normalizeActionSnapshots(row.rollback_json);
  if (snapshots.length === 0) {
    return {
      ok: false,
      message: "No rollback snapshot is available for this request.",
      results: [] as string[],
    };
  }

  const results: string[] = [];
  let failed = false;

  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.before) {
      const restored = await upsertTrip({
        id: snapshot.trip_id,
        fields: snapshot.before,
      });
      if (restored) {
        results.push(`Restored ${snapshot.trip_id}`);
      } else {
        failed = true;
        results.push(`Failed to restore ${snapshot.trip_id}`);
      }
      continue;
    }

    const deleted = await deleteTrip(snapshot.trip_id);
    if (deleted) {
      results.push(`Removed AI-created trip ${snapshot.trip_id}`);
    } else {
      results.push(`AI-created trip ${snapshot.trip_id} was already absent`);
    }
  }

  if (!failed) {
    await queryNeon(
      `
        UPDATE travel_ai_change_requests
        SET status = 'reverted', reverted_at = NOW()
        WHERE id = $1
      `,
      [requestId],
    );
  }

  return {
    ok: !failed,
    message: failed
      ? "Rollback finished with errors. Review results."
      : "Rollback completed successfully.",
    results,
  };
}

/* ----------------------------------------------------------------
   Leads — human-handoff requests and booking-intent captures
   ---------------------------------------------------------------- */
export type LeadKind = "handoff" | "booking";

export type TravelLead = {
  id: number;
  kind: LeadKind;
  platform: string;
  sender_id: string;
  customer_message: string;
  contact_phone: string;
  context: string;
  status: "new" | "seen";
  created_at: string;
  seen_at: string | null;
};

function mapLeadRow(row: Record<string, unknown>): TravelLead {
  const kind = row.kind === "booking" ? "booking" : "handoff";
  return {
    id: Number(row.id),
    kind,
    platform: String(row.platform || ""),
    sender_id: String(row.sender_id || ""),
    customer_message: String(row.customer_message || ""),
    contact_phone: String(row.contact_phone || ""),
    context: String(row.context || ""),
    status: row.status === "seen" ? "seen" : "new",
    created_at: String(row.created_at || ""),
    seen_at: row.seen_at ? String(row.seen_at) : null,
  };
}

/**
 * Returns true if an unresolved lead of the same kind already exists for this
 * sender within the lookback window — used to avoid spamming duplicate leads
 * when a customer sends several intent messages in a row.
 */
export async function hasRecentOpenLead(
  senderId: string,
  kind: LeadKind,
  withinMs = 6 * 60 * 60 * 1000,
): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM travel_leads
      WHERE sender_id = $1
        AND kind = $2
        AND status = 'new'
        AND created_at > NOW() - ($3::int * INTERVAL '1 millisecond')
    `,
    [senderId, kind, withinMs],
  );
  return Number(result?.rows?.[0]?.count || 0) > 0;
}

export async function createLead(input: {
  kind: LeadKind;
  platform: string;
  senderId: string;
  customerMessage: string;
  contactPhone?: string;
  context?: string;
}): Promise<TravelLead | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_leads (
        kind, platform, sender_id, customer_message, contact_phone, context, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'new')
      RETURNING *
    `,
    [
      input.kind,
      input.platform,
      input.senderId,
      input.customerMessage.slice(0, 2000),
      (input.contactPhone || "").slice(0, 40),
      (input.context || "").slice(0, 4000),
    ],
  );
  return result?.rows?.[0] ? mapLeadRow(result.rows[0]) : null;
}

export async function listLeads(limit = 50): Promise<TravelLead[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT *
      FROM travel_leads
      ORDER BY (status = 'new') DESC, created_at DESC
      LIMIT $1
    `,
    [safeLimit],
  );
  return result?.rows ? result.rows.map(mapLeadRow) : [];
}

export async function countNewLeads(): Promise<number> {
  const ready = await ensureTravelSchema();
  if (!ready) return 0;
  const result = await queryNeon<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM travel_leads WHERE status = 'new'`,
  );
  return Number(result?.rows?.[0]?.count || 0);
}

export async function markLeadSeen(id: number): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `UPDATE travel_leads SET status = 'seen', seen_at = NOW() WHERE id = $1`,
    [id],
  );
  return (result?.rowCount ?? 0) > 0;
}

export type LeadStats = {
  total: number;
  new_count: number;
  today: number;
  last7days: number;
  last30days: number;
  by_platform: Array<{ platform: string; count: number }>;
  by_kind: Array<{ kind: string; count: number }>;
  daily: Array<{ day: string; count: number }>;
};

/** Aggregated lead numbers for the dashboard. Safe defaults if DB is absent. */
export async function getLeadStats(): Promise<LeadStats> {
  const empty: LeadStats = {
    total: 0,
    new_count: 0,
    today: 0,
    last7days: 0,
    last30days: 0,
    by_platform: [],
    by_kind: [],
    daily: [],
  };
  const ready = await ensureTravelSchema();
  if (!ready) return empty;

  const [totals, platforms, kinds, daily] = await Promise.all([
    queryNeon<{
      total: string;
      new_count: string;
      today: string;
      last7days: string;
      last30days: string;
    }>(`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'new')::text AS new_count,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::text AS today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text AS last7days,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::text AS last30days
      FROM travel_leads
    `),
    queryNeon<{ platform: string; count: string }>(`
      SELECT COALESCE(NULLIF(platform, ''), 'unknown') AS platform, COUNT(*)::text AS count
      FROM travel_leads
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ kind: string; count: string }>(`
      SELECT COALESCE(NULLIF(kind, ''), 'handoff') AS kind, COUNT(*)::text AS count
      FROM travel_leads
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ day: string; count: string }>(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::text AS count
      FROM travel_leads
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const t = totals?.rows?.[0];
  return {
    total: Number(t?.total || 0),
    new_count: Number(t?.new_count || 0),
    today: Number(t?.today || 0),
    last7days: Number(t?.last7days || 0),
    last30days: Number(t?.last30days || 0),
    by_platform: (platforms?.rows || []).map((r) => ({
      platform: r.platform,
      count: Number(r.count || 0),
    })),
    by_kind: (kinds?.rows || []).map((r) => ({
      kind: r.kind,
      count: Number(r.count || 0),
    })),
    daily: (daily?.rows || []).map((r) => ({
      day: r.day,
      count: Number(r.count || 0),
    })),
  };
}

export async function readKnowledgeDataFromTrips(): Promise<KnowledgeData> {
  const trips = await listTrips({ limit: 5000 });
  const settings = await getTravelBotSettings();

  const categories = new Map<string, string[]>();
  for (const trip of trips) {
    const key = trip.category || "Uncategorized";
    if (!categories.has(key)) categories.set(key, []);
    categories.get(key)?.push(trip.route_name);
  }

  const packages = Array.from(categories.entries()).map(([category, routes]) => ({
    name: category,
    duration: "Varies by departure date",
    price: "NEEDS_MANUAL_FIX" as ProgramPrice,
    target: "Travel category",
    description: routes.join("; "),
  }));

  const modules = trips.map((trip) => {
    const details: string[] = [];
    if (trip.departure_dates.length) {
      details.push(`Departure dates: ${trip.departure_dates.join(", ")}`);
    }
    // Stock: e-com reads seats_left as "in stock" count so the bot can answer
    // "do you have X / how many left / is it sold out".
    if (trip.seats_left != null) {
      details.push(`In stock: ${trip.seats_left}`);
    }
    if (trip.has_food != null) {
      details.push(`Food: ${trip.has_food ? "yes" : "no"}`);
    }
    if (trip.status === "sold_out") {
      details.push("Status: OUT OF STOCK");
    } else if (trip.status !== "active") {
      details.push(`Status: ${trip.status}`);
    }
    if (trip.notes) details.push(`Notes: ${trip.notes}`);
    // Buy-link: each product can carry a buy_url (in trip.extra). When present, the
    // bot includes it so it can tell the customer exactly where to buy.
    const buyUrl =
      typeof trip.extra?.buy_url === "string" ? trip.extra.buy_url.trim() : "";
    if (buyUrl) details.push(`Buy link: ${buyUrl}`);

    return {
      name: trip.route_name,
      duration: trip.duration_text || "Unknown",
      price:
        typeof trip.adult_price === "number"
          ? trip.adult_price
          : ("NEEDS_MANUAL_FIX" as ProgramPrice),
      target: trip.operator_name,
      description: [trip.source_description, ...details].filter(Boolean).join(" | "),
    };
  });

  return {
    packages,
    modules,
    special_offers: settings.special_offers,
    discount_policies: settings.discount_policies,
    verified_credentials: settings.verified_credentials,
    faq: settings.faq,
    conflicts_found: [],
  };
}

export async function getDbDiagnostics() {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return {
      configured: Boolean(env.neonDatabaseUrl),
      schemaReady: false,
      trips: 0,
      lastUpdatedAt: null as string | null,
      settingsConfigured: false,
      settingsUpdatedAt: null as string | null,
    };
  }
  const result = await queryNeon<{ count: string; max_updated_at: string | null }>(
    `
      SELECT
        COUNT(*)::text AS count,
        MAX(updated_at)::text AS max_updated_at
      FROM travel_trip_entries
    `,
  );
  const settings = await getTravelBotSettings();
  return {
    configured: Boolean(env.neonDatabaseUrl),
    schemaReady: true,
    trips: Number(result?.rows?.[0]?.count || 0),
    lastUpdatedAt: result?.rows?.[0]?.max_updated_at || null,
    settingsConfigured: Boolean(
      settings.business_name.trim() && settings.system_prompt.trim(),
    ),
    settingsUpdatedAt: settings.updated_at || null,
  };
}

export async function maybeRecordTravelMetric(action: string) {
  recordCounter("travel.ops.action_total", 1, { action });
}
