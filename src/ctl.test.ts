import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCtl, splitRunDir, splitWhy, splitWorkflow, useArguments } from "./ctl.ts";

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
    assert.match(await runCtl(["use", "--reset", "--repo", repo]), /no override was set/);
  });

  it("prints what the next session will run on once the override is gone", async () => {
    await runCtl(["use", "devin", "--repo", repo]);

    const message = await runCtl(["use", "--reset", "--repo", repo]);

    assert.match(message, /^override removed\nnext session: claude, model default, effort default \(from the workflow\)$/);
  });

  it("prints the next session the way the loop will resolve it, with the workflow's settings filled in", async () => {
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nharnesses:\n  devin: { model: swe-2-high }\n");

    const message = await runCtl(["use", "devin", "--repo", repo]);

    assert.match(message, /^next session: devin, model swe-2-high, effort default\n  override in choice\.json \(harness devin\)/);
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
    await mkdir(join(repo, "scripts/loop/.run"), { recursive: true });
    await writeFile(join(repo, "scripts/loop/.run/loop.pid"), String(process.pid));

    const said = await runCtl(["stop", "--repo", repo, "--workflow", workflow]);

    assert.equal(await exists(join(repo, "scripts/loop/.run/STOP")), true);
    assert.equal(await exists(join(repo, ".autopilot-run")), false);
    assert.match(said, new RegExp(`^stop requested: the loop \\(pid ${process.pid}\\) exits between iterations$`));
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
    await assert.rejects(() => runCtl(["stop", "--repo", repo, "--workflow", join(repo, "missing.yaml")]), /workflow file .*missing\.yaml does not exist; `autopilot init` writes a starter one/);
    assert.equal(await exists(join(repo, ".autopilot-run")), false);
  });

  it("keeps the workflow in the service unit, so a service reads the same file and the same directory", async () => {
    const unit = await runCtl(["service", "print", "--repo", repo, "--workflow", workflow]);

    assert.match(unit, new RegExp(`run --repo ${repo.replaceAll("/", "\\/")} --workflow ${workflow.replaceAll("/", "\\/")}`));
  });
});

