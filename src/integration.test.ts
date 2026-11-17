import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FAKE_AGENT, runLoop, shipRow, typesOf, type LoopCase, type LoopResult } from "./testing/loop-harness.ts";

/**
 * The real `autopilot run`, in a throwaway repository, against a scripted agent that speaks the frames
 * recorded from claude-agent-acp. These are the paths a loop takes in production, exercised with no
 * model and no credits.
 */
const results: LoopResult[] = [];
afterEach(async () => {
  for (const result of results.splice(0)) await result.cleanup();
});

async function run(spec: LoopCase): Promise<LoopResult> {
  const result = await runLoop(spec);
  results.push(result);
  return result;
}

const TWO_ROW_SESSIONS = [
  { plan: "Ship R-1.", work: shipRow("R-1", "R-2", "ship R-1") },
  { plan: "Ship R-2.", work: shipRow("R-2", null, "ship R-2") },
];

const rowsOf = (result: LoopResult): unknown[] =>
  result.events.filter((event) => event["type"] === "iteration_started").map((event) => event["row"]);

describe("the CLI file", () => {
  it("runs when it is started directly, which is how a service unit and `npm run autopilot` start it", async () => {
    const { execFileSync } = await import("node:child_process");
    const cli = new URL("./cli.ts", import.meta.url).pathname;

    const out = execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", cli, "--version"], { encoding: "utf8" });

    assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
  });
});

