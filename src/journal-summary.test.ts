import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeSummary,
  summarizeJournal,
  type JournalEvent,
} from "./journal-summary.ts";
import { assertContains, assertPartial } from "./testing/assertions.ts";

let clock = 0;
const at = (
  type: string,
  detail: Record<string, unknown> = {},
): JournalEvent => ({
  at: `t${++clock}`,
  type,
  ...detail,
});

const STARTED = [
  at("loop_started"),
  at("iteration_started", { row: "Items", head: "aaa" }),
  at("session_started", { sessionId: "wool-care" }),
  at("mode_changed", { mode: "plan" }),
];

describe("summarizeJournal", () => {
  it("is never_started for an empty journal", () => {
    assertPartial(summarizeJournal([]), {
      loop: "never_started",
      open: null,
    });
  });

  it("tracks the open iteration's session and mode", () => {
    const summary = summarizeJournal(STARTED);

    assert.equal(summary.loop, "running");
    assertPartial(summary.open, {
      n: 1,
      row: "Items",
      sessionId: "wool-care",
      mode: "plan",
    });
  });

  it("keeps a question pending until its answer arrives, then keeps the decision and its reason", () => {
    const asked = [...STARTED, at("needs_answer", { id: "q1" })];
    assertPartial(summarizeJournal(asked).open?.pending, [
      { id: "q1", kind: "question" },
    ]);

    const answered = summarizeJournal([
      ...asked,
      at("answer_received", {
        id: "q1",
        answer: ["zod"],
        why: "ADR-0004 keeps the schema library",
      }),
    ]);

    assert.deepEqual(answered.open?.pending, []);
    assertPartial(answered.decisions, [
      {
        id: "q1",
        how: "answered",
        answer: ["zod"],
        why: "ADR-0004 keeps the schema library",
      },
    ]);
  });

  it("marks an overdue question and records a defaulted one as a defaulted decision", () => {
    const events = [
      ...STARTED,
      at("needs_answer", { id: "q1" }),
      at("needs_answer_overdue", { id: "q1" }),
    ];
    assert.equal(summarizeJournal(events).open?.pending[0]?.overdue, true);

    const defaulted = summarizeJournal([
      ...events,
      at("answer_defaulted", { id: "q1" }),
    ]);

    assertPartial(defaulted.decisions[0], {
      how: "defaulted",
      why: null,
    });
    assert.deepEqual(defaulted.open?.pending, []);
  });

  it("lists background commands from start to exit", () => {
    const running = [
      ...STARTED,
      at("background_started", { shellId: "19d403", command: "run the suite" }),
    ];
    assert.deepEqual(summarizeJournal(running).open?.running, [
      "19d403: run the suite",
    ]);

    const exited = summarizeJournal([
      ...running,
      at("background_exited", { shellId: "19d403", exitCode: 0 }),
    ]);

    assert.deepEqual(exited.open?.running, []);
  });

  it("shows a rate limit until the next turn ends", () => {
    const limited = [...STARTED, at("rate_limited", { wakeAt: "22:01" })];
    assert.equal(summarizeJournal(limited).open?.rateLimitedUntil, "22:01");

    assert.equal(
      summarizeJournal([...limited, at("turn_ended")]).open?.rateLimitedUntil,
      null,
    );
  });

  it("moves a finished iteration out of open with its outcome and commit", () => {
    const summary = summarizeJournal([
      ...STARTED,
      at("iteration_done", { head: "bbb222" }),
    ]);

    assert.equal(summary.open, null);
    assertPartial(summary.finished, [
      { n: 1, row: "Items", outcome: "done", detail: "bbb222" },
    ]);
  });

  it("numbers iterations across the run and records an interrupted one", () => {
    const summary = summarizeJournal([
      ...STARTED,
      at("iteration_interrupted"),
      at("iteration_started", { row: "Items", head: "aaa" }),
    ]);

    assertPartial(summary.finished[0], { n: 1, outcome: "interrupted" });
    assert.equal(summary.open?.n, 2);
  });

  it("reads how the loop ended", () => {
    assertPartial(
      summarizeJournal([
        at("loop_started"),
        at("loop_halted", { reason: "halted: weekly_limit" }),
      ]),
      {
        loop: "halted",
        haltReason: "halted: weekly_limit",
      },
    );
    assert.equal(
      summarizeJournal([at("loop_started"), at("backlog_exhausted")]).loop,
      "exhausted",
    );
    assert.equal(
      summarizeJournal([at("loop_started"), at("stop")]).loop,
      "stopped",
    );
  });
});

describe("describeSummary", () => {
  it("names what runs, what waits and what was decided, and warns when the loop's pid is gone", () => {
    const summary = summarizeJournal([
      ...STARTED,
      at("background_started", { shellId: "a", command: "run the suite" }),
      at("answer_received", {
        id: "q0",
        answer: ["hi"],
        why: "closest to the original",
      }),
      at("needs_reply", { id: "r1" }),
    ]);

    const text = describeSummary(summary, 4242, false);

    assertContains(text, "pid 4242 is NOT running");
    assertContains(text, "running: a: run the suite");
    assertContains(text, "waiting for reply r1");
    assertContains(text, 'q0 answered ["hi"] because closest to the original');
  });
});

