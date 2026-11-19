import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runLoop, shipRow, typesOf, type LoopCase, type LoopResult } from "./testing/loop-harness.ts";

/**
 * What an operator or an orchestrating agent does to a loop that is running, and what happens to a loop
 * that dies or meets another: the real CLI against the scripted agent, so none of it costs credits.
 */
const results: LoopResult[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const result of results.splice(0)) await result.cleanup();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function run(spec: LoopCase): Promise<LoopResult> {
  const result = await runLoop(spec);
  results.push(result);
  return result;
}

const ONE_ROW = { "docs/backlog.md": "| ID | State |\n| `R-1` | open ← next |\n" };
const SHIP_R1 = shipRow("R-1", null, "ship R-1");
const APPROVES_PLAN = "plan: { follow_up: /go }\n";

describe("an orchestrator answering through the CLI", () => {
  it("answers the agent's question with `autopilot answer`, and the answer is journaled with its reason", async () => {
    const result = await run({
      workflow: "",
      sessions: [{ question: { header: "Color", question: "Which color?", options: ["blue", "red"] }, plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      during: async (live) => {
        const asked = await live.waitForEvent("needs_answer");
        await live.cli("answer", String(asked["id"]), "--why", "the brand is blue", "blue");
      },
    });

    const received = result.events.find((event) => event["type"] === "answer_received");
    assert.deepEqual(received?.["answer"], ["blue"]);
    assert.equal(received?.["why"], "the brand is blue");
    assert.deepEqual(JSON.parse((await result.state("answers.log")).trim()), { question_0: "blue" });
    assert.equal(result.exitCode, 0);
  });

  it("replies to a stop the loop cannot read as done with `autopilot reply`, and the agent carries on from it", async () => {
    const result = await run({
      workflow: "",
      sessions: [{ plan: "Ship R-1.", silentFirstTurn: "I will wait.", work: SHIP_R1 }],
      files: ONE_ROW,
      during: async (live) => {
        const asked = await live.waitForEvent("needs_reply");
        await live.cli("reply", String(asked["id"]), "Do not wait; finish the row.");
      },
    });

    assert.match(await result.state("prompts-1.log"), /Do not wait; finish the row\./);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});

describe("answers that no ask waits on", () => {
  const QUESTION = { header: "Color", question: "Which color?", options: ["blue", "red"] };

  it("are refused by the CLI while the real question still gets its answer", async () => {
    const refusals: string[] = [];
    const result = await run({
      workflow: "",
      sessions: [{ question: QUESTION, plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      during: async (live) => {
        const asked = await live.waitForEvent("needs_answer");
        const id = String(asked["id"]);
        for (const attempt of [["answer", "q99", "blue"], ["reply", id, "blue"], ["answer", id, "blue", "red"]]) {
          await live.cli(...attempt).then(() => refusals.push("accepted"), (error: Error) => refusals.push(error.message));
        }
        await live.cli("answer", id, "blue");
      },
    });

    assert.match(refusals[0] ?? "", /"q99" is not waiting for an answer; waiting: q1 \(question\)/);
    assert.match(refusals[1] ?? "", /q1 is a question: use `autopilot answer q1`/);
    assert.match(refusals[2] ?? "", /q1 asks 1 question and takes one label for each, got 2/);
    assert.deepEqual(result.events.find((event) => event["type"] === "answer_received")?.["answer"], ["blue"]);
    assert.equal(result.exitCode, 0);
  });

  it("cannot be taken by a later question, because a new loop process numbers its asks after the journal's", async () => {
    const earlier = ["q1", "q2", "q3"].map((id) => JSON.stringify({ at: "2026-11-17T10:00:00Z", type: "needs_answer", id, questions: [] }));
    const result = await run({
      workflow: "",
      sessions: [{ question: QUESTION, plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      beforeStart: async (dir) => {
        await mkdir(join(dir, ".run/answers"), { recursive: true });
        await writeFile(join(dir, ".run/events.jsonl"), `${earlier.join("\n")}\n`);
        // What a mistyped or late `answer q1` used to leave behind, waiting for the next process's first question.
        await writeFile(join(dir, ".run/answers/q1.json"), JSON.stringify({ answer: ["red"] }));
      },
      during: async (live) => {
        const asked = await newestAsk(live.dir, 4);
        await live.cli("answer", asked, "blue");
      },
    });

    const asks = result.events.filter((event) => event["type"] === "needs_answer").map((event) => event["id"]);
    assert.deepEqual(asks, ["q1", "q2", "q3", "q4"]);
    assert.deepEqual(result.events.find((event) => event["type"] === "answer_received")?.["answer"], ["blue"]);
    assert.equal(result.exitCode, 0);
  });
});

/** Waits until the journal holds the ask numbered `number`, and returns its id. */
async function newestAsk(dir: string, number: number): Promise<string> {
  const wanted = `q${number}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const text = await readFile(join(dir, ".run/events.jsonl"), "utf8").catch(() => "");
    if (text.includes(`"id":"${wanted}"`)) return wanted;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the loop never asked ${wanted}`);
}

describe("a loop that dies mid-session", () => {
  it("is restarted into the unfinished row, which the journal says was interrupted, and the row ships", async () => {
    let second: { code: number | null; stderr: string } = { code: null, stderr: "" };
    const result = await run({
      workflow: APPROVES_PLAN,
      sessions: [{ plan: "Ship R-1.", hold: true }, { plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      during: async (live) => {
        await live.waitForEvent("plan_approved");
        await live.kill("SIGKILL");
        second = await live.startAnother();
      },
    });

    assert.equal(second.code, 0, second.stderr);
    const types = typesOf(result);
    assert.ok(types.indexOf("iteration_interrupted") > types.indexOf("iteration_started"));
    assert.equal(types.filter((type) => type === "iteration_started").length, 2);
    assert.equal(types.at(-1), "backlog_exhausted");
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});

describe("a second loop in the same repository", () => {
  it("is refused with the pid that holds the directory, exiting 1 so a service unit does not restart into it, and the first loop is not disturbed", async () => {
    let second: { code: number | null; stderr: string } = { code: null, stderr: "" };
    const result = await run({
      workflow: APPROVES_PLAN,
      sessions: [{ plan: "Ship R-1.", hold: true }],
      files: ONE_ROW,
      during: async (live) => {
        await live.waitForEvent("plan_approved");
        second = await live.startAnother();
        await live.kill("SIGKILL");
      },
    });

    assert.equal(second.code, 1);
    assert.match(second.stderr, /autopilot already runs here as pid \d+/);
    assert.equal(typesOf(result).filter((type) => type === "iteration_started").length, 1);
  });
});

describe("`autopilot stop`", () => {
  it("lets the iteration in progress finish, then exits 0 without starting the next row", async () => {
    const result = await run({
      workflow: "",
      sessions: [{ plan: "Ship R-1.", work: `sleep 2; ${shipRow("R-1", "R-2", "ship R-1")}` }, { plan: "Ship R-2.", work: shipRow("R-2", null, "ship R-2") }],
      during: async (live) => {
        await live.waitForEvent("iteration_started");
        await live.cli("stop");
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.commits, ["ship R-1"]);
    assert.equal(typesOf(result).at(-1), "stop");
  });
});

describe("a model the agent does not offer", () => {
  it("halts the loop before any work, naming the model, so a typo in `autopilot use` costs no session", async () => {
    const result = await run({
      workflow: "harnesses:\n  claude: { model: no-such-model }\n",
      sessions: [{ plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
    });

    const halted = result.events.find((event) => event["type"] === "iteration_halted");
    assert.match(String(halted?.["reason"]), /--model "no-such-model" cannot be applied: the agent reports no model option/);
    assert.equal(typesOf(result).at(-1), "loop_halted");
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.commits, []);
  });
});

describe("restarting a loop with the flags it was started with", () => {
  it("keeps the model an operator chose with `autopilot use`, because a flag overrides only the field it names", async () => {
    const result = await run({
      workflow: "",
      args: ["--harness", "claude"],
      sessions: [{ plan: "Ship R-1.", work: SHIP_R1 }],
      files: ONE_ROW,
      beforeStart: async (dir) => {
        await mkdir(join(dir, ".run"), { recursive: true });
        await writeFile(join(dir, ".run/choice.json"), JSON.stringify({ agent: "claude", model: "chosen-with-use", effort: null }));
      },
    });

    // The scripted agent offers no models, so the session is refused; what matters is what the loop resolved to start with.
    const started = result.events.find((event) => event["type"] === "loop_started");
    assert.equal(started?.["model"], "chosen-with-use");
    assert.deepEqual(JSON.parse(await result.read(".run/choice.json")), { agent: "claude", model: "chosen-with-use", effort: null });
  });
});

describe("a weekly usage limit", () => {
  // The same session carries on after the wait, so the work it does then is the one that ships the row.
  const limited = (): LoopCase["sessions"] => [{ plan: "Ship R-1.", rateLimit: { resetsInSeconds: 5, type: "seven_day" }, work: SHIP_R1 }];

  it("halts the loop with exit 1 when nothing can say the account is usable again, so a service does not restart into it", async () => {
    const result = await run({ workflow: "", sessions: limited(), files: ONE_ROW });

    assert.equal(result.exitCode, 1);
    const halted = result.events.find((event) => event["type"] === "loop_halted");
    assert.match(String(halted?.["reason"]), /weekly_limit/);
    assert.deepEqual(result.commits, []);
  });

  // The loop waits 60 s past the reset time the agent reports and probes every 60 s, so the first probe is
  // at 60 s, before that wake time: the case where the probe ends a wait early. This test takes about a minute.
  it("waits instead when the workflow names the `cam` probe, asks the real command, wakes early on its answer and finishes the row", async () => {
    const bin = await mkdtemp(join(tmpdir(), "fake-cam-"));
    scratch.push(bin);
    const cam = join(bin, "cam");
    const usable = '{"active":{"usageStatus":"ok","usage":{"fiveHour":{"pct":10},"sevenDay":{"pct":20},"scoped":[]}}}';
    await writeFile(cam, `#!/bin/sh\necho "$@" >> "${bin}/calls.txt"\necho '${usable}'\n`);
    await chmod(cam, 0o755);

    const result = await run({
      workflow: "limits: { probe: cam }\n",
      sessions: limited(),
      files: ONE_ROW,
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      timeoutMs: 120_000,
    });

    assert.equal(result.exitCode, 0);
    assert.match(await readFile(join(bin, "calls.txt"), "utf8"), /^status --json$/m);
    assert.equal(result.events.find((event) => event["type"] === "limit_cleared")?.["early"], true);
    assert.deepEqual(result.commits, ["ship R-1"]);
  });
});
