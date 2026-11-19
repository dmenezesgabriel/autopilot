import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeJournal, type JournalEvent } from "./journal-summary.ts";
import { checkAnswer, checkStop } from "./operator-checks.ts";

let clock = 0;
const at = (type: string, detail: Record<string, unknown> = {}): JournalEvent => ({ at: `t${++clock}`, type, ...detail });

const LIVE = { pid: 42, alive: true };
const TWO_QUESTIONS = [
  { header: "Word", question: "Which word?", options: [{ label: "hi" }, { label: "yo" }] },
  { header: "Place", question: "Which place?", options: [{ label: "here" }, { label: "there" }] },
];

function waiting(...asks: JournalEvent[]) {
  return summarizeJournal([at("loop_started"), at("iteration_started", { row: "R-1", head: "a" }), ...asks]);
}

describe("checkAnswer", () => {
  it("accepts one label per question that waits, and says nothing", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }));

    assert.deepEqual(checkAnswer(summary, LIVE, { id: "q3", kind: "question", values: ["hi", "there"] }), []);
  });

  it("refuses an id nothing waits on, and lists what does wait", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }), at("needs_reply", { id: "r4", why: "no_commit" }));

    assert.throws(
      () => checkAnswer(summary, LIVE, { id: "q9", kind: "question", values: ["hi"] }),
      /"q9" is not waiting for an answer; waiting: q3 \(question\), r4 \(reply\)/,
    );
  });

  it("says plainly that nothing waits when nothing does", () => {
    assert.throws(
      () => checkAnswer(waiting(), LIVE, { id: "q1", kind: "question", values: ["hi"] }),
      /nothing is waiting for an answer or a reply/,
    );
  });

  it("refuses an id that was already answered, because the loop reads each file once", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }), at("answer_received", { id: "q3", answer: ["hi", "here"] }));

    assert.throws(() => checkAnswer(summary, LIVE, { id: "q3", kind: "question", values: ["yo", "here"] }), /"q3" is not waiting/);
  });

  it("refuses free text for a question and labels for a reply, naming the command that fits", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }), at("needs_reply", { id: "r4", why: "no_commit" }));

    assert.throws(() => checkAnswer(summary, LIVE, { id: "q3", kind: "reply", values: ["go on"] }), /q3 is a question: use `autopilot answer q3` with one label per question/);
    assert.throws(() => checkAnswer(summary, LIVE, { id: "r4", kind: "question", values: ["hi"] }), /r4 is a reply: use `autopilot reply r4` with free text/);
  });

  it("refuses the wrong number of labels, showing the questions and their options", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }));

    assert.throws(
      () => checkAnswer(summary, LIVE, { id: "q3", kind: "question", values: ["hi"] }),
      /q3 asks 2 questions and takes one label for each, got 1: 1\. Which word\? \[hi \| yo\]; 2\. Which place\? \[here \| there\]/,
    );
  });

  it("allows a label that is not an option, as the free text both agents accept, and names it", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }));

    const notes = checkAnswer(summary, LIVE, { id: "q3", kind: "question", values: ["hello", "there"] });

    assert.deepEqual(notes, ['note: "hello" is not one of question 1\'s options (hi, yo); it goes to the agent as free text']);
  });

  it("takes a reply of any text", () => {
    const summary = waiting(at("needs_reply", { id: "r4", why: "dirty_tree" }));

    assert.deepEqual(checkAnswer(summary, LIVE, { id: "r4", kind: "reply", values: ["commit it"] }), []);
  });

  it("refuses when no loop is there to read the file, even for an ask the journal still shows open", () => {
    const summary = waiting(at("needs_answer", { id: "q3", questions: TWO_QUESTIONS }));

    assert.throws(
      () => checkAnswer(summary, { pid: 42, alive: false }, { id: "q3", kind: "question", values: ["hi", "here"] }),
      /no loop runs here, so nothing would read "q3": start it with `autopilot run`/,
    );
  });
});

describe("checkStop", () => {
  it("lets a stop through when a loop runs", () => {
    assert.equal(checkStop(LIVE), null);
  });

  it("says there is nothing to stop when no loop runs, naming a pid that is gone", () => {
    assert.equal(checkStop({ pid: 7, alive: false }), "no loop runs here (pid 7 is not running), so there is nothing to stop");
    assert.equal(checkStop({ pid: null, alive: false }), "no loop runs here, so there is nothing to stop");
  });
});
