import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runLoop, shipRow, typesOf, type LoopCase, type LoopResult } from "./testing/loop-harness.ts";

/**
 * The workflow options a repository can set, each run through the real CLI against the scripted agent, so a
 * file that reads is also a file that works. None of it costs credits.
 */
const results: LoopResult[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const result of results.splice(0)) await result.cleanup();
});

async function run(spec: LoopCase): Promise<LoopResult> {
  const result = await runLoop(spec);
  results.push(result);
  return result;
}

const ONE_ROW = { "docs/backlog.md": "| ID | State |\n| `R-1` | open ← next |\n" };
const SHIP_R1 = shipRow("R-1", null, "ship R-1");
const TWO_SESSIONS = [
  { plan: "Ship R-1.", work: shipRow("R-1", "R-2", "ship R-1") },
  { plan: "Ship R-2.", work: shipRow("R-2", null, "ship R-2") },
];

/** A process the workflow's preflight rules are about, started in the repository and ended by the test. */
function startIn(cwd: string, command: string, ...args: string[]): ChildProcess {
  const child = spawn(command, args, { cwd, stdio: "ignore" });
  children.push(child);
  return child;
}

describe("names a repository chooses", () => {
  it("reads its own prompt file, backlog file, marker and run directory, and states the rules in order", async () => {
    const result = await run({
      workflow: `prompt: TASK.md
backlog: { file: TODO.md, marker: NEXT }
rules:
  - First rule.
  - Second rule.
`,
      runDir: "ops/state/.run",
      files: {
        "docs/backlog.md": null,
        "TODO.md": "| ID | State |\n| `R-1` | open NEXT |\n",
        "TASK.md": "# A task of its own\n",
      },
      sessions: [{ plan: "Ship R-1.", work: "sed -i 's/open NEXT/shipped/' TODO.md; git add -A; git -c user.email=t@t -c user.name=t commit -q -m 'ship R-1'" }],
    });

    const prompt = await result.state("prompts-1.log");
    assert.match(prompt, /# A task of its own/);
    assert.match(prompt, /Follow TASK\.md \(attached\)\./);
    assert.ok(prompt.indexOf("First rule.") < prompt.indexOf("Second rule."));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["ship R-1"]);
    assert.equal(typesOf(result).at(-1), "backlog_exhausted");
  });
});

