import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runIteration } from "./iteration.ts";
import type { LimitProbe } from "./limit-probe.ts";
import { build, commitsInBypass, TIMING, type Parts } from "./testing/iteration-harness.ts";

class ScriptedProbe implements LimitProbe {
  asked = 0;
  constructor(private readonly answers: Array<boolean | null>) {}

  async usable(): Promise<boolean | null> {
    const answer = this.answers[Math.min(this.asked, this.answers.length - 1)] ?? null;
    this.asked += 1;
    return answer;
  }
}

describe("runIteration limit wait with a probe", () => {
  const rejectedUntil = (resetsAtMs: number) => (parts: Parts) => [
    () => {
      parts.ledger.apply({ type: "rate_limit", status: "rejected", resetsAtMs, limitType: "five_hour" });
      return "end_turn" as const;
    },
    commitsInBypass(parts),
  ];

  it("goes on at the first minute the probe says the account is usable, long before the reset", async () => {
    const { deps, clock, events, agent } = build(rejectedUntil(3 * 60 * 60_000));
    deps.limitProbe = new ScriptedProbe([false, false, true]);

    const outcome = await runIteration(deps);

    assert.equal(outcome.kind, "done");
    assert.deepEqual(clock.sleeps, [60_000, 60_000, 60_000]);
    assert.equal(agent.promptTexts()[1], "continue");
    assert.ok(events.some((e) => e.type === "limit_cleared" && e["early"] === true));
  });

  it("waits out the reset time when the probe never says yes", async () => {
    const { deps, clock } = build(rejectedUntil(5 * 60_000));
    deps.limitProbe = new ScriptedProbe([false]);

    await runIteration(deps);

    assert.equal(clock.now(), 5 * 60_000 + TIMING.limitMarginMs);
  });

  it("treats a probe that cannot tell like one that said no", async () => {
    const { deps, clock } = build(rejectedUntil(3 * 60_000));
    deps.limitProbe = new ScriptedProbe([null]);

    await runIteration(deps);

    assert.equal(clock.now(), 3 * 60_000 + TIMING.limitMarginMs);
  });

  it("sleeps the whole wait at once when there is no probe, as before", async () => {
    const { deps, clock } = build(rejectedUntil(5 * 60_000));

    await runIteration(deps);

    assert.deepEqual(clock.sleeps, [5 * 60_000 + TIMING.limitMarginMs]);
  });
});
