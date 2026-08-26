export interface DigestSchedule {
  alertFrequency: string;
  dailyAlertHour: number;
  dailyAlertAmPm: string;
  dailyAlertTimezone: string;
  weeklyDigestDay: number;
  lastDigestSentAt: Date | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
export const IMMEDIATE_BATCH_WINDOW_MS = 2 * 60 * 1_000;
export const IMMEDIATE_BATCH_MAX_WAIT_MS = 15 * 60 * 1_000;
const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface LocalParts {
  dateKey: string;
  weekday: number;
  minutes: number;
}

export function isImmediateBatchDue(
  latestQueuedAt: Date,
  now = new Date(),
  oldestQueuedAt = latestQueuedAt,
): boolean {
  const quietFor = now.getTime() - latestQueuedAt.getTime();
  const waitingFor = now.getTime() - oldestQueuedAt.getTime();
  return (
    Number.isFinite(quietFor) &&
    Number.isFinite(waitingFor) &&
    (quietFor >= IMMEDIATE_BATCH_WINDOW_MS ||
      waitingFor >= IMMEDIATE_BATCH_MAX_WAIT_MS)
  );
}

export function isDigestDue(
  settings: DigestSchedule,
  now = new Date(),
): boolean {
  if (
    settings.alertFrequency !== "DAILY" &&
    settings.alertFrequency !== "WEEKLY"
  ) {
    return false;
  }

  const current = localParts(now, settings.dailyAlertTimezone);
  if (!current) return false;

  const targetMinutes =
    to24Hour(settings.dailyAlertHour, settings.dailyAlertAmPm) * 60;
  if (current.minutes < targetMinutes) return false;

  const lastSent = settings.lastDigestSentAt;
  if (settings.alertFrequency === "DAILY") {
    if (!lastSent) return true;
    const previous = localParts(lastSent, settings.dailyAlertTimezone);
    return previous !== null && previous.dateKey !== current.dateKey;
  }

  const weekday = Math.max(0, Math.min(6, settings.weeklyDigestDay));
  if (current.weekday !== weekday) return false;
  return !lastSent || now.getTime() >= lastSent.getTime() + WEEK_MS;
}

function localParts(date: Date, timeZone: string): LocalParts | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter(({ type }) => type !== "literal")
        .map(({ type, value }) => [type, value]),
    );
    const weekday = WEEKDAYS[parts.weekday];
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (
      weekday === undefined ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      weekday,
      minutes: hour * 60 + minute,
    };
  } catch {
    return null;
  }
}

function to24Hour(hour: number, amPm: string) {
  const normalized = Math.max(1, Math.min(12, Math.trunc(hour))) % 12;
  return amPm === "PM" ? normalized + 12 : normalized;
}