describe("a loop over a markdown backlog", () => {
  it("runs one session per row, ends each at its commit, and stops when no row is left", async () => {
    const result = await run({ workflow: "", sessions: TWO_ROW_SESSIONS });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(rowsOf(result), ["R-1", "R-2"]);
    assert.deepEqual(typesOf(result).filter((type) => type.startsWith("iteration_") && type !== "iteration_started"), ["iteration_done", "iteration_done"]);
    assert.equal(typesOf(result).at(-1), "backlog_exhausted");
    assert.deepEqual(result.commits, ["ship R-1", "ship R-2"]);
  });

  it("gives each session the prompt file and the workflow's rules, and approves the plan under the follow-up command", async () => {
    const result = await run({ workflow: 'rules: ["Rule: be brief."]\nplan: { follow_up: "/engineering-mode" }\n', sessions: TWO_ROW_SESSIONS });

    const first = await result.state("prompts-1.log");
    assert.match(first, /# Do the next row/);
    assert.match(first, /Follow prompt-execution\.md \(attached\)\./);
    assert.match(first, /Rule: be brief\./);
    assert.match(await result.state("prompts-1.log"), /\/engineering-mode\n\nThe plan below is approved/);
    assert.ok(typesOf(result).includes("plan_approved"));
    assert.equal(result.exitCode, 0);
  });

  it("is measured by `autopilot report` from its own journal", async () => {
    const result = await run({ workflow: "", sessions: TWO_ROW_SESSIONS });
    const { execFileSync } = await import("node:child_process");

    const text = execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", new URL("./cli.ts", import.meta.url).pathname, "report", "--repo", result.dir], { encoding: "utf8" });

    assert.match(text, /claude\s+done\s+2\s+2\s/);
  });
});

describe("a workflow at work", () => {
  it("answers the agent's question by rule, journals who answered, and the agent gets that answer", async () => {
    const result = await run({
      workflow: `on:
  needs_answer:
    - name: take-the-recommended
      do: { answer: recommended }
`,
      sessions: [
        { question: { header: "Color", question: "Which color?", options: ["blue", "red (Recommended)"] }, plan: "Ship R-1.", work: shipRow("R-1", null, "ship R-1") },
      ],
      files: { "docs/backlog.md": "| ID | State |\n| `R-1` | open ← next |\n" },
    });

    const asked = result.events.find((event) => event["type"] === "needs_answer");
    const received = result.events.find((event) => event["type"] === "answer_received");
    assert.equal(asked?.["handledBy"], "take-the-recommended");
    assert.deepEqual(received?.["answer"], ["red (Recommended)"]);
    assert.equal(received?.["why"], "workflow take-the-recommended");
    assert.deepEqual(JSON.parse((await result.state("answers.log")).trim()), { question_0: "red (Recommended)" });
    assert.equal(result.exitCode, 0);
  });

  it("replies by rule when the agent stops to wait, and the agent carries on from that reply", async () => {
    const result = await run({
      workflow: `on:
  needs_reply:
    - name: dont-end-the-turn-to-wait
      when: { why: no_commit, lastMessage: { matches: "[Ww]ait" } }
      do: { reply: "Continue the task. Do not end your turn to wait." }
`,
      sessions: [{ plan: "Ship R-1.", silentFirstTurn: "I will wait for the host to calm down.", work: shipRow("R-1", null, "ship R-1") }],
      files: { "docs/backlog.md": "| ID | State |\n| `R-1` | open ← next |\n" },
    });

    const asked = result.events.find((event) => event["type"] === "needs_reply");
    assert.equal(asked?.["why"], "no_commit");
    assert.equal(asked?.["handledBy"], "dont-end-the-turn-to-wait");
    assert.match(await result.state("prompts-1.log"), /Continue the task\. Do not end your turn to wait\./);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });

  it("runs a command on the last event before the loop exits, with the event in its environment", async () => {
    const note = `sh -c 'echo "$AUTOPILOT_EVENT_TYPE" >> "$AUTOPILOT_RUN_DIR/notes.txt"'`;
    const result = await run({
      workflow: `on:
  iteration_done:
    - do: { run: "${note.replaceAll('"', '\\"')}" }
  backlog_exhausted:
    - do: { run: "${note.replaceAll('"', '\\"')}" }
`,
      sessions: TWO_ROW_SESSIONS,
    });

    const notes = (await result.read(".run/notes.txt")).trim().split("\n").sort();
    assert.deepEqual(notes, ["backlog_exhausted", "iteration_done", "iteration_done"]);
    assert.equal(typesOf(result).filter((type) => type === "workflow_applied").length, 3);
  });
});

describe("a workflow edited while the loop runs", () => {
  it("is read again at the next iteration, so new rules reach the next session with no restart", async () => {
    const addRule = `sed -i 's/OLD-RULE-TEXT/NEW-RULE-TEXT/' autopilot.yaml; ${shipRow("R-1", "R-2", "ship R-1")}`;
    const result = await run({
      workflow: 'rules: ["OLD-RULE-TEXT"]\n',
      sessions: [{ plan: "Ship R-1.", work: addRule }, { plan: "Ship R-2.", work: shipRow("R-2", null, "ship R-2") }],
    });

    assert.match(await result.state("prompts-1.log"), /OLD-RULE-TEXT/);
    assert.doesNotMatch(await result.state("prompts-1.log"), /NEW-RULE-TEXT/);
    assert.match(await result.state("prompts-2.log"), /NEW-RULE-TEXT/);
  });

  it("keeps the previous workflow when the new one does not read, and journals why", async () => {
    const breakIt = `printf 'on:\\n  iteration_dnoe:\\n    - do: { stop: true }\\n' >> autopilot.yaml; ${shipRow("R-1", "R-2", "ship R-1")}`;
    const result = await run({
      workflow: 'rules: ["OLD-RULE-TEXT"]\n',
      sessions: [{ plan: "Ship R-1.", work: breakIt }, { plan: "Ship R-2.", work: shipRow("R-2", null, "ship R-2") }],
    });

    const invalid = result.events.find((event) => event["type"] === "workflow_invalid");
    assert.match(String(invalid?.["error"]), /on\.iteration_dnoe: expected an event name/);
    assert.match(await result.state("prompts-2.log"), /OLD-RULE-TEXT/);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["ship R-1", "ship R-2"]);
  });
});

