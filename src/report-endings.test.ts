import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { iterationsOf, restartsOf } from "./report-iterations.ts";
import type { LoopEvent } from "./mailbox.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-11-16T10:00:00Z");
const ev = (hours: number, type: string, detail: Record<string, unknown> = {}): LoopEvent => ({
  at: new Date(T0 + hours * HOUR).toISOString(),
  type,
  ...detail,
});
const started = (hours: number, head: string): LoopEvent => ev(hours, "iteration_started", { row: "Items", head });

describe("iterationsOf: how an iteration ended", () => {
  it("reads a crashed iteration as crashed, not open, and ends it at the crash", () => {
    const events = [ev(0, "loop_started"), started(0, "a"), ev(48 / 60, "iteration_crashed", { kind: "crashed" }), ev(13, "loop_started"), started(13, "a")];

    const [crashed] = iterationsOf(events, "a");

    assert.equal(crashed?.outcome, "crashed");
    assert.equal((crashed?.endMs ?? 0) - (crashed?.startMs ?? 0), 48 * MINUTE);
  });

  it("ends an interrupted iteration at the last thing it did, not at the restart that recorded it", () => {
    // The shape of a real run: the loop died 1.1 h in, and the next loop wrote the interruption 21.9 h in.
    const events = [
      ev(0, "loop_started"),
      started(0, "a"),
      ev(66 / 60, "background_exited", { shellId: "x" }),
      ev(21.9, "loop_started"),
      ev(21.9, "iteration_interrupted", { n: 1 }),
      started(21.9, "a"),
    ];

    const [interrupted] = iterationsOf(events, "a");

    assert.equal(interrupted?.outcome, "interrupted");
    assert.equal((interrupted?.endMs ?? 0) - (interrupted?.startMs ?? 0), 66 * MINUTE);
  });

  it("does not count what the restarted loop wrote after it: its own waits belong to it, not to the iteration that died", () => {
    const events = [
      ev(0, "loop_started"),
      started(0, "a"),
      ev(1, "background_exited", { shellId: "x" }),
      ev(5, "loop_started"),
      ev(5, "iteration_interrupted", { n: 1 }),
      ev(5, "preflight_wait", { reason: "load" }),
      ev(19, "preflight_wait", { reason: "load" }),
      started(20, "a"),
    ];

    const [interrupted] = iterationsOf(events, "a");

    assert.equal((interrupted?.endMs ?? 0) - (interrupted?.startMs ?? 0), HOUR);
  });

  it("ends an open iteration that a restart left without a record at its last activity too", () => {
    const events = [ev(0, "loop_started"), started(0, "a"), ev(2, "mode_changed", { mode: "bypass" }), ev(9, "loop_started"), started(9, "a")];

    const [open] = iterationsOf(events, "a");

    assert.equal(open?.outcome, "open");
    assert.equal(((open?.endMs ?? 0) - (open?.startMs ?? 0)) / HOUR, 2);
  });

  it("keeps a finished iteration's own closing event as its end", () => {
    const events = [ev(0, "loop_started"), started(0, "a"), ev(3, "iteration_done", { head: "b" })];

    const [done] = iterationsOf(events, "b");

    assert.equal(done?.outcome, "done");
    assert.equal(((done?.endMs ?? 0) - (done?.startMs ?? 0)) / HOUR, 3);
  });
});

describe("restartsOf: how the run before a restart ended", () => {
  const afterEnding = (...ending: LoopEvent[]) => restartsOf([ev(0, "loop_started"), ...ending, ev(5, "loop_started")])[0]?.after;

  it("names each way the registry says a loop ends", () => {
    assert.equal(afterEnding(ev(1, "stop")), "stopped");
    assert.equal(afterEnding(ev(1, "loop_halted", { reason: "x" })), "halted");
    assert.equal(afterEnding(ev(1, "loop_signalled", { signal: "SIGTERM" })), "signalled");
    assert.equal(afterEnding(ev(1, "backlog_exhausted")), "exhausted");
  });

  it("calls it died only when the last event is none of those, so a service stop is not reported as a death", () => {
    assert.equal(afterEnding(ev(1, "background_started")), "died");
  });
});
