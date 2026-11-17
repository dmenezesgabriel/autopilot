import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CamLimitProbe, limitProbeFor, usableFromCamStatus } from "./limit-probe.ts";

const status = (usage: unknown, usageStatus = "ok"): string =>
  JSON.stringify({ schemaVersion: 1, active: { managedAs: "a", usageStatus, usage } });

const window = (pct: number): { pct: number; resetsAt: string } => ({
  pct,
  resetsAt: "2026-11-17T19:30:00+00:00",
});

describe("usableFromCamStatus", () => {
  it("is usable while both windows are under 100%", () => {
    assert.equal(usableFromCamStatus(status({ fiveHour: window(13), sevenDay: window(2), scoped: [] })), true);
    assert.equal(usableFromCamStatus(status({ fiveHour: window(99), sevenDay: window(99.5), scoped: [] })), true);
  });

  it("is not usable when either window is exhausted", () => {
    assert.equal(usableFromCamStatus(status({ fiveHour: window(100), sevenDay: window(2), scoped: [] })), false);
    assert.equal(usableFromCamStatus(status({ fiveHour: window(10), sevenDay: window(100), scoped: [] })), false);
  });

  it("counts a scoped window too", () => {
    const usage = { fiveHour: window(10), sevenDay: window(10), scoped: [window(100)] };

    assert.equal(usableFromCamStatus(status(usage)), false);
  });

  it("cannot tell when cam reports no usage, a usage error, or output it does not know", () => {
    assert.equal(usableFromCamStatus(status(undefined)), null);
    assert.equal(usableFromCamStatus(status({ fiveHour: window(1), sevenDay: window(1) }, "error")), null);
    assert.equal(usableFromCamStatus(status({ fiveHour: window(1) })), null);
    assert.equal(usableFromCamStatus("not json"), null);
    assert.equal(usableFromCamStatus("{}"), null);
  });
});

describe("CamLimitProbe", () => {
  it("asks `cam status --json` and reads its answer", async () => {
    const calls: string[][] = [];
    const probe = new CamLimitProbe(async (command, args) => {
      calls.push([command, ...args]);
      return status({ fiveHour: window(5), sevenDay: window(5), scoped: [] });
    });

    assert.equal(await probe.usable(), true);
    assert.deepEqual(calls, [["cam", "status", "--json"]]);
  });

  it("cannot tell when cam is missing or fails", async () => {
    const probe = new CamLimitProbe(async () => {
      throw new Error("spawn cam ENOENT");
    });

    assert.equal(await probe.usable(), null);
  });
});

describe("limitProbeFor", () => {
  it("gives no probe for `none` and a cam probe for `cam`", () => {
    assert.equal(limitProbeFor("none"), null);
    assert.ok(limitProbeFor("cam") instanceof CamLimitProbe);
  });
});
