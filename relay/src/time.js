// Calendar helpers for budgets. "Today" is the Asia/Seoul calendar day.
// Korea has no daylight saving time, so KST is always UTC+9 and plain offset arithmetic is exact.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Header a test run uses to pin the clock. Honoured only when the Worker runs with TEST_MODE=1. */
export const TEST_NOW_HEADER = 'x-relay-test-now';

/** "YYYY-MM-DD" of the KST day containing `ms`. */
export function kstDay(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM" of the KST month containing `ms`. */
export function kstMonth(ms) {
  return kstDay(ms).slice(0, 7);
}

/** Epoch ms of the next 00:00 KST after `ms` (when today's budgets reset). */
export function nextKstMidnight(ms) {
  return (Math.floor((ms + KST_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - KST_OFFSET_MS;
}

/** The last `count` KST days ending with the day of `ms`, newest first. */
export function kstDaysBack(ms, count) {
  const days = [];
  for (let i = 0; i < count; i++) days.push(kstDay(ms - i * DAY_MS));
  return days;
}

/**
 * The time a request is handled at. Tests may pin it with the x-relay-test-now header (ISO date or epoch ms),
 * but only when `testMode` is on; production ignores the header.
 * @param {Request} request
 * @param {boolean} testMode
 */
export function requestNow(request, testMode) {
  if (testMode) {
    const raw = request.headers.get(TEST_NOW_HEADER);
    if (raw) {
      const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return Date.now();
}
