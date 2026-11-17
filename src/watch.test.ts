import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { followLines, shouldWake } from "./watch.ts";

describe("shouldWake", () => {
  const wake = ["needs_answer", "loop_halted"] as const;

  it("wakes for an event on the list", () => {
    assert.equal(shouldWake({ type: "needs_answer", id: "q1" }, wake), true);
  });

  it("does not wake for one off the list, such as a report the loop can make itself", () => {
    assert.equal(shouldWake({ type: "iteration_done" }, wake), false);
  });

  it("does not wake for a question a workflow handler already answered", () => {
    assert.equal(shouldWake({ type: "needs_answer", id: "q1", handledBy: "device-rule" }, wake), false);
  });
});

describe("followLines", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "follow-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const collect = async (path: string, fromStart: boolean, act: () => Promise<void>): Promise<string[]> => {
    const seen: string[] = [];
    const controller = new AbortController();
    const done = followLines(path, (line) => seen.push(line), { fromStart, pollMs: 10, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await act();
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await done;
    return seen;
  };

  it("reports only what is appended after it starts, by default", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, "old\n");

    const seen = await collect(path, false, () => appendFile(path, "new1\nnew2\n"));

    assert.deepEqual(seen, ["new1", "new2"]);
  });

  it("reads what is already there first when asked", async () => {
    const path = join(dir, "events.jsonl");
    await writeFile(path, "old\n");

    const seen = await collect(path, true, () => appendFile(path, "new\n"));

    assert.deepEqual(seen, ["old", "new"]);
  });

  it("holds a half-written line until it is finished, and waits for a file that does not exist yet", async () => {
    const path = join(dir, "later.jsonl");

    const seen = await collect(path, false, async () => {
      await writeFile(path, "par");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await appendFile(path, "tial\n");
    });

    assert.deepEqual(seen, ["partial"]);
  });
});
