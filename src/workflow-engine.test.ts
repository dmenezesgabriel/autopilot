import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentChoice } from "./agent-choice.ts";
import type { Answer, AnswerFile, LoopEvent, MailboxFiles } from "./mailbox.ts";
import { parseWorkflow } from "./workflow.ts";
import { WorkflowEngine, type EnginePorts } from "./workflow-engine.ts";
import { WorkflowMailboxFiles } from "./workflow-hook.ts";

class FakePorts implements EnginePorts {
  answers: Array<[string, Answer, string]> = [];
  choices: AgentChoice[] = [];
  stops = 0;
  runs: Array<[string | string[], number]> = [];
  events: LoopEvent[] = [];
  failRun = false;
  async writeAnswer(id: string, answer: Answer, why: string): Promise<void> { this.answers.push([id, answer, why]); }
  async writeChoice(choice: AgentChoice): Promise<void> { this.choices.push(choice); }
  async requestStop(): Promise<void> { this.stops += 1; }
  async run(command: string | string[], _event: LoopEvent, timeoutMs: number): Promise<void> {
    this.runs.push([command, timeoutMs]);
    if (this.failRun) throw new Error("notify.sh ended with exit 3");
  }
  async emit(event: LoopEvent): Promise<void> { this.events.push(event); }
}

const engineFor = (on: string, ports = new FakePorts()) => ({
  ports,
  engine: new WorkflowEngine(parseWorkflow(`on:\n${on}`, "w.yaml").handlers, ports),
});

const DEVICE: LoopEvent = {
  type: "needs_answer", id: "q1",
  questions: [{ header: "Environment", question: "Which environment runs the check?", options: [{ label: "local" }, { label: "staging (Recommended)" }] }],
};
const WAITING: LoopEvent = { type: "needs_reply", id: "r1", why: "no_commit", lastMessage: "Waiting for the host load to fall" };

describe("WorkflowEngine plan", () => {
  it("picks the first handler whose when holds, and none when no handler matches", () => {
    const { engine } = engineFor(`
  needs_reply:
    - name: dirty
      when: { why: dirty_tree }
      do: { reply: a }
    - name: waits
      when: { why: no_commit, lastMessage: { matches: "[Ww]ait" } }
      do: { reply: b }
    - name: anything
      do: { reply: c }
`);

    assert.equal(engine.plan(WAITING)?.handler.name, "waits");
    assert.equal(engine.plan({ ...WAITING, lastMessage: "stuck" })?.handler.name, "anything");
    assert.equal(engine.plan({ type: "iteration_done", head: "x" }), null);
  });

  it("answers each question with its Recommended option, or the option a pattern chooses", () => {
    const recommended = engineFor("  needs_answer:\n    - do: { answer: recommended }").engine.plan(DEVICE);
    const chosen = engineFor("  needs_answer:\n    - do: { answer: { choose: '^loc' } }").engine.plan(DEVICE);

    assert.deepEqual(recommended?.answer, ["staging (Recommended)"]);
    assert.deepEqual(chosen?.answer, ["local"]);
  });

  it("leaves a question to the orchestrator when its rule finds no option, rather than guessing", () => {
    const noMarker = { ...DEVICE, questions: [{ header: "h", question: "q", options: [{ label: "a" }, { label: "b" }] }] };

    assert.equal(engineFor("  needs_answer:\n    - do: { answer: recommended }").engine.plan(noMarker), null);
    assert.equal(engineFor("  needs_answer:\n    - do: { answer: { choose: '^zzz' } }").engine.plan(DEVICE), null);
  });

  it("falls through to a later handler when an earlier one cannot answer", () => {
    const { engine } = engineFor(`
  needs_answer:
    - name: strict
      do: { answer: { choose: '^zzz' } }
    - name: loose
      do: { answer: first }
`);

    assert.equal(engine.plan(DEVICE)?.handler.name, "loose");
  });

  it("never handles its own records, so a handler cannot loop", () => {
    const { engine } = engineFor("  iteration_done:\n    - do: { stop: true }");

    assert.equal(engine.plan({ type: "workflow_applied", event: "iteration_done" }), null);
  });

  it("gives the reason of a yield, rendered from the event", () => {
    const { engine } = engineFor("  rate_limited:\n    - do: { yield: 'limited until {{wakeAt}}' }");

    assert.equal(engine.yieldReason({ type: "rate_limited", wakeAt: "2026-11-17T22:01:00Z" }), "limited until 2026-11-17T22:01:00Z");
    assert.equal(engine.yieldReason({ type: "iteration_done" }), null);
  });
});

