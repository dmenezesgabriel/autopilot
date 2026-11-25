import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVENTS } from "./event-registry.ts";
import { runIteration } from "./iteration.ts";
import { build, commitsInBypass } from "./testing/iteration-harness.ts";

describe("turn_started: the journal says when the agent was sent a prompt", () => {
  it("is a registered event, so a workflow can name it and `autopilot events` lists it", () => {
    assert.ok("turn_started" in EVENTS);
  });

  it("comes just before the turn's own end, once per prompt", async () => {
    const { deps, events, agent } = build((parts) => [() => "end_turn", commitsInBypass(parts)]);

    await runIteration(deps);

    const types = events.map((event) => event.type);
    assert.equal(types.filter((type) => type === "turn_started").length, agent.promptTexts().length);
    for (let at = 0; at < types.length; at++) {
      if (types[at] === "turn_ended") assert.equal(types[at - 1], "turn_started", `turn_ended at ${at} had no turn_started before it`);
    }
  });

  it("is written before the agent is prompted, so a turn that never ends is still on the record", async () => {
    const { deps, events } = build(() => [
      () => {
        throw new Error("the agent is gone");
      },
    ]);

    await runIteration(deps).catch(() => undefined);

    assert.ok(events.some((event) => event.type === "turn_started"));
  });
});
