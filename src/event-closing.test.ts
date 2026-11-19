import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWakeEvents, EVENT_NAMES, EVENTS, ITERATION_OUTCOME, LOOP_END } from "./event-registry.ts";

describe("which events close an iteration or the loop", () => {
  it("is declared for every iteration event but its start, so a new ending cannot be missed by one reader", () => {
    const unclassified = EVENT_NAMES.filter((name) => name.startsWith("iteration_") && name !== "iteration_started" && !(name in ITERATION_OUTCOME));

    assert.deepEqual(unclassified, []);
  });

  it("is declared for every event that leaves the loop", () => {
    const leaving = ["stop", "backlog_exhausted", "loop_halted", "loop_signalled"];

    assert.deepEqual(leaving.filter((name) => !(name in LOOP_END)), []);
  });

  it("gives each ending its own word, and reads them from the one declaration", () => {
    assert.deepEqual(ITERATION_OUTCOME, {
      iteration_done: "done",
      iteration_stalled: "stalled",
      iteration_halted: "halted",
      iteration_crashed: "crashed",
      iteration_yielded: "yielded",
      iteration_interrupted: "interrupted",
    });
    assert.deepEqual(LOOP_END, { loop_halted: "halted", loop_signalled: "signalled", backlog_exhausted: "exhausted", stop: "stopped" });
  });
});

describe("which events wake an orchestrator by default", () => {
  it("covers the alerts that only a person's edit can cure, which the docs tell the orchestrator to act on", () => {
    const wake = defaultWakeEvents();

    for (const name of ["agent_choice_invalid", "workflow_invalid", "workflow_error"] as const) {
      assert.ok(wake.includes(name), `${name} must wake`);
    }
  });

  it("leaves out the alerts the loop already handled itself", () => {
    const wake = defaultWakeEvents();

    for (const name of ["answer_defaulted", "reply_defaulted", "permission_requested", "rate_limited", "iteration_interrupted"] as const) {
      assert.equal(wake.includes(name), false, `${name} must not wake`);
    }
  });

  it("makes every alert say which of the two it is", () => {
    const silent = EVENT_NAMES.filter((name) => EVENTS[name].kind === "alert" && typeof (EVENTS[name] as { wake?: unknown }).wake !== "boolean");

    assert.deepEqual(silent, []);
  });
});
