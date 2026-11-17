import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCtl, splitWhy, splitWorkflow, useArguments } from "./ctl.ts";

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

describe("operator commands find the run directory of the workflow they are given", () => {
  let repo = "";
  let workflow = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ctl-wf-repo-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "ctl-wf-file-"));
    workflow = join(elsewhere, "loop.yaml");
    await writeFile(workflow, "version: 1\nrun_dir: scripts/loop/.run\n");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(join(workflow, ".."), { recursive: true, force: true });
  });

  const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

  it("splits --workflow off the arguments, and reports none when it is absent", () => {
    assert.deepEqual(splitWorkflow(["stop", "--workflow", "w.yaml"]), { workflow: "w.yaml", rest: ["stop"] });
    assert.deepEqual(splitWorkflow(["stop"]), { workflow: null, rest: ["stop"] });
    assert.throws(() => splitWorkflow(["stop", "--workflow"]), /--workflow needs a workflow file, got none/);
  });

  it("puts a stop request where the loop reads it, and creates nothing in the default directory", async () => {
    await runCtl(["stop", "--repo", repo, "--workflow", workflow]);

    assert.equal(await exists(join(repo, "scripts/loop/.run/STOP")), true);
    assert.equal(await exists(join(repo, ".autopilot-run")), false);
  });

  it("reads the journal of that directory, so status describes the loop that runs and not an empty default", async () => {
    const runDir = join(repo, "scripts/loop/.run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), '{"at":"2026-11-17T10:00:00Z","type":"loop_started","pid":1}\n{"at":"2026-11-17T10:01:00Z","type":"iteration_started","row":"R-1","head":"a"}\n');

    const status = await runCtl(["status", "--repo", repo, "--workflow", workflow]);

    assert.doesNotMatch(status, /never_started/);
    assert.match(status, /R-1/);
  });

  it("refuses a workflow file that does not exist, rather than falling back to a default directory", async () => {
    await assert.rejects(() => runCtl(["stop", "--repo", repo, "--workflow", join(repo, "missing.yaml")]), /ENOENT/);
    assert.equal(await exists(join(repo, ".autopilot-run")), false);
  });

  it("keeps the workflow in the service unit, so a service reads the same file and the same directory", async () => {
    const unit = await runCtl(["service", "print", "--repo", repo, "--workflow", workflow]);

    assert.match(unit, new RegExp(`run --repo ${repo.replaceAll("/", "\\/")} --workflow ${workflow.replaceAll("/", "\\/")}`));
  });
});
