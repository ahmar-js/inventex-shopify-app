import assert from "node:assert/strict";
import test from "node:test";
import { isDigestDue } from "../app/services/alerts-schedule.ts";

const schedule = (overrides = {}) => ({
  alertFrequency: "DAILY",
  dailyAlertHour: 9,
  dailyAlertAmPm: "AM",
  dailyAlertTimezone: "America/New_York",
  weeklyDigestDay: 1,
  lastDigestSentAt: null,
  ...overrides,
});

test("daily digest sends once per local calendar day", () => {
  const now = new Date("2026-08-24T14:00:00.000Z"); // Monday 10am EDT
  assert.equal(isDigestDue(schedule(), now), true);
  assert.equal(
    isDigestDue(
      schedule({ lastDigestSentAt: new Date("2026-08-24T13:00:00.000Z") }),
      now,
    ),
    false,
  );
  assert.equal(
    isDigestDue(
      schedule({ lastDigestSentAt: new Date("2026-08-23T14:00:00.000Z") }),
      now,
    ),
    true,
  );
});

test("Intl timezone conversion observes DST and half-hour offsets", () => {
  assert.equal(
    isDigestDue(schedule(), new Date("2026-07-01T12:59:00.000Z")),
    false,
  );
  assert.equal(
    isDigestDue(schedule(), new Date("2026-07-01T13:00:00.000Z")),
    true,
  );
  assert.equal(
    isDigestDue(
      schedule({ dailyAlertTimezone: "Asia/Kolkata" }),
      new Date("2026-07-01T03:30:00.000Z"),
    ),
    true,
  );
});

test("weekly digest never sends on another weekday", () => {
  assert.equal(
    isDigestDue(
      schedule({ alertFrequency: "WEEKLY" }),
      new Date("2026-08-25T14:00:00.000Z"),
    ),
    false,
  );
});

test("weekly digest requires seven days since the last successful send", () => {
  const now = new Date("2026-08-31T14:00:00.000Z");
  assert.equal(
    isDigestDue(
      schedule({
        alertFrequency: "WEEKLY",
        lastDigestSentAt: new Date("2026-08-24T14:00:01.000Z"),
      }),
      now,
    ),
    false,
  );
  assert.equal(
    isDigestDue(
      schedule({
        alertFrequency: "WEEKLY",
        lastDigestSentAt: new Date("2026-08-24T14:00:00.000Z"),
      }),
      now,
    ),
    true,
  );
});

test("invalid timezones and immediate frequency fail closed", () => {
  const now = new Date("2026-08-24T14:00:00.000Z");
  assert.equal(
    isDigestDue(schedule({ dailyAlertTimezone: "Not/A_Timezone" }), now),
    false,
  );
  assert.equal(isDigestDue(schedule({ alertFrequency: "IMMEDIATE" }), now), false);
});
