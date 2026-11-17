import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readTranscript, readTranscripts } from "./transcript-stats.ts";

const frame = (at: number, message: unknown): string =>
  JSON.stringify({ at, dir: "in", line: JSON.stringify(message) });

const usage = (update: Record<string, unknown>): unknown => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { update: { sessionUpdate: "usage_update", used: 10, size: 100, ...update } },
});

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcript-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readTranscript", () => {
  it("takes the session id from the answer to session/new and the last Claude cost as the session's", async () => {
    const path = join(dir, "acp-a.jsonl");
    await writeFile(path, [
      frame(1000, { jsonrpc: "2.0", id: 2, method: "session/new", params: {} }),
      frame(1100, { jsonrpc: "2.0", id: 2, result: { sessionId: "sess-1" } }),
      frame(2000, usage({ cost: { amount: 0.5, currency: "USD" } })),
      frame(3000, usage({ cost: { amount: 1.25, currency: "USD" } })),
    ].join("\n"));

    const stats = await readTranscript(path, "acp-a.jsonl");

    assert.equal(stats.sessionId, "sess-1");
    assert.equal(stats.costUsd, 1.25);
    assert.equal(stats.llmCalls, 0);
    assert.deepEqual([stats.firstFrameMs, stats.lastFrameMs], [1000, 3000]);
  });

  it("counts a Devin call once although its usage frame arrives twice, and each finished compaction", async () => {
    const path = join(dir, "acp-b.jsonl");
    const call = { _meta: { "cognition.ai/inputTokens": 500 } };
    await writeFile(path, [
      frame(1000, usage(call)),
      frame(1000, usage({ ...call, _meta: { ...call._meta, "cognition.ai/subagent_context": {} } })),
      frame(2000, usage({ ...call, used: 11 })),
      frame(3000, { method: "_cognition.ai/compaction", params: { status: "started" } }),
      frame(3100, { method: "_cognition.ai/compaction", params: { status: "completed" } }),
      "not json at all",
    ].join("\n"));

    const stats = await readTranscript(path, "acp-b.jsonl");

    assert.equal(stats.llmCalls, 2);
    assert.equal(stats.compactions, 1);
    assert.equal(stats.costUsd, null);
  });
});

describe("readTranscripts", () => {
  it("indexes a directory's transcripts by session id and skips other files", async () => {
    await writeFile(join(dir, "acp-1.jsonl"), [
      frame(1, { id: 1, method: "session/new" }),
      frame(2, { id: 1, result: { sessionId: "x" } }),
    ].join("\n"));
    await writeFile(join(dir, "events.jsonl"), "{}");

    const bySession = await readTranscripts(dir);

    assert.deepEqual([...bySession.keys()], ["x"]);
  });
});
