import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadWorkflow, parseWorkflow } from "./workflow.ts";

const parse = (yaml: string) => parseWorkflow(yaml, "autopilot.yaml");

describe("parseWorkflow defaults and sections", () => {
  it("fills every key a repository leaves out with the loop's default", () => {
    const workflow = parse("{}");

    assert.equal(workflow.prompt, "prompt-execution.md");
    assert.equal(workflow.runDir, ".autopilot-run");
    assert.deepEqual(workflow.backlog, { source: "markdown", file: "docs/backlog.md", marker: "← next" });
    assert.equal(workflow.hostCheck, true);
    assert.equal(workflow.harness, null);
    assert.deepEqual(workflow.harnesses, {});
    assert.equal(workflow.planFollowUp, null);
    assert.deepEqual(workflow.rules, []);
    assert.deepEqual(workflow.leftover, { rules: [], wrappers: [] });
    assert.equal(workflow.limitProbe, "none");
    assert.deepEqual(workflow.handlers, []);
  });

  it("reads an empty file as the defaults", () => {
    assert.equal(parse("").prompt, "prompt-execution.md");
  });

  it("reads each section a repository sets", () => {
    const workflow = parse(`
version: 1
prompt: PROMPT.md
run_dir: scripts/loop/.run
backlog: { file: BACKLOG.md, marker: "**open ← next" }
harness: devin
harnesses:
  claude: { model: sonnet, effort: high, command: /opt/bin/claude-agent-acp }
  devin: { model: swe-2-high }
plan: { follow_up: "/engineering-mode" }
rules:
  - Rule one.
  - Rule two.
preflight:
  wrappers:
    - program: jobq
      ignore_args: [--status]
      hint: stop it with {{pid}}
  leftover:
    - match: '\\b(vite|vitest)\\b'
    - { match: '\\bchrome\\b', also_match: '--headless' }
limits: { probe: cam }
wake: [needs_answer, loop_halted]
`);

    assert.equal(workflow.runDir, "scripts/loop/.run");
    assert.deepEqual(workflow.backlog, { source: "markdown", file: "BACKLOG.md", marker: "**open ← next" });
    assert.equal(workflow.harness, "devin");
    assert.deepEqual(workflow.harnesses["claude"], { model: "sonnet", effort: "high", command: "/opt/bin/claude-agent-acp" });
    assert.deepEqual(workflow.harnesses["devin"], { model: "swe-2-high", effort: null, command: null });
    assert.equal(workflow.planFollowUp, "/engineering-mode");
    assert.deepEqual(workflow.rules, ["Rule one.", "Rule two."]);
    assert.deepEqual(workflow.leftover.wrappers, [{ program: "jobq", ignoreArgs: ["--status"], hint: "stop it with {{pid}}" }]);
    assert.equal(workflow.leftover.rules[0]?.match.test("node vitest run"), true);
    assert.equal(workflow.leftover.rules[1]?.alsoMatch?.test("chrome --headless"), true);
    assert.equal(workflow.limitProbe, "cam");
    assert.deepEqual(workflow.wake, ["needs_answer", "loop_halted"]);
  });

  it("wakes an orchestrator for decisions and escalations unless the workflow says otherwise", () => {
    const wake = parse("{}").wake;

    assert.ok(wake.includes("needs_reply") && wake.includes("iteration_stalled"));
    assert.equal(wake.includes("iteration_done"), false);
  });

  it("takes a single string for rules as one line", () => {
    assert.deepEqual(parse("rules: Only one.").rules, ["Only one."]);
  });
});

describe("parseWorkflow refusals", () => {
  it("names an unknown key and the keys it expected, so a typo never runs a default", () => {
    assert.throws(() => parse("backlg: {}"), /autopilot\.yaml: unknown key "backlg"; expected one of version, prompt/);
    assert.throws(() => parse("backlog: { mark: x }"), /autopilot\.yaml\.backlog: unknown key "mark"; expected one of source, file, marker/);
  });

  it("refuses a value of the wrong shape and quotes it", () => {
    assert.throws(() => parse("limits: { probe: cmd }"), /limits\.probe: expected one of cam, none, got "cmd"/);
    assert.throws(() => parse("rules: [1]"), /rules: expected a list of strings, got \[1\]/);
    assert.throws(() => parse("harness: gpt"), /harness: expected one of claude, devin, got "gpt"/);
    assert.throws(() => parse("harnesses: { gpt: {} }"), /harnesses\.gpt: expected a known harness \(claude, devin\), got "gpt"/);
    assert.throws(() => parse("harnesses: { devin: { modle: x } }"), /harnesses\.devin: unknown key "modle"; expected one of model, effort, command/);
    assert.throws(() => parse("version: 2"), /version: expected 1, got 2/);
  });

  it("refuses text that is not YAML, a pattern that is not a regular expression, and an event it never emits", () => {
    assert.throws(() => parse("a: [1"), /not valid YAML/);
    assert.throws(() => parse("preflight: { leftover: [{ match: '(' }] }"), /leftover\[0\]\.match: not a valid regular expression/);
    assert.throws(() => parse("wake: [iteration_dnoe]"), /wake: expected an event name/);
  });
});

