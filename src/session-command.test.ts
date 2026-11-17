import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandFor } from "./session.ts";

const NONE = { claude: { command: null }, devin: { command: null } };

describe("commandFor", () => {
  it("starts the harness's own executable when neither a flag nor the workflow names one", () => {
    assert.equal(commandFor("claude", null, NONE, "claude-agent-acp"), "claude-agent-acp");
  });

  it("starts the executable the workflow names for that harness", () => {
    assert.equal(commandFor("devin", null, { ...NONE, devin: { command: "/opt/devin" } }, "devin"), "/opt/devin");
  });

  it("prefers the flag over the workflow, but only for the harness the flag was given for", () => {
    const flagged = { agent: "claude", command: "/tmp/claude-agent-acp" };
    const table = { claude: { command: "/opt/claude-agent-acp" }, devin: { command: "/opt/devin" } };

    assert.equal(commandFor("claude", flagged, table, "claude-agent-acp"), "/tmp/claude-agent-acp");
    assert.equal(commandFor("devin", flagged, table, "devin"), "/opt/devin");
  });
});