describe("WorkflowEngine actions", () => {
  it("answers a reply with its text filled from the event, the id it belongs to and why", async () => {
    const { engine, ports } = engineFor(`
  needs_reply:
    - name: stop-waiting
      why: wait rule
      do: { reply: "Continue; {{why}} is not a reason to stop." }
`);

    engine.start(WAITING, engine.plan(WAITING) as never);
    await engine.idle();

    assert.deepEqual(ports.answers, [["r1", "Continue; no_commit is not a reason to stop.", "wait rule"]]);
    assert.deepEqual(ports.events.map((event) => event.type), ["workflow_applied"]);
  });

  it("answers a question with the labels it picked", async () => {
    const { engine, ports } = engineFor("  needs_answer:\n    - name: device\n      do: { answer: recommended }");

    engine.start(DEVICE, engine.plan(DEVICE) as never);
    await engine.idle();

    assert.deepEqual(ports.answers, [["q1", ["staging (Recommended)"], "workflow device"]]);
  });

  it("runs a command with its arguments filled, switches the next agent and requests a stop", async () => {
    const { engine, ports } = engineFor(`
  loop_halted:
    - do:
        - run: ["./notify.sh", "halted: {{reason}}"]
        - use: { harness: devin, model: swe-2-high }
        - stop: true
`);
    const event: LoopEvent = { type: "loop_halted", reason: "weekly_limit" };

    engine.start(event, engine.plan(event) as never);
    await engine.idle();

    assert.deepEqual(ports.runs, [[["./notify.sh", "halted: weekly_limit"], 60_000]]);
    assert.deepEqual(ports.choices, [{ agent: "devin", model: "swe-2-high", effort: null }]);
    assert.equal(ports.stops, 1);
  });

  it("journals a failed action and still runs the ones after it", async () => {
    const ports = new FakePorts();
    ports.failRun = true;
    const { engine } = engineFor("  loop_halted:\n    - name: tell\n      do:\n        - run: ./notify.sh\n        - stop: true", ports);
    const event: LoopEvent = { type: "loop_halted", reason: "x" };

    engine.start(event, engine.plan(event) as never);
    await engine.idle();

    assert.equal(ports.stops, 1);
    assert.deepEqual(ports.events.map((e) => [e.type, e["handler"], e["action"]]), [
      ["workflow_error", "tell", "run"],
      ["workflow_applied", "tell", undefined],
    ]);
    assert.match(String(ports.events[0]?.["error"]), /exit 3/);
  });
});

describe("WorkflowMailboxFiles", () => {
  class Journal implements MailboxFiles {
    events: LoopEvent[] = [];
    async appendEvent(event: LoopEvent): Promise<void> { this.events.push(event); }
    async readAnswer(): Promise<AnswerFile | null> { return null; }
    async clearAnswer(): Promise<void> {}
  }

  it("journals an event a handler answers with `handledBy`, so a watcher skips it, then runs the actions", async () => {
    const { engine, ports } = engineFor("  needs_reply:\n    - name: stop-waiting\n      do: { reply: go on }");
    const journal = new Journal();
    const files = new WorkflowMailboxFiles(journal, engine);

    await files.appendEvent(WAITING);
    await engine.idle();

    assert.deepEqual(journal.events, [{ ...WAITING, handledBy: "stop-waiting" }]);
    assert.equal(ports.answers.length, 1);
  });

  it("has written an answer by the time the event is journaled, so the loop that waits for it finds it", async () => {
    const { engine, ports } = engineFor("  needs_reply:\n    - name: go-on\n      do: { reply: go on }");
    const files = new WorkflowMailboxFiles(new Journal(), engine);

    await files.appendEvent(WAITING);

    assert.equal(ports.answers.length, 1);
  });

  it("does not hold the loop for a slow command a handler also runs", async () => {
    let finish: () => void = () => undefined;
    const ports = new FakePorts();
    ports.run = () => new Promise<void>((resolve) => { finish = resolve; });
    const { engine } = engineFor("  needs_reply:\n    - do:\n        - run: ./slow.sh\n        - reply: go on", ports);
    const files = new WorkflowMailboxFiles(new Journal(), engine);

    await files.appendEvent(WAITING);

    assert.equal(ports.answers.length, 1);
    finish();
    await engine.idle();
  });

  it("journals an event a handler only reports on as it was, since a person may still need to act", async () => {
    const { engine } = engineFor("  loop_halted:\n    - do: { run: ./notify.sh }");
    const journal = new Journal();
    const files = new WorkflowMailboxFiles(journal, engine);
    const event: LoopEvent = { type: "loop_halted", reason: "x" };

    await files.appendEvent(event);
    await engine.idle();

    assert.deepEqual(journal.events, [event]);
  });

  it("passes an event no handler matches straight through", async () => {
    const { engine, ports } = engineFor("  loop_halted:\n    - do: { stop: true }");
    const journal = new Journal();

    await new WorkflowMailboxFiles(journal, engine).appendEvent({ type: "iteration_done", head: "a" });
    await engine.idle();

    assert.equal(journal.events.length, 1);
    assert.equal(ports.stops, 0);
  });
});
