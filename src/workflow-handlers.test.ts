import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWorkflow } from "./workflow.ts";

const handlers = (on: string) => parseWorkflow(`version: 1\non:\n${on}`, "w.yaml").handlers;

describe("handlers", () => {
  it("reads a handler with a name, conditions and a list of actions, in order", () => {
    const [handler] = handlers(`
  needs_reply:
    - name: stop-waiting
      why: the wait rule says so
      when:
        why: { in: [no_commit, dirty_tree] }
        lastMessage: { matches: "[Ww]ait" }
      do:
        - reply: "Continue. Do not end your turn to wait."
        - run: ["notify-send", "autopilot", "{{why}}"]
`);

    assert.equal(handler?.name, "stop-waiting");
    assert.equal(handler?.why, "the wait rule says so");
    assert.equal(handler?.when.length, 2);
    assert.deepEqual(handler?.actions.map((action) => action.kind), ["reply", "run"]);
  });

  it("names a handler after its event and position when it has no name, and takes one action without a list", () => {
    const [first, second] = handlers(`
  iteration_done:
    - do: { stop: true }
    - do: { use: { harness: claude } }
`);

    assert.equal(first?.name, "iteration_done#0");
    assert.equal(second?.name, "iteration_done#1");
    assert.deepEqual(second?.actions, [{ kind: "use", agent: "claude", model: null, effort: null }]);
  });

  it("reads each way to run a command, with a timeout when given", () => {
    const [handler] = handlers(`
  loop_halted:
    - do:
        - run: ./notify.sh
        - run: { command: [./notify.sh, "{{reason}}"], timeout_seconds: 5 }
`);

    assert.deepEqual(handler?.actions[0], { kind: "run", command: "./notify.sh", timeoutMs: 60_000 });
    assert.deepEqual(handler?.actions[1], { kind: "run", command: ["./notify.sh", "{{reason}}"], timeoutMs: 5_000 });
  });

  it("reads the three ways to answer", () => {
    const [recommended, first, chosen] = handlers(`
  needs_answer:
    - do: { answer: recommended }
    - do: { answer: first }
    - do: { answer: { choose: "^stag" } }
`);

    assert.deepEqual(recommended?.actions, [{ kind: "answer", choice: "recommended" }]);
    assert.deepEqual(first?.actions, [{ kind: "answer", choice: "first" }]);
    assert.equal((chosen?.actions[0] as { choice: { choose: RegExp } }).choice.choose.test("staging"), true);
  });

  it("refuses an event the loop never emits, and the workflow's own records", () => {
    assert.throws(() => handlers("  iteration_dnoe:\n    - do: { stop: true }"), /on\.iteration_dnoe: expected an event name/);
    assert.throws(() => handlers("  workflow_error:\n    - do: { stop: true }"), /workflow_\* events are its own record/);
  });

  it("refuses an action on an event where the loop would never read its result", () => {
    assert.throws(() => handlers("  iteration_done:\n    - do: { answer: first }"), /answer only on needs_answer, got "iteration_done"/);
    assert.throws(() => handlers("  needs_answer:\n    - do: { reply: hello }"), /reply only on needs_reply/);
    assert.throws(() => handlers("  iteration_done:\n    - do: { yield: now }"), /yield only on rate_limited/);
  });

  it("refuses a when or placeholder that names a field the event does not have, listing the ones it has", () => {
    assert.throws(() => handlers("  needs_reply:\n    - when: { reason: x }\n      do: { stop: true }"), /when\.reason: expected a field of needs_reply \(type, at, id, why, lastMessage\), got "reason"/);
    assert.throws(() => handlers("  needs_reply:\n    - do: { reply: 'see {{nothing}}' }"), /\{\{nothing\}\}: expected a field of needs_reply/);
  });

  it("refuses a field placeholder in a shell string, because the agent wrote those fields", () => {
    assert.throws(() => handlers("  needs_reply:\n    - do: { run: 'echo {{lastMessage}}' }"), /a shell text without \{\{field\}\}/);
  });

  it("refuses a handler with no actions, an action it does not know, two actions in one item, and an unknown agent", () => {
    assert.throws(() => handlers("  iteration_done:\n    - when: {}"), /\.do: expected an action or a list of actions/);
    assert.throws(() => handlers("  iteration_done:\n    - do: { explode: true }"), /expected one action: answer, reply, run, use, stop, yield/);
    assert.throws(() => handlers("  iteration_done:\n    - do: { stop: true, run: x }"), /expected one action/);
    assert.throws(() => handlers("  iteration_done:\n    - do: { use: { harness: gpt } }"), /use\.harness: expected one of claude, devin, got "gpt"/);
  });
});
