import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HarnessDefaults } from "./agent-choice.ts";
import { describeNextSession } from "./next-session.ts";
import { RunDir } from "./run-dir.ts";

const NO_HARNESS: HarnessDefaults = { harness: null, harnesses: {} };
const DEVIN_IN_WORKFLOW: HarnessDefaults = {
  harness: "devin",
  harnesses: { devin: { model: "swe-2-high", effort: null, command: null }, claude: { model: "sonnet", effort: "high", command: null } },
};

let dir = "";
let runDir: RunDir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "next-session-"));
  runDir = new RunDir(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("describeNextSession", () => {
  it("is the workflow's choice, said to come from it, when nothing overrides", async () => {
    assert.deepEqual(await describeNextSession(runDir, DEVIN_IN_WORKFLOW), ["next session: devin, model swe-2-high, effort default (from the workflow)"]);
  });

  it("is the harness's own default when the workflow says nothing", async () => {
    assert.deepEqual(await describeNextSession(runDir, NO_HARNESS), ["next session: claude, model default, effort default (from the workflow)"]);
  });

  it("shows an `autopilot use` made after the journal's last line, and how to take it back", async () => {
    await runDir.writeChoice({ agent: "devin", model: "swe-2-flash-high", effort: null });

    const lines = await describeNextSession(runDir, DEVIN_IN_WORKFLOW);

    assert.equal(lines[0], "next session: devin, model swe-2-flash-high, effort default");
    assert.equal(lines[1], "  override in choice.json (harness devin, model swe-2-flash-high); `autopilot use --reset` returns it to the workflow");
  });

  it("takes the workflow's model and effort of the harness an override switches to, never the old harness's", async () => {
    await runDir.writeChoice({ agent: "claude", model: null, effort: null });

    const [first] = await describeNextSession(runDir, DEVIN_IN_WORKFLOW);

    assert.equal(first, "next session: claude, model sonnet, effort high");
  });

  it("says the current choice stays when the file cannot be read, as the loop does, and names why", async () => {
    await writeFile(join(dir, "choice.json"), "{not json");

    const [first] = await describeNextSession(runDir, DEVIN_IN_WORKFLOW);

    assert.match(first ?? "", /^next session: the current choice stays, because choice file .*choice\.json is not valid JSON/);
  });

  it("says the current choice stays for a harness the loop cannot drive", async () => {
    await writeFile(join(dir, "choice.json"), '{"agent":"gemini","model":null,"effort":null}');

    assert.deepEqual(await describeNextSession(runDir, DEVIN_IN_WORKFLOW), ['next session: the current choice stays, because harness "gemini" is not one of claude, devin']);
  });
});
