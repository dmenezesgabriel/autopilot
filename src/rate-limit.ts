/** What a rate-limit signal or error tells the loop to do. */
export type RateLimitVerdict =
  /** The agent reported when the limit resets: wait until then. */
  | { kind: "until"; wakeAt: Date }
  /** No reset time is known: send `continue` on an interval. */
  | { kind: "poll" }
  /**
   * A seven-day cap, with the reset time when the agent reported one. Waiting for it is not an overnight
   * job, so without a probe that can tell when the account is usable again the loop halts.
   */
  | { kind: "weekly"; wakeAt: Date | null }
  /** A monthly cap: nor is this one, so the loop halts. */
  | { kind: "monthly" };

export type AgentError = { message: string; data?: unknown };

/** The `rate_limit` signal's payload: Claude Code's `rate_limit_info`, with the reset time in milliseconds. */
export type RateLimitReading = {
  status: string;
  resetsAtMs: number | null;
  limitType: string | null;
};

const WEEKLY_TYPE = /^seven_day/;

/**
 * Classifies a `rate_limit` reading. Only `rejected` stops the work; `allowed`
 * and `allowed_warning` are the adapter reporting how close the account is.
 *
 * @example
 * classifyRateLimit({ status: "rejected", resetsAtMs: 1_800_000_000_000, limitType: "five_hour" });
 * // => { kind: "until", wakeAt: <that instant> }
 */
export function classifyRateLimit(
  reading: RateLimitReading,
): RateLimitVerdict | null {
  if (reading.status !== "rejected") return null;
  if (reading.limitType && WEEKLY_TYPE.test(reading.limitType)) {
    const wakeAt = reading.resetsAtMs === null ? null : new Date(reading.resetsAtMs);
    return { kind: "weekly", wakeAt };
  }
  if (reading.resetsAtMs === null) return { kind: "poll" };
  return { kind: "until", wakeAt: new Date(reading.resetsAtMs) };
}
