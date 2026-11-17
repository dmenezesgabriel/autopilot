import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_PROFILE } from "./claude/profile.ts";
import { DEVIN_PROFILE } from "./devin/profile.ts";

describe("agent profiles and the account probe", () => {
  it("lets only Claude's waits end by a probe of the Claude accounts", () => {
    assert.equal(CLAUDE_PROFILE.usesClaudeAccounts, true);
    assert.equal(DEVIN_PROFILE.usesClaudeAccounts, false);
  });

  it("probes the accounts no faster than cam polls them, for both agents", () => {
    assert.equal(CLAUDE_PROFILE.timing.limitProbeMs, 60_000);
    assert.equal(DEVIN_PROFILE.timing.limitProbeMs, 60_000);
  });
});