describe("a usage limit", () => {
  it("ends the iteration by a handler's yield instead of waiting, and the next session finishes the row", async () => {
    const result = await run({
      workflow: `on:
  rate_limited:
    - name: fail-over
      do:
        - use: { harness: claude }
        - yield: "limited until {{wakeAt}}"
`,
      sessions: [{ plan: "Ship R-1.", rateLimit: { resetsInSeconds: 3600 } }, { plan: "Ship R-1.", work: shipRow("R-1", null, "ship R-1") }],
      files: { "docs/backlog.md": "| ID | State |\n| `R-1` | open ← next |\n" },
      timeoutMs: 30_000,
    });

    const yielded = result.events.find((event) => event["type"] === "iteration_yielded");
    assert.match(String(yielded?.["reason"]), /^limited until 20\d\d-/);
    assert.deepEqual(typesOf(result).filter((type) => type.startsWith("iteration_") && type !== "iteration_started"), ["iteration_yielded", "iteration_done"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});

describe("a repository whose work is not a markdown table", () => {
  it("takes its next row from a command, and runs without a docs/backlog.md at all", async () => {
    const take = (name: string) => `mkdir -p done; git mv todo/${name} done/${name}; git -c user.email=t@t -c user.name=t commit -q -m "do ${name}"`;
    const result = await run({
      workflow: 'backlog: { source: command, command: "ls todo | head -1" }\n',
      sessions: [{ plan: "Do a.", work: take("a.task") }, { plan: "Do b.", work: take("b.task") }],
      files: { "todo/a.task": "a\n", "todo/b.task": "b\n", "docs/backlog.md": null },
    });

    assert.deepEqual(rowsOf(result), ["a.task", "b.task"]);
    assert.deepEqual(result.commits, ["do a.task", "do b.task"]);
    assert.equal(typesOf(result).at(-1), "backlog_exhausted");
    assert.equal(result.exitCode, 0);
  });
});

describe("harness, model, effort and command from the workflow and the flags", () => {
  const ONE_ROW = { "docs/backlog.md": "| ID | State |\n| `R-1` | open ← next |\n" };
  const SHIP = [{ plan: "Ship R-1.", work: shipRow("R-1", null, "ship R-1") }];

  it("starts the executable the workflow names for its harness, with no flag at all", async () => {
    const result = await run({
      workflow: `harness: claude\nharnesses:\n  claude: { command: ${FAKE_AGENT} }\n`,
      sessions: SHIP,
      files: ONE_ROW,
      omitAgentCommand: true,
    });

    assert.equal(result.events.find((event) => event["type"] === "loop_started")?.["agent"], "claude");
    assert.deepEqual(result.commits, ["ship R-1"]);
    assert.equal(result.exitCode, 0);
  });

  it("lets a flag override the workflow's harness, and writes only what the flag said to the override file", async () => {
    const result = await run({
      workflow: "harness: devin\nharnesses:\n  devin: { model: swe-2-high }\n",
      sessions: SHIP,
      files: ONE_ROW,
      args: ["--harness", "claude"],
    });

    const started = result.events.find((event) => event["type"] === "loop_started");
    assert.equal(started?.["agent"], "claude");
    assert.equal(started?.["model"], null, "devin's model does not follow the loop to claude");
    assert.deepEqual(JSON.parse(await result.read(".run/choice.json")), { agent: "claude", model: null, effort: null });
    assert.deepEqual(result.commits, ["ship R-1"]);
  });

  it("keeps an override file over the workflow, field by field, until the override is reset", async () => {
    const result = await run({
      workflow: "harness: devin\nharnesses:\n  devin: { model: swe-2-high }\n",
      sessions: SHIP,
      files: { ...ONE_ROW, ".run/choice.json": JSON.stringify({ agent: "claude", model: null, effort: null }) },
    });

    const started = result.events.find((event) => event["type"] === "loop_started");
    assert.equal(started?.["agent"], "claude", "the override names the harness, the workflow's devin does not apply");
    assert.equal(result.exitCode, 0);
  });
});
