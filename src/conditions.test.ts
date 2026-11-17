import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allHold, holds, parseCondition, placeholdersIn, render, valuesAt } from "./conditions.ts";
import type { LoopEvent } from "./mailbox.ts";

const REPLY: LoopEvent = { type: "needs_reply", id: "r1", why: "no_commit", lastMessage: "I will wait for the host to calm", waitedMs: 700000 };
const ASK: LoopEvent = {
  type: "needs_answer",
  id: "q1",
  questions: [
    { header: "Environment", question: "Which environment runs the check?", options: [{ label: "staging (Recommended)" }, { label: "local" }] },
    { header: "Scope", question: "Split the task?", options: [{ label: "yes" }, { label: "no" }] },
  ],
};
const when = (path: string, value: unknown) => parseCondition(path, value, "when");

describe("conditions", () => {
  it("reads a bare value as equals", () => {
    assert.equal(holds(REPLY, when("why", "no_commit")), true);
    assert.equal(holds(REPLY, when("why", "dirty_tree")), false);
  });

  it("tests text with matches and contains, and numbers with gte and lte", () => {
    assert.equal(holds(REPLY, when("lastMessage", { matches: "wait.*calm" })), true);
    assert.equal(holds(REPLY, when("lastMessage", { contains: "host" })), true);
    assert.equal(holds(REPLY, when("waitedMs", { gte: 600000 })), true);
    assert.equal(holds(REPLY, when("waitedMs", { lte: 600000 })), false);
  });

  it("tests membership and presence", () => {
    assert.equal(holds(REPLY, when("why", { in: ["dirty_tree", "no_commit"] })), true);
    assert.equal(holds(REPLY, when("lastMessage", { exists: true })), true);
    assert.equal(holds(REPLY, when("nothing", { exists: false })), true);
    assert.equal(holds(REPLY, when("nothing", { exists: true })), false);
  });

  it("walks into lists, so one path reads every question's text", () => {
    assert.deepEqual(valuesAt(ASK, ["questions", "header"]), ["Environment", "Scope"]);
    assert.equal(holds(ASK, when("questions.question", { matches: "^Environment" })), false);
    assert.equal(holds(ASK, when("questions.question", { matches: "Which environment" })), true);
    assert.equal(holds(ASK, when("questions.options.label", { contains: "Recommended" })), true);
  });

  it("needs every entry of a when to hold", () => {
    const both = [when("why", "no_commit"), when("lastMessage", { contains: "wait" })];
    const one = [when("why", "no_commit"), when("lastMessage", { contains: "nothing like it" })];

    assert.equal(allHold(REPLY, both), true);
    assert.equal(allHold(REPLY, one), false);
    assert.equal(allHold(REPLY, []), true);
  });

  it("refuses a matcher with two tests, an unknown one, or a bad pattern, naming the path", () => {
    assert.throws(() => when("why", { matches: "a", in: [1] }), /when\.why: expected exactly one of/);
    assert.throws(() => when("why", { starts: "a" }), /when\.why: unknown key "starts"/);
    assert.throws(() => when("why", { matches: "(" }), /when\.why\.matches: not a valid regular expression/);
    assert.throws(() => when("waitedMs", { gte: "many" }), /when\.waitedMs\.gte: expected a number/);
  });
});

describe("templates", () => {
  it("fills {{field}} from the event, as JSON when it is not text", () => {
    assert.equal(render("Reply {{id}} because {{why}} ({{waitedMs}})", REPLY), "Reply r1 because no_commit (700000)");
  });

  it("writes a missing field as empty and reads nested paths", () => {
    assert.equal(render("[{{nothing}}] {{questions.header}}", ASK), "[] Environment");
  });

  it("lists the fields a text reads, for checking against the event", () => {
    assert.deepEqual(placeholdersIn("{{ id }} and {{questions.header}}"), ["id", "questions.header"]);
  });
});
