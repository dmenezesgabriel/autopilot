import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { nextWantedLine } from "./wait.ts";
import { waitCommand } from "./workflow-commands.ts";

const isWake = (line: string): boolean => line.startsWith("WAKE");
const quick = { timeoutMs: 400, pollMs: 10 };

describe("nextWantedLine: the first line an orchestrator must act on, from a byte offset", () => {
  let dir = "";
  let path = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wait-"));
    path = join(dir, "events.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips lines nobody must act on and returns the first wanted one with the offset just after it", async () => {
    await writeFile(path, "noise\nWAKE one\nnoise\nWAKE two\n");

    const found = await nextWantedLine(path, 0, isWake, quick);

    assert.deepEqual(found, { line: "WAKE one", offset: "noise\nWAKE one\n".length });
  });

  it("returns the next wanted line on the next call, so events that piled up are delivered one by one and none is lost", async () => {
    await writeFile(path, "WAKE one\nnoise\nWAKE two\n");

    const first = await nextWantedLine(path, 0, isWake, quick);
    const second = await nextWantedLine(path, first.offset, isWake, quick);

    assert.equal(first.line, "WAKE one");
    assert.equal(second.line, "WAKE two");
  });

  it("returns a line appended while it waits, without waiting out the timeout", async () => {
    await writeFile(path, "noise\n");
    const started = Date.now();
    setTimeout(() => void appendFile(path, "WAKE late\n"), 60);

    const found = await nextWantedLine(path, "noise\n".length, isWake, { timeoutMs: 5000, pollMs: 10 });

    assert.equal(found.line, "WAKE late");
    assert.ok(Date.now() - started < 1500, "returned long after the event arrived");
  });

  it("returns no line at the timeout, with the offset moved past what it read, so the next call does not read it again", async () => {
    await writeFile(path, "noise\nmore noise\n");

    const found = await nextWantedLine(path, 0, isWake, quick);

    assert.deepEqual(found, { line: null, offset: "noise\nmore noise\n".length });
  });

  it("never moves past a half-written line, which may be the wanted event still being written", async () => {
    await writeFile(path, "noise\nWAKE par");

    const found = await nextWantedLine(path, 0, isWake, quick);
    assert.deepEqual(found, { line: null, offset: "noise\n".length });

    await appendFile(path, "tial\n");
    const next = await nextWantedLine(path, found.offset, isWake, quick);
    assert.equal(next.line, "WAKE partial");
  });

  it("counts bytes, not characters: nine two-byte characters before the events must not make the next call read the first event again", async () => {
    await writeFile(path, "ããããããããã\nWAKE 1\nWAKE 2\n");

    const first = await nextWantedLine(path, 0, isWake, quick);
    const second = await nextWantedLine(path, first.offset, isWake, quick);

    assert.equal(first.offset, Buffer.byteLength("ããããããããã\nWAKE 1\n"));
    assert.equal(second.line, "WAKE 2");
  });

  it("starts over from the top when the file is shorter than the offset: a fresh journal, not a lost one", async () => {
    await writeFile(path, "WAKE fresh\n");

    const found = await nextWantedLine(path, 9999, isWake, quick);

    assert.equal(found.line, "WAKE fresh");
  });

  it("stops at once when the signal aborts", async () => {
    await writeFile(path, "noise\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const found = await nextWantedLine(path, 0, isWake, { timeoutMs: 60_000, pollMs: 10, signal: controller.signal });

    assert.equal(found.line, null);
  });
});

describe("autopilot wait: one call per wake-up", () => {
  let repo = "";
  let journal = "";
  const event = (type: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ at: "2026-11-25T12:00:00.000Z", type, ...extra })}\n`;
  const runWait = async (...flags: string[]): Promise<{ code: number; lines: string[]; said: string[] }> => {
    const lines: string[] = [];
    const said: string[] = [];
    const code = await waitCommand(["--repo", repo, "--timeout", "0.3", ...flags], (line) => lines.push(line), (text) => said.push(text), new AbortController().signal);
    return { code, lines, said };
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "wait-cmd-"));
    await mkdir(join(repo, ".autopilot-run"));
    journal = join(repo, ".autopilot-run/events.jsonl");
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\n");
    await writeFile(journal, event("iteration_done") + event("needs_answer", { id: "q1", questions: [] }));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("the first call starts at the end of the journal, like `watch`: an old question is not news", async () => {
    const { code, lines, said } = await runWait();

    assert.equal(code, 124);
    assert.deepEqual(lines, []);
    assert.match(said.join("\n"), /no event that needs you in 0\.3 s; run `autopilot wait` again/);
  });

  it("an event that arrives between two calls is delivered by the next call, in order, then the cursor is spent", async () => {
    await runWait();
    await appendFile(journal, event("iteration_done") + event("loop_halted", { reason: "x" }) + event("needs_answer", { id: "q2", questions: [] }));

    const first = await runWait();
    const second = await runWait();
    const third = await runWait();

    assert.equal(first.code, 0);
    assert.match(first.lines[0] ?? "", /"type":"loop_halted"/);
    assert.match(second.lines[0] ?? "", /"id":"q2"/);
    assert.equal(third.code, 124);
  });

  it("keeps its cursor in the run directory, so another shell or a new orchestrator session carries on from it", async () => {
    await runWait();

    const cursor = await readFile(join(repo, ".autopilot-run/wait.cursor"), "utf8");

    assert.equal(Number(cursor), (await readFile(journal)).length);
  });

  it("does not wake for an event a workflow handler already answered", async () => {
    await runWait();
    await appendFile(journal, event("needs_answer", { id: "q9", questions: [], handledBy: "a-rule" }));

    const { code } = await runWait();

    assert.equal(code, 124);
  });

  it("refuses a timeout that is not a number of seconds, naming the value", async () => {
    await assert.rejects(() => waitCommand(["--repo", repo, "--timeout", "soon"], () => undefined, () => undefined, new AbortController().signal), /--timeout needs a number of seconds, got "soon"/);
  });
});
