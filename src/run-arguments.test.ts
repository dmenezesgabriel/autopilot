import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overrideFromFlags, parseArguments } from "./run.ts";

const parse = (argv: string[]) => parseArguments(argv, "/work/repo");

describe("parseArguments", () => {
  it("defaults to the cwd, and says nothing about the harness, model, effort or paths a workflow decides", () => {
    assert.deepEqual(parse([]), {
      repoRoot: "/work/repo",
      workflowPath: "/work/repo/autopilot.yaml",
      workflowRequired: false,
      runDir: null,
      promptFile: null,
      harness: null,
      agentCommand: null,
      model: null,
      effort: null,
      planFollowUp: null,
    });
  });

  it("reads each flag by name, not by position", () => {
    const parsed = parse(["--prompt", "other.md", "--repo", "/srv/other"]);

    assert.equal(parsed.repoRoot, "/srv/other");
    assert.equal(parsed.promptFile, "/srv/other/other.md");
    assert.equal(parsed.workflowPath, "/srv/other/autopilot.yaml");
  });

  it("requires the workflow file it is told to read, and defaults to the repository's own", () => {
    const named = parse(["--workflow", "ci/loop.yaml"]);

    assert.equal(named.workflowPath, "/work/repo/ci/loop.yaml");
    assert.equal(named.workflowRequired, true);
  });

  it("reads the plan follow-up command from its flag, and refuses the flag with no command", () => {
    assert.equal(parse(["--plan-follow-up", "/engineering-mode"]).planFollowUp, "/engineering-mode");
    assert.throws(() => parse(["--plan-follow-up"]), (error: Error) => error.message.includes('--plan-follow-up needs a command such as "/engineering-mode", got none'));
    assert.throws(() => parse(["--plan-follow-up", "--repo", "/x"]), (error: Error) => error.message.includes('got "--repo"'));
  });

  it("takes the executable from --agent-command, for a shell whose PATH has no nvm", () => {
    assert.equal(parse(["--agent-command", "/opt/node/bin/claude-agent-acp"]).agentCommand, "/opt/node/bin/claude-agent-acp");
  });
});

describe("parseArguments harness, model and effort", () => {
  it("selects the harness by --harness, and by --agent which means the same", () => {
    assert.equal(parse(["--harness", "devin"]).harness, "devin");
    assert.equal(parse(["--agent", "claude"]).harness, "claude");
  });

  it("refuses an unknown harness and a flag with no harness, naming the valid ones", () => {
    assert.throws(() => parse(["--harness", "gpt"]), (error: Error) => error.message.includes('harness must be one of claude, devin, got "gpt"'));
    assert.throws(() => parse(["--harness"]), (error: Error) => error.message.includes("harness must be one of claude, devin, got none"));
  });

  it("takes the model and the effort from their flags, and leaves them null when not given", () => {
    const chosen = parse(["--model", "haiku", "--effort", "high"]);

    assert.deepEqual([chosen.model, chosen.effort], ["haiku", "high"]);
    assert.deepEqual([parse([]).model, parse([]).effort], [null, null]);
  });

  it("refuses a --model or --effort with no value, rather than silently running the default", () => {
    assert.throws(() => parse(["--effort"]), (error: Error) => error.message.includes("--effort needs an effort the harness offers, got none"));
    assert.throws(() => parse(["--model", "--repo", "/x"]), (error: Error) => error.message.includes('--model needs a model id the harness offers, got "--repo"'));
  });
});

describe("overrideFromFlags", () => {
  it("is nothing when no flag chooses, so the workflow and any earlier `use` stand", () => {
    assert.equal(overrideFromFlags(parse(["--repo", "/x"])), null);
  });

  it("overrides only the fields a flag names, leaving the others to the workflow", () => {
    assert.deepEqual(overrideFromFlags(parse(["--model", "haiku"])), { agent: null, model: "haiku", effort: null });
    assert.deepEqual(overrideFromFlags(parse(["--harness", "devin", "--effort", "high"])), { agent: "devin", model: null, effort: "high" });
  });
});