describe("operator commands check the loop before they write", () => {
  let repo = "";
  let run = "";
  const journal = (...events: Record<string, unknown>[]): Promise<void> =>
    writeFile(join(run, "events.jsonl"), events.map((event, at) => JSON.stringify({ at: `2026-11-17T10:0${at}:00Z`, ...event })).join("\n") + "\n");
  const liveLoop = (): Promise<void> => writeFile(join(run, "loop.pid"), String(process.pid));
  const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
  const QUESTION = { type: "needs_answer", id: "q4", questions: [{ header: "H", question: "Which?", options: [{ label: "hi" }, { label: "yo" }] }] };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ctl-check-"));
    run = join(repo, ".autopilot-run");
    await mkdir(run, { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("writes no stop file when no loop runs, and says so, because the next start would only delete it", async () => {
    const said = await runCtl(["stop", "--repo", repo]);

    assert.equal(said, "no loop runs here, so there is nothing to stop");
    assert.equal(await exists(join(run, "STOP")), false);
  });

  it("writes the answer of a question that waits, once a loop is there to read it", async () => {
    await journal({ type: "loop_started" }, { type: "iteration_started", row: "R", head: "a" }, QUESTION);
    await liveLoop();

    const said = await runCtl(["answer", "q4", "--why", "ADR-1", "yo", "--repo", repo]);

    assert.equal(said, "answered q4");
    assert.deepEqual(JSON.parse(await readFile(join(run, "answers/q4.json"), "utf8")), { answer: ["yo"], why: "ADR-1" });
  });

  it("writes nothing for an id that does not wait, so a stale file can never answer a later question", async () => {
    await journal({ type: "loop_started" }, { type: "iteration_started", row: "R", head: "a" }, QUESTION);
    await liveLoop();

    await assert.rejects(() => runCtl(["answer", "q1", "yo", "--repo", repo]), /"q1" is not waiting for an answer; waiting: q4 \(question\)/);
    assert.equal(await exists(join(run, "answers/q1.json")), false);
  });

  it("refuses a reply to a question and writes nothing", async () => {
    await journal({ type: "loop_started" }, { type: "iteration_started", row: "R", head: "a" }, QUESTION);
    await liveLoop();

    await assert.rejects(() => runCtl(["reply", "q4", "go on", "--repo", repo]), /q4 is a question: use `autopilot answer q4`/);
    assert.equal(await exists(join(run, "answers/q4.json")), false);
  });

  it("repeats a note when a label is free text, after the confirmation", async () => {
    await journal({ type: "loop_started" }, { type: "iteration_started", row: "R", head: "a" }, QUESTION);
    await liveLoop();

    const said = await runCtl(["answer", "q4", "maybe", "--repo", repo]);

    assert.match(said, /^answered q4\nnote: "maybe" is not one of question 1's options \(hi, yo\)/);
  });

  it("refuses an answer when the loop that asked is gone", async () => {
    await journal({ type: "loop_started" }, { type: "iteration_started", row: "R", head: "a" }, QUESTION);

    await assert.rejects(() => runCtl(["answer", "q4", "yo", "--repo", repo]), /no loop runs here, so nothing would read "q4"/);
    assert.equal(await exists(join(run, "answers/q4.json")), false);
  });
});

describe("status says what the next session will run on from the files that decide it", () => {
  let repo = "";
  let run = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ctl-status-"));
    run = join(repo, ".autopilot-run");
    await mkdir(run, { recursive: true });
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nharness: devin\n");
    // A journal from before the loop recorded its agent: nothing in it says claude.
    await writeFile(join(run, "events.jsonl"), '{"at":"2026-11-17T10:00:00Z","type":"loop_started","pid":1}\n');
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("follows the workflow, not a journal line that predates the agent field", async () => {
    const status = await runCtl(["status", "--repo", repo]);

    assert.match(status, /^loop: running.*\nnext session: devin, model default, effort default \(from the workflow\)\n/);
  });

  it("shows an override written after the journal's last line", async () => {
    await runCtl(["use", "devin", "--model", "swe-2-high", "--repo", repo]);

    const status = await runCtl(["status", "--repo", repo]);

    assert.match(status, /next session: devin, model swe-2-high, effort default\n  override in choice\.json \(harness devin, model swe-2-high\)/);
  });
});

describe("report and validate when there is nothing to report or no file", () => {
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ctl-edge-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("report says there are no iterations yet instead of failing on a repository with no commit", async () => {
    assert.match(await runCtl(["report", "--repo", repo]), /^no iterations yet: .*events\.jsonl holds no events$/);
  });
});

describe("operator commands while the workflow does not read", () => {
  // The loop keeps the workflow it last read when an edit breaks the file, so the operator must still be able to answer and stop it.
  let repo = "";
  let run = "";
  const ASK = [
    { at: "2026-11-17T10:00:00Z", type: "loop_started" },
    { at: "2026-11-17T10:01:00Z", type: "iteration_started", row: "R", head: "a" },
    { at: "2026-11-17T10:02:00Z", type: "needs_answer", id: "q1", questions: [{ header: "H", question: "Q?", options: [{ label: "a" }, { label: "b" }] }] },
  ];
  const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ctl-broken-"));
    run = join(repo, "state");
    await mkdir(run, { recursive: true });
    await writeFile(join(run, "events.jsonl"), ASK.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await writeFile(join(run, "loop.pid"), String(process.pid));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("answers, stops and reports status when a key is mistyped, because the file still names its run directory", async () => {
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nrun_dir: state\nbogus_key: 1\n");

    assert.equal(await runCtl(["answer", "q1", "a", "--repo", repo]), "answered q1");
    assert.match(await runCtl(["stop", "--repo", repo]), /^stop requested: the loop/);
    const status = await runCtl(["status", "--repo", repo]);

    assert.match(status, /next session: not worked out, because the workflow does not read: .*unknown key "bogus_key"/);
    assert.match(status, /waiting for question q1/);
    assert.equal(await exists(join(run, "STOP")), true);
  });

  it("asks for --run-dir when the file is not YAML at all, and works once it is given", async () => {
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nrun_dir: state\nrules: [unclosed\n");

    await assert.rejects(() => runCtl(["stop", "--repo", repo]), /not valid YAML[^]*cannot name the run directory either: say which with --run-dir <dir>/);
    assert.equal(await exists(join(run, "STOP")), false);
    assert.match(await runCtl(["stop", "--repo", repo, "--run-dir", run]), /^stop requested/);
    assert.equal(await exists(join(run, "STOP")), true);
  });

  it("lets `use` write its override even then, since the override does not depend on the workflow", async () => {
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nrun_dir: state\nbogus_key: 1\n");

    await runCtl(["use", "devin", "--model", "swe-2-high", "--repo", repo]);

    assert.deepEqual(JSON.parse(await readFile(join(run, "choice.json"), "utf8")), { agent: "devin", model: "swe-2-high", effort: null });
  });

  it("splits --run-dir off the arguments", () => {
    assert.deepEqual(splitRunDir(["stop", "--run-dir", "x"]), { runDir: "x", rest: ["stop"] });
    assert.deepEqual(splitRunDir(["stop"]), { runDir: null, rest: ["stop"] });
    assert.throws(() => splitRunDir(["stop", "--run-dir"]), /--run-dir needs a run directory, got none/);
  });
});
