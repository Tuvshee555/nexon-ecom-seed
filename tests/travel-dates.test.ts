import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDepartureDateAvailabilityReply,
  buildTemporalPromptContext,
  hasDepartureDateAvailabilityIntent,
  parseDepartureDateText,
  resolveRequestedDate,
} from "../src/lib/travelDates";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW_IN_MONGOLIA = new Date("2026-05-30T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Бээжин аялал",
    duration_text: "4 өдөр",
    adult_price: 2500000,
    child_price: null,
    currency: "MNT",
    departure_dates: [],
    seats_total: 20,
    seats_left: 6,
    has_food: true,
    status: "active",
    notes: "",
    source_description: "",
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("resolves margaash/tomorrow against Mongolia time", () => {
  const requested = resolveRequestedDate(
    "margaash garah aylal baina uu",
    NOW_IN_MONGOLIA,
  );

  assert.equal(requested?.ymd, "2026-05-31");
  assert.equal(requested?.label, "маргааш");
});

test("parses common stored departure date formats", () => {
  assert.deepEqual(parseDepartureDateText("2026.05.31", NOW_IN_MONGOLIA), [
    "2026-05-31",
  ]);
  assert.deepEqual(parseDepartureDateText("5 сарын 31", NOW_IN_MONGOLIA), [
    "2026-05-31",
  ]);
});

test("answers direct tomorrow availability from active trip dates", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "маргааш гарах аялал байна уу",
    now: NOW_IN_MONGOLIA,
    trips: [
      trip({ departure_dates: ["2026-05-31"] }),
      trip({
        id: "cancelled",
        route_name: "Цуцлагдсан аялал",
        departure_dates: ["2026-05-31"],
        status: "cancelled",
      }),
    ],
  });

  assert.match(reply || "", /Тийм ээ/);
  assert.match(reply || "", /2026-05-31/);
  assert.match(reply || "", /Бээжин аялал/);
  assert.doesNotMatch(reply || "", /Цуцлагдсан/);
});

test("answers no for missing target date and suggests upcoming departures", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "tomorrow departure available?",
    now: NOW_IN_MONGOLIA,
    trips: [trip({ departure_dates: ["2026-06-02"] })],
  });

  assert.match(reply || "", /алга байна/);
  assert.match(reply || "", /2026-06-02/);
  assert.doesNotMatch(reply || "", /ямар огноо|тодруулах/i);
});

test("answers direct date availability even when there are no trips", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "margaash garah aylal baina uu",
    now: NOW_IN_MONGOLIA,
    trips: [],
  });

  assert.match(reply || "", /2026-05-31/);
  assert.match(reply || "", /алга байна/);
  assert.doesNotMatch(reply || "", /ямар огноо|тодруулах/i);
});

test("recognizes date availability even when the user also wants to book", () => {
  assert.equal(
    hasDepartureDateAvailabilityIntent(
      "margaash garah aylal baina uu zahialah gesen yum",
      NOW_IN_MONGOLIA,
    ),
    true,
  );
});

test("prompt context tells the model what tomorrow means", () => {
  const context = buildTemporalPromptContext("margaash?", NOW_IN_MONGOLIA);

  assert.match(context, /Current date .*2026-05-30/);
  assert.match(context, /tomorrow.*2026-05-31/);
  assert.match(context, /requested date resolves to 2026-05-31/);
});