describe("loadWorkflow", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "workflow-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to the defaults when an optional file is absent, and fails when a named one is", async () => {
    assert.equal((await loadWorkflow(join(dir, "absent.yaml"), false)).prompt, "prompt-execution.md");
    await assert.rejects(() => loadWorkflow(join(dir, "absent.yaml"), true), /ENOENT/);
  });

  it("reads JSON too, since JSON is YAML", async () => {
    const path = join(dir, "autopilot.yaml");
    await writeFile(path, '{"run_dir": ".run"}');

    assert.equal((await loadWorkflow(path, true)).runDir, ".run");
  });
});

describe("parseWorkflow wrapper rules", () => {
  it("takes a program alone, with no ignored arguments and no hint", () => {
    assert.deepEqual(parse("preflight: { wrappers: [{ program: taskq }] }").leftover.wrappers, [{ program: "taskq", ignoreArgs: [], hint: null }]);
  });

  it("refuses a rule with no program, or an unknown key, naming the path", () => {
    assert.throws(() => parse("preflight: { wrappers: [{ ignore_args: [-h] }] }"), /wrappers\[0\]\.program: expected a non-empty string/);
    assert.throws(() => parse("preflight: { wrappers: [{ program: q, ignore: [] }] }"), /wrappers\[0\]: unknown key "ignore"/);
    assert.throws(() => parse("preflight: { wrapper: true }"), /preflight: unknown key "wrapper"; expected one of leftover, wrappers, host_check/);
  });
});

describe("parseWorkflow backlog sources", () => {
  it("reads a markdown source by default, with its file and marker", () => {
    assert.deepEqual(parse("{}").backlog, { source: "markdown", file: "docs/backlog.md", marker: "← next" });
    assert.deepEqual(parse("backlog: { source: markdown, file: TODO.md, marker: NEXT }").backlog, { source: "markdown", file: "TODO.md", marker: "NEXT" });
  });

  it("reads a command source as a shell text or an argument list, with its own timeout", () => {
    assert.deepEqual(parse("backlog: { source: command, command: ls todo | head -1 }").backlog, { source: "command", command: "ls todo | head -1", timeoutMs: 30_000 });
    assert.deepEqual(
      parse("backlog: { source: command, command: [./next-task.sh, --id], timeout_seconds: 5 }").backlog,
      { source: "command", command: ["./next-task.sh", "--id"], timeoutMs: 5_000 },
    );
  });

  it("refuses a key that belongs to the other source, saying which source it belongs to, rather than letting one win", () => {
    assert.throws(
      () => parse("backlog: { command: ls }"),
      /backlog: "command" belongs to source "command" but source is "markdown"; set source: command, or remove "command"/,
    );
    assert.throws(
      () => parse("backlog: { source: command, command: ls, marker: x }"),
      /backlog: "marker" belongs to source "markdown" but source is "command"; set source: markdown, or remove "marker"/,
    );
  });

  it("refuses a command source with no command, a bad command, an unknown source and a timeout that is not above zero", () => {
    assert.throws(() => parse("backlog: { source: command }"), /backlog\.command: expected a shell text or a non-empty argument list, got undefined/);
    assert.throws(() => parse("backlog: { source: command, command: 3 }"), /backlog\.command: expected a shell text or a non-empty argument list, got 3/);
    assert.throws(() => parse("backlog: { source: command, command: [] }"), /backlog\.command: expected a shell text/);
    assert.throws(() => parse("backlog: { source: queue }"), /backlog\.source: expected one of markdown, command, got "queue"/);
    assert.throws(() => parse("backlog: { source: command, command: ls, timeout_seconds: 0 }"), /backlog\.timeout_seconds: expected a number above 0, got 0/);
  });

  it("checks the host by default and lets a repository turn that off", () => {
    assert.equal(parse("{}").hostCheck, true);
    assert.equal(parse("preflight: { host_check: false }").hostCheck, false);
    assert.throws(() => parse("preflight: { host_check: 'no' }"), /preflight\.host_check: expected true or false, got "no"/);
  });
});
