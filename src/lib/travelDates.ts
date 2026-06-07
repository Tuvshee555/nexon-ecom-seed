import type { TravelTrip } from "./travelOps";

export const MONGOLIA_TIME_ZONE = "Asia/Ulaanbaatar";

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type RequestedDate = {
  ymd: string;
  label: string;
  source: "relative" | "explicit";
};

type DepartureDateMatch = {
  trip: TravelTrip;
  matchedDateText: string;
};

const MN_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: MONGOLIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const RELATIVE_DATE_PATTERNS: Array<{
  offsetDays: number;
  label: string;
  patterns: RegExp[];
}> = [
  {
    offsetDays: 0,
    label: "өнөөдөр",
    patterns: [/\b(today|unuudur|unuudur|onooodor)\b/i, /өнөөдөр/i],
  },
  {
    offsetDays: 1,
    label: "маргааш",
    patterns: [/\b(tomorrow|margaash|margash)\b/i, /маргааш/i],
  },
  {
    offsetDays: 2,
    label: "нөгөөдөр",
    patterns: [/\b(day after tomorrow|nuguudur|nuguudor|nogoodor)\b/i, /н[өо]г[өо]{2}дөр/i],
  },
];

function getMongoliaDateParts(now = new Date()): DateParts {
  const parts = MN_DATE_FORMAT.formatToParts(now);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
  };
}

function toYmd(parts: DateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function inferYear(month: number, day: number, now = new Date()): number {
  const today = getMongoliaDateParts(now);
  const candidate = { year: today.year, month, day };
  if (!isValidDateParts(candidate.year, candidate.month, candidate.day)) {
    return today.year;
  }
  return toYmd(candidate) >= toYmd(today) ? today.year : today.year + 1;
}

function explicitDateCandidates(text: string, now = new Date()): DateParts[] {
  const candidates: DateParts[] = [];
  const push = (year: number, month: number, day: number) => {
    if (!isValidDateParts(year, month, day)) return;
    const ymd = toYmd({ year, month, day });
    if (!candidates.some((candidate) => toYmd(candidate) === ymd)) {
      candidates.push({ year, month, day });
    }
  };

  for (const match of text.matchAll(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g)) {
    push(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  for (const match of text.matchAll(
    /(?:(20\d{2})\s*(?:оны|он|onii|oni|on)?\s*)?(\d{1,2})\s*(?:-?\s*р)?\s*(?:сарын|сар|sariin|sar)\s*(\d{1,2})/gi,
  )) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    push(match[1] ? Number(match[1]) : inferYear(month, day, now), month, day);
  }

  for (const match of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})\b/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    push(inferYear(month, day, now), month, day);
  }

  return candidates;
}

export function resolveRequestedDate(
  text: string,
  now = new Date(),
): RequestedDate | null {
  const today = getMongoliaDateParts(now);

  for (const candidate of RELATIVE_DATE_PATTERNS) {
    if (!candidate.patterns.some((pattern) => pattern.test(text))) continue;
    return {
      ymd: toYmd(addDays(today, candidate.offsetDays)),
      label: candidate.label,
      source: "relative",
    };
  }

  const explicit = explicitDateCandidates(text, now)[0];
  if (!explicit) return null;
  return {
    ymd: toYmd(explicit),
    label: toYmd(explicit),
    source: "explicit",
  };
}

export function parseDepartureDateText(text: string, now = new Date()): string[] {
  return explicitDateCandidates(text, now).map(toYmd);
}

function isDepartureAvailabilityQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const hasTravelSignal =
    /аялал|aylal|tour|trip|гар|garah|гарах|явах|yavah|departure|өдөр|ognoo|date/.test(
      normalized,
    );
  const hasQuestionSignal =
    /байна|baina|\?|уу|uu|боломж|bolomj|available|гарах|garah|явах|yavah/.test(
      normalized,
    );

  return hasTravelSignal && hasQuestionSignal;
}

export function hasDepartureDateAvailabilityIntent(text: string, now = new Date()): boolean {
  return Boolean(resolveRequestedDate(text, now)) && isDepartureAvailabilityQuestion(text);
}

