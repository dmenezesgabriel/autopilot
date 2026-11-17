import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { loadWorkflow, type Workflow } from "./workflow.ts";

const DIR = new URL("../examples/", import.meta.url).pathname;
const load = (name: string): Promise<Workflow> => loadWorkflow(`${DIR}${name}.yaml`, true);
const NAMES = readdirSync(DIR).filter((file) => file.endsWith(".yaml")).map((file) => file.slice(0, -5));

describe("the shipped examples", () => {
  it("are there, so a repository has something to start from", () => {
    assert.deepEqual(NAMES.sort(), ["command-backlog", "failover", "guardrails", "minimal"]);
  });

  it("each read without error, so a typo in one never ships", async () => {
    for (const name of NAMES) assert.ok((await load(name)).wake.length > 0, name);
  });
});

describe("the minimal example", () => {
  it("picks a harness and its model and effort, and leaves the rest at the defaults", async () => {
    const workflow = await load("minimal");

    assert.equal(workflow.harness, "claude");
    assert.deepEqual(workflow.harnesses["claude"], { model: "sonnet", effort: "high", command: null });
    assert.deepEqual(workflow.handlers, []);
  });
});

describe("the guardrails example", () => {
  it("states rules, waits for a wrapped job, and has three handlers: a reply rule, a report and a page", async () => {
    const workflow = await load("guardrails");

    assert.equal(workflow.rules.length, 2);
    assert.equal(workflow.leftover.rules.length, 2);
    assert.equal(workflow.leftover.wrappers[0]?.program, "jobq");
    assert.deepEqual(workflow.handlers.map((handler) => handler.event), ["needs_reply", "iteration_done", "loop_halted"]);
  });
});

describe("the failover example", () => {
  it("has each harness's own settings and a handler that switches harness and yields on a limit", async () => {
    const workflow = await load("failover");
    const handler = workflow.handlers[0];

    assert.equal(workflow.harnesses["devin"]?.command, "devin");
    assert.equal(workflow.limitProbe, "cam");
    assert.deepEqual(handler?.actions.map((action) => action.kind), ["use", "yield"]);
  });
});

describe("the command-backlog example", () => {
  it("takes its next row from a command and does not wait for the host", async () => {
    const workflow = await load("command-backlog");

    assert.deepEqual(workflow.backlog, { source: "command", command: "ls todo | head -1", timeoutMs: 30_000 });
    assert.equal(workflow.hostCheck, false);
  });
});
