import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCtl, splitWhy, useArguments } from "./ctl.ts";

describe("splitWhy", () => {
  it("leaves the arguments alone when no reason is given", () => {
    assert.deepEqual(splitWhy(["zod", "valibot"]), {
      values: ["zod", "valibot"],
    });
  });

  it("takes the reason off the front so it can be journaled with the answer", () => {
    assert.deepEqual(splitWhy(["--why", "ADR-0004 keeps zod", "zod"]), {
      why: "ADR-0004 keeps zod",
      values: ["zod"],
    });
  });
});

describe("useArguments", () => {
  it("reads the agent, the model and the effort, in any order after the agent", () => {
    assert.deepEqual(
      useArguments(["devin", "--effort", "high", "--model", "swe-2-high"]),
      { agent: "devin", model: "swe-2-high", effort: "high" },
    );
  });

  it("leaves the model and the effort on the agent's own default when none is named, so a switch can reset them", () => {
    assert.deepEqual(useArguments(["claude"]), {
      agent: "claude",
      model: null,
      effort: null,
    });
  });

  it("refuses an unknown agent, listing the ones the loop can drive", () => {
    assert.throws(
      () => useArguments(["gemini"]),
      (error: Error) =>
        error.message.includes('"gemini"') &&
        error.message.includes("claude, devin"),
    );
  });

  it("refuses no agent, and a flag with no value, instead of switching to something nobody asked for", () => {
    assert.throws(() => useArguments([]), /harness must be one of claude, devin, got none/);
    assert.throws(
      () => useArguments(["devin", "--model"]),
      /--model needs a model id the harness offers, got none/,
    );
    assert.throws(
      () => useArguments(["devin", "--bogus", "x"]),
      (error: Error) => error.message.includes('"--bogus"'),
    );
  });
});

describe("use --reset", () => {
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ctl-use-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("removes the override that `use` wrote, so the workflow decides again", async () => {
    const choicePath = join(repo, ".autopilot-run", "choice.json");

    await runCtl(["use", "devin", "--model", "swe-2-high", "--repo", repo]);
    assert.deepEqual(JSON.parse(await readFile(choicePath, "utf8")), { agent: "devin", model: "swe-2-high", effort: null });
    const message = await runCtl(["use", "--reset", "--repo", repo]);

    await assert.rejects(() => readFile(choicePath, "utf8"), /ENOENT/);
    assert.match(message, /override removed/);
  });

  it("is not an error when there is no override to remove", async () => {
    assert.match(await runCtl(["use", "--reset", "--repo", repo]), /override removed/);
  });
});