function formatMoney(value: number | null, currency: string): string {
  if (typeof value !== "number") return "";
  return `${value.toLocaleString("mn-MN")}${currency || "MNT"}`;
}

function formatTripSummary(match: DepartureDateMatch): string {
  const { trip } = match;
  const details: string[] = [];
  const adultPrice = formatMoney(trip.adult_price, trip.currency);
  if (adultPrice) details.push(`том хүн ${adultPrice}`);
  if (typeof trip.seats_left === "number") details.push(`${trip.seats_left} суудал`);

  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `${trip.route_name} — ${trip.operator_name}${suffix}`;
}

function findDepartureMatches(
  trips: TravelTrip[],
  requestedYmd: string,
  now = new Date(),
): DepartureDateMatch[] {
  const matches: DepartureDateMatch[] = [];
  for (const trip of trips) {
    if (trip.status !== "active") continue;
    for (const dateText of trip.departure_dates || []) {
      const parsedDates = parseDepartureDateText(dateText, now);
      if (!parsedDates.includes(requestedYmd)) continue;
      matches.push({ trip, matchedDateText: dateText });
      break;
    }
  }
  return matches;
}

function findUpcomingDepartures(
  trips: TravelTrip[],
  afterYmd: string,
  now = new Date(),
): Array<{ ymd: string; trip: TravelTrip }> {
  const upcoming: Array<{ ymd: string; trip: TravelTrip }> = [];
  const seen = new Set<string>();

  for (const trip of trips) {
    if (trip.status !== "active") continue;
    for (const dateText of trip.departure_dates || []) {
      for (const ymd of parseDepartureDateText(dateText, now)) {
        if (ymd < afterYmd) continue;
        const key = `${ymd}:${trip.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        upcoming.push({ ymd, trip });
      }
    }
  }

  return upcoming.sort((a, b) => a.ymd.localeCompare(b.ymd)).slice(0, 5);
}

export function buildTemporalPromptContext(userText: string, now = new Date()): string {
  const today = getMongoliaDateParts(now);
  const tomorrow = addDays(today, 1);
  const dayAfterTomorrow = addDays(today, 2);
  const requested = resolveRequestedDate(userText, now);

  const lines = [
    `Current date in ${MONGOLIA_TIME_ZONE}: ${toYmd(today)}.`,
    `"маргааш" / "margaash" / "tomorrow" means ${toYmd(tomorrow)}.`,
    `"нөгөөдөр" / "nuguudur" means ${toYmd(dayAfterTomorrow)}.`,
  ];
  if (requested) {
    lines.push(`The user's requested date resolves to ${requested.ymd}.`);
  }
  return lines.join(" ");
}

export function buildDepartureDateAvailabilityReply(input: {
  userText: string;
  trips: TravelTrip[];
  now?: Date;
}): string | null {
  const now = input.now || new Date();
  const requested = resolveRequestedDate(input.userText, now);
  if (!requested || !hasDepartureDateAvailabilityIntent(input.userText, now)) return null;

  const matches = findDepartureMatches(input.trips, requested.ymd, now);
  const dateLabel =
    requested.source === "relative" ? `${requested.label} (${requested.ymd})` : requested.ymd;

  if (matches.length > 0) {
    const shown = matches.slice(0, 4).map(formatTripSummary).join("; ");
    const extra =
      matches.length > 4 ? ` Нийт ${matches.length} аялал таарч байна.` : "";
    return `Тийм ээ, ${dateLabel} гарах аялал байна: ${shown}.${extra} Суудал болон захиалгыг баталгаажуулахын тулд нэр, утсаа үлдээгээрэй.`;
  }

  const upcoming = findUpcomingDepartures(input.trips, requested.ymd, now);
  if (upcoming.length > 0) {
    const options = upcoming
      .map(({ ymd, trip }) => `${ymd}: ${trip.route_name} — ${trip.operator_name}`)
      .join("; ");
    return `${dateLabel} гарах аялал одоогийн мэдээлэлд алга байна. Ойрын гарах өдрүүд: ${options}.`;
  }

  return `${dateLabel} гарах аялал одоогийн мэдээлэлд алга байна. Одоогоор баталгаатай гарах өдөр бүртгэгдээгүй байна.`;
}