describe("a workflow file kept outside the repository", () => {
  it("runs the loop with a clean tree, keeps its journal in the repository, and is found by the operator commands", async () => {
    const result = await run({
      workflow: "rules: [Outside rule.]\n",
      workflowOutside: true,
      sessions: [{ plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      during: async (live) => {
        await live.waitForEvent("iteration_started");
        assert.doesNotMatch(await live.cli("status"), /never_started|never started/);
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(await result.state("prompts-1.log"), /Outside rule\./);
    assert.match(await result.read(".run/events.jsonl"), /iteration_done/);
    await assert.rejects(() => result.read("autopilot.yaml"), /ENOENT/);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});

describe("a workflow that does not read", () => {
  it("refuses an unknown key before any session, naming the key", async () => {
    const result = await run({ workflow: "backlg: {}\n", sessions: [], files: ONE_ROW });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unknown key "backlg"/);
    assert.deepEqual(typesOf(result), []);
  });

  it("refuses a file with no schema version, and one from a newer schema, each saying what to do", async () => {
    const missing = await run({ workflow: "", sessions: [], files: { ...ONE_ROW, "autopilot.yaml": "run_dir: .run\n" } });
    const newer = await run({ workflow: "", sessions: [], files: { ...ONE_ROW, "autopilot.yaml": "version: 2\n" } });

    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /add "version: 1" as the first key/);
    assert.equal(newer.exitCode, 1);
    assert.match(newer.stderr, /newer than the schema this autopilot reads \(1\); upgrade autopilot/);
  });
});

describe("handlers", () => {
  it("applies the first handler whose condition holds, chooses an option by pattern, and runs a command after the answer", async () => {
    const result = await run({
      workflow: `on:
  needs_answer:
    - name: only-shapes
      when: { questions.header: Shape }
      do: { answer: first }
    - name: pick-by-pattern
      do:
        - answer: { choose: "^be" }
        - run: ["sh", "-c", 'echo "$AUTOPILOT_EVENT_TYPE" >> "$AUTOPILOT_RUN_DIR/after-answer.txt"']
`,
      sessions: [{ question: { header: "Color", question: "Which?", options: ["alpha", "beta"] }, plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
    });

    const asked = result.events.find((event) => event["type"] === "needs_answer");
    assert.equal(asked?.["handledBy"], "pick-by-pattern");
    assert.deepEqual(result.events.find((event) => event["type"] === "answer_received")?.["answer"], ["beta"]);
    assert.match(await result.read(".run/after-answer.txt"), /needs_answer/);
  });

  it("replies when the reason is one of a list", async () => {
    const result = await run({
      workflow: `on:
  needs_reply:
    - when: { why: { in: [dirty_tree, no_commit] } }
      do: { reply: "Finish the row." }
`,
      sessions: [{ plan: "Ship R-1.", silentFirstTurn: "Done thinking.", work: SHIP_R1 }],
      files: ONE_ROW,
    });

    assert.match(await result.state("prompts-1.log"), /Finish the row\./);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });

  it("stops after the iteration a handler stops on, leaving the next row for a later run", async () => {
    const result = await run({ workflow: "on:\n  iteration_done:\n    - do: { stop: true }\n", sessions: TWO_SESSIONS });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["ship R-1"]);
    assert.equal(typesOf(result).at(-1), "stop");
  });

  it("fills an event's field into the arguments of a command that runs without a shell", async () => {
    const result = await run({
      workflow: `on:
  iteration_done:
    - do: { run: ["sh", "-c", 'echo "$0" >> "$AUTOPILOT_RUN_DIR/heads.txt"', "{{head}}"] }
`,
      sessions: TWO_SESSIONS,
    });

    const heads = (await result.read(".run/heads.txt")).trim().split("\n");
    const done = result.events.filter((event) => event["type"] === "iteration_done").map((event) => event["head"]);
    assert.deepEqual(heads, done);
    assert.equal(heads.length, 2);
  });
});

describe("an orchestrator woken by `autopilot watch`", () => {
  it("is woken by the question with its id, and the answer it gives reaches the agent", async () => {
    const result = await run({
      workflow: "",
      sessions: [{ question: { header: "Color", question: "Which?", options: ["blue", "red"] }, plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      during: async (live) => {
        const line = JSON.parse(await live.firstWatchLine()) as Record<string, unknown>;
        assert.equal(line["type"], "needs_answer");
        await live.cli("answer", String(line["id"]), "red");
      },
    });

    assert.deepEqual(JSON.parse((await result.state("answers.log")).trim()), { question_0: "red" });
  });
});

describe("a backlog command", () => {
  it("takes an argument list, which runs without a shell, and ends the loop when it prints nothing", async () => {
    const take = (name: string) => `mkdir -p done; git mv todo/${name} done/${name}; git -c user.email=t@t -c user.name=t commit -q -m "do ${name}"`;
    const result = await run({
      workflow: 'backlog: { source: command, command: [sh, -c, "ls todo | head -1"], timeout_seconds: 10 }\n',
      sessions: [{ plan: "a", work: take("a.task") }, { plan: "b", work: take("b.task") }],
      files: { "todo/a.task": "a\n", "todo/b.task": "b\n", "docs/backlog.md": null },
    });

    assert.deepEqual(result.commits, ["do a.task", "do b.task"]);
    assert.equal(typesOf(result).at(-1), "backlog_exhausted");
  });
});

/**
 * The loop re-checks a held start once a minute, so each of these takes about a minute; they run side by
 * side so the file takes one.
 */
describe("a start held back and then released", { concurrency: true }, () => {
  it("waits while the backlog command fails, says why, and goes on once it answers", async () => {
    const result = await run({
      workflow: 'backlog: { source: command, command: "test -f .run/ready && ls todo | head -1" }\n',
      sessions: [{ plan: "a", work: "mkdir -p done; git mv todo/a.task done/a.task; git -c user.email=t@t -c user.name=t commit -q -m 'do a'" }],
      files: { "todo/a.task": "a\n", "docs/backlog.md": null },
      timeoutMs: 120_000,
      during: async (live) => {
        const waiting = await live.waitForEvent("preflight_wait");
        assert.match(String(waiting["reason"]), /the backlog could not be read/);
        await writeFile(join(live.dir, ".run", "ready"), "");
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["do a"]);
    const types = typesOf(result);
    assert.ok(types.indexOf("preflight_wait") < types.indexOf("iteration_started"));
  });

  it("waits while a process a leftover rule names runs in the repository, and goes on when it ends", async () => {
    let leftover: ChildProcess | null = null;
    const result = await run({
      workflow: "",
      preflight: "leftover: [{ match: 'sleep 4242' }]",
      sessions: [{ plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      timeoutMs: 120_000,
      beforeStart: async (dir) => void (leftover = startIn(dir, "sleep", "4242")),
      during: async (live) => {
        await live.waitForEvent("preflight_wait");
        (leftover as ChildProcess | null)?.kill("SIGKILL");
      },
    });

    assert.equal(result.exitCode, 0);
    const types = typesOf(result);
    assert.ok(types.indexOf("preflight_wait") < types.indexOf("iteration_started"));
    assert.deepEqual(result.commits, ["ship R-1"]);
  });

  it("waits while a program a wrapper rule names runs, including the script a shell runs, and goes on when it ends", async () => {
    let wrapper: ChildProcess | null = null;
    const result = await run({
      workflow: "",
      preflight: "wrappers: [{ program: jobq, hint: 'end it with {{pid}}' }]",
      sessions: [{ plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      timeoutMs: 120_000,
      beforeStart: async (dir, stateDir) => {
        const script = join(stateDir, "jobq");
        // No `exec`: like a real job queue, the script stays running around the work it starts.
        await writeFile(script, "#!/bin/sh\nsleep 90\n");
        await chmod(script, 0o755);
        wrapper = startIn(dir, "/bin/sh", script);
      },
      during: async (live) => {
        const waiting = await live.waitForEvent("preflight_wait");
        // The hint exists only when the wrapper rule matched; the command line in the reason is cut at 60 characters.
        assert.match(String(waiting["reason"]), /\(end it with \d+\)/);
        (wrapper as ChildProcess | null)?.kill("SIGKILL");
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});

describe("a process that no rule holds the loop for", () => {
  it("does not hold it when it matches no rule, or matches one but runs outside the repository", async () => {
    const result = await run({
      workflow: "",
      preflight: "leftover: [{ match: 'sleep 424[24]' }]",
      sessions: [{ plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      beforeStart: async (dir) => {
        startIn(dir, "sleep", "4245");
        startIn(tmpdir(), "sleep", "4242");
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(typesOf(result).includes("preflight_wait"), false);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});