describe("what a session ran on, in the journal", () => {
  const devin = { agent: "devin", model: "swe-2-high", effort: "high" };

  it("records what an iteration's session really ran on, from the agent's own read-back", () => {
    const events = [
      at("loop_started", devin),
      at("iteration_started", { row: "Items", head: "aaa" }),
      at("session_started", { sessionId: "s1", agent: "devin", model: "swe-2-high", effort: "medium" }),
    ];

    assert.deepEqual(summarizeJournal(events).open?.ranOn, {
      agent: "devin",
      model: "swe-2-high",
      effort: "medium",
    });
  });

  it("leaves what a session ran on unknown for a journal written before the choice was recorded", () => {
    assert.equal(summarizeJournal(STARTED).open?.ranOn, null);
  });

  it("does not read a session that recorded no agent as claude: the journal says nothing there", () => {
    const events = [at("loop_started"), at("iteration_started", { row: "Items", head: "aaa" }), at("session_started", { sessionId: "s1", model: "x" })];

    assert.equal(summarizeJournal(events).open?.ranOn, null);
  });

  it("puts the next-session lines it is given under the loop line, and what the open one runs on", () => {
    const events = [
      at("loop_started", devin),
      at("iteration_started", { row: "Items", head: "aaa" }),
      at("session_started", { sessionId: "s1", agent: "devin", model: "swe-2-high", effort: "medium" }),
    ];

    const lines = describeSummary(summarizeJournal(events), 1, true, ["next session: devin, model swe-2-high, effort high"]).split("\n");

    assert.equal(lines[0], "loop: running (pid 1 alive)");
    assert.equal(lines[1], "next session: devin, model swe-2-high, effort high");
    assertContains(lines.join("\n"), "session s1 on devin, model swe-2-high, effort medium");
  });

  it("forgets an earlier halt when the loop starts again, so a restart is not reported as halted", () => {
    const events = [
      at("loop_started"),
      at("loop_halted", { reason: "weekly_limit" }),
      at("loop_started"),
    ];

    assertPartial(summarizeJournal(events), { loop: "running", haltReason: null });
  });
});

describe("how a loop run ends", () => {
  const ended = (type: string, detail: Record<string, unknown> = {}) =>
    summarizeJournal([at("loop_started"), at(type, detail)]);

  it("reads every event the registry says ends a loop, so a signal is not left as running", () => {
    assertPartial(ended("loop_signalled", { signal: "SIGTERM" }), { loop: "signalled" });
    assertPartial(ended("stop"), { loop: "stopped" });
    assertPartial(ended("backlog_exhausted"), { loop: "exhausted" });
    assertPartial(ended("loop_halted", { reason: "weekly_limit" }), { loop: "halted", haltReason: "weekly_limit" });
  });

  it("reads a crashed iteration as finished, like every other ending", () => {
    const summary = summarizeJournal([at("loop_started"), at("iteration_started", { row: "Items", head: "a" }), at("iteration_crashed", { kind: "crashed" })]);

    assert.equal(summary.open, null);
    assertPartial(summary.finished[0], { outcome: "crashed", row: "Items" });
  });
});

describe("what a pending ask carries", () => {
  it("keeps each question's options, so an answer can be checked against them", () => {
    const questions = [{ header: "Word", question: "Which word?", options: [{ label: "hi" }, { label: "yo", description: "casual" }] }];
    const summary = summarizeJournal([...STARTED, at("needs_answer", { id: "q1", questions })]);

    assert.deepEqual(summary.open?.pending[0]?.questions, [{ header: "Word", question: "Which word?", options: ["hi", "yo"] }]);
  });

  it("carries no questions for a reply", () => {
    const summary = summarizeJournal([...STARTED, at("needs_reply", { id: "r1", why: "no_commit" })]);

    assert.deepEqual(summary.open?.pending[0]?.questions, []);
  });
});

describe("the counts in the report", () => {
  const decided = (n: number): JournalEvent[] =>
    Array.from({ length: n }, (_, k) => at("answer_received", { id: `q${k + 1}`, answer: ["x"], why: null }));

  it("says how many decisions are listed when there are more than it lists", () => {
    const text = describeSummary(summarizeJournal([...STARTED, ...decided(8)]), null, false);

    assertContains(text, "decisions: 8 (the last 5 below)");
    assert.equal(text.split("\n").filter((line) => line.includes("answered")).length, 5);
  });

  it("stays plain when every decision is listed", () => {
    const text = describeSummary(summarizeJournal([...STARTED, ...decided(2)]), null, false);

    assertContains(text, "decisions: 2\n");
    assertContains(text, "q2 answered");
  });
});
