import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoopEvent } from "./mailbox.ts";
import { formatReport, type Report } from "./report.ts";
import { timeSplitOf } from "./report-time.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-25T00:00:00.000Z");
/** An event `minutes` after a fixed start, so each case reads as a timeline. */
const at = (minutes: number, type: string, more: Record<string, unknown> = {}): LoopEvent => ({ at: new Date(T0 + minutes * MIN).toISOString(), type, ...more });

describe("timeSplitOf: where a finished iteration's time went, from the journal", () => {
  it("has nothing to say about a journal written before turns were recorded", () => {
    const events = [at(0, "iteration_started", { row: "A" }), at(30, "iteration_done", { head: "h" })];

    assert.equal(timeSplitOf(events), null);
  });

  it("counts a turn from its start to its end, and the wait between two turns as idle", () => {
    const events = [
      at(0, "iteration_started"),
      at(1, "turn_started"),
      at(10, "turn_ended"),
      at(40, "turn_started"),
      at(45, "turn_ended"),
      at(46, "iteration_done"),
    ];

    const split = timeSplitOf(events);

    assert.equal(split?.iterations, 1);
    assert.equal(split?.inTurnMs, 14 * MIN);
    assert.equal(split?.idleMs.other, (1 + 30 + 1) * MIN, "the start, the 30 minute gap and the last minute");
  });

  it("calls a gap background when the loop was awaiting a command the agent started", () => {
    const events = [
      at(0, "iteration_started"),
      at(1, "turn_started"),
      at(10, "turn_ended"),
      at(10, "awaiting_work", { running: ["pnpm test"] }),
      at(40, "turn_started"),
      at(45, "turn_ended"),
      at(45, "iteration_done"),
    ];

    assert.equal(timeSplitOf(events)?.idleMs.background, 30 * MIN);
  });

  it("calls a gap human while a question or a reply waits, until it is answered", () => {
    const events = [
      at(0, "iteration_started"),
      at(1, "turn_started"),
      at(5, "turn_ended"),
      at(5, "needs_answer", { id: "q1" }),
      at(25, "answer_received", { id: "q1" }),
      at(25, "turn_started"),
      at(30, "turn_ended"),
      at(30, "iteration_done"),
    ];

    assert.equal(timeSplitOf(events)?.idleMs.human, 20 * MIN);
  });

  it("calls a gap a limit wait when a rate limit hit in it, even if a command was also awaited", () => {
    const events = [
      at(0, "iteration_started"),
      at(1, "turn_started"),
      at(5, "turn_ended"),
      at(5, "awaiting_work"),
      at(6, "rate_limited", { wakeAt: "x" }),
      at(66, "turn_started"),
      at(70, "turn_ended"),
      at(70, "iteration_done"),
    ];

    const split = timeSplitOf(events);

    assert.equal(split?.idleMs.limit, 61 * MIN);
    assert.equal(split?.idleMs.background, 0);
  });

  it("closes a turn that has no end at the next turn, so no time is counted twice", () => {
    const events = [at(0, "iteration_started"), at(1, "turn_started"), at(11, "turn_started"), at(16, "turn_ended"), at(16, "iteration_done")];

    const split = timeSplitOf(events);

    assert.equal(split?.inTurnMs, 15 * MIN);
  });

  it("counts only iterations that finished with a commit, and only those that have turns", () => {
    const events = [
      at(0, "iteration_started"),
      at(1, "turn_started"),
      at(9, "turn_ended"),
      at(10, "iteration_interrupted"),
      at(20, "iteration_started"),
      at(21, "turn_started"),
      at(25, "turn_ended"),
      at(26, "iteration_done"),
    ];

    const split = timeSplitOf(events);

    assert.equal(split?.iterations, 1);
    assert.equal(split?.inTurnMs, 4 * MIN);
  });

  it("measures how long preflight held a session back before an iteration it counts", () => {
    const events = [
      at(0, "iteration_started"),
      at(1, "turn_started"),
      at(5, "turn_ended"),
      at(5, "iteration_done"),
      at(6, "preflight_wait", { reason: "load" }),
      at(7, "preflight_wait", { reason: "load" }),
      at(36, "iteration_started"),
      at(37, "turn_started"),
      at(40, "turn_ended"),
      at(40, "iteration_done"),
    ];

    assert.equal(timeSplitOf(events)?.heldMs, 30 * MIN);
  });
});

describe("autopilot report: the time section", () => {
  const empty = { rows: [], restarts: [], limitWaits: [] };

  it("says what the time split is made of, and that a turn includes the agent's own blocking calls", () => {
    const events = [at(0, "iteration_started"), at(1, "turn_started"), at(31, "turn_ended"), at(31, "awaiting_work"), at(91, "turn_started"), at(100, "turn_ended"), at(100, "iteration_done")];
    const report: Report = { ...empty, time: timeSplitOf(events) };

    const text = formatReport(report);

    assert.match(text, /where the time goes, in 1 finished iteration since 2026-11-25/);
    assert.match(text, /in a turn\s+0\.7 h \(39%\)/);
    assert.match(text, /idle, background commands running\s+1\.0 h \(60%\)/);
    assert.match(text, /a turn includes the time the agent spends blocked on its own tool calls/);
  });

  it("says why there is no split, instead of leaving a section out, when the journal has no turn events", () => {
    const text = formatReport({ ...empty, time: null });

    assert.match(text, /where the time goes: not available, this journal has no turn_started events/);
  });
});
