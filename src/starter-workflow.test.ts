import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STARTER_WORKFLOW } from "./starter-workflow.ts";
import { parseWorkflow } from "./workflow.ts";

/** Removes the comment marker from every commented handler example, so the template's examples are checked too. */
const uncommentHandlers = (text: string): string =>
  text.replace(/^on: \{\}\n/m, "on:\n").replace(/^#  (needs_|iteration_|loop_|rate_)/gm, "  $1").replace(/^#    /gm, "    ").replace(/^#      /gm, "      ");

describe("STARTER_WORKFLOW", () => {
  it("reads as the defaults, so init changes nothing until a repository edits it", () => {
    const workflow = parseWorkflow(STARTER_WORKFLOW, "autopilot.yaml");

    assert.equal(workflow.prompt, "prompt-execution.md");
    assert.deepEqual(workflow.handlers, []);
    assert.equal(workflow.limitProbe, "none");
  });

  it("holds handler examples that are themselves valid once uncommented", () => {
    const workflow = parseWorkflow(uncommentHandlers(STARTER_WORKFLOW), "autopilot.yaml");

    assert.deepEqual(
      workflow.handlers.map((handler) => handler.name),
      ["dont-wait", "take-the-recommended", "iteration_done#0", "loop_halted#0", "fail-over"],
    );
  });
});
