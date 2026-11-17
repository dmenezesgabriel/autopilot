import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoopEvent } from "./mailbox.ts";
import { buildReport, formatReport } from "./report.ts";
import { iterationsOf, limitWaitsOf, restartsOf } from "./report-iterations.ts";
import type { TranscriptStats } from "./transcript-stats.ts";

const T0 = Date.parse("2026-11-16T10:00:00Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const ev = (minutes: number, type: string, detail: Record<string, unknown> = {}): LoopEvent => ({
  at: at(minutes),
  type,
  ...detail,
});

const JOURNAL: LoopEvent[] = [
  ev(0, "loop_started"),
  ev(1, "iteration_started", { row: "R-1", head: "aaa" }),
  ev(2, "session_started", { sessionId: "s1", agent: "claude" }),
  ev(40, "iteration_done", { head: "bbb" }),
  ev(40, "iteration_started", { row: "R-2", head: "bbb" }),
  ev(41, "session_started", { sessionId: "s2", agent: "devin" }),
  ev(90, "background_started"),
  ev(300, "loop_started"),
  ev(300, "iteration_interrupted", { sessionId: "s2" }),
  ev(301, "iteration_started", { row: "R-2", head: "ccc" }),
];

const transcript = (sessionId: string, extra: Partial<TranscriptStats>): TranscriptStats => ({
  file: `acp-${sessionId}.jsonl`,
  sessionId,
  agent: null,
  costUsd: null,
  llmCalls: 0,
  compactions: 0,
  firstFrameMs: null,
  lastFrameMs: null,
  ...extra,
});

describe("iterationsOf", () => {
  it("ends a done iteration's commit range at the head the loop recorded, not at the next start", () => {
    const [first] = iterationsOf(JOURNAL, "zzz");

    assert.equal(first?.outcome, "done");
    assert.equal(first?.headStart, "aaa");
    assert.equal(first?.headEnd, "bbb");
    assert.equal(first?.sessionId, "s1");
    assert.equal(first?.agent, "claude");
  });

  it("ends an iteration that never finished where the next one began, and the last one at the current head", () => {
    const rows = iterationsOf(JOURNAL, "zzz");

    assert.equal(rows[1]?.outcome, "interrupted");
    assert.equal(rows[1]?.headEnd, "ccc");
    assert.equal(rows[2]?.outcome, "open");
    assert.equal(rows[2]?.headEnd, "zzz");
  });

  it("gives an interrupted iteration its last event as a lower bound on its end", () => {
    const rows = iterationsOf(JOURNAL, "zzz");

    assert.equal(rows[1]?.endMs, T0 + 300 * 60_000);
  });
});

describe("restartsOf", () => {
  it("tells a restart after a deliberate stop from one after the loop died", () => {
    const events = [ev(0, "loop_started"), ev(10, "stop"), ev(20, "loop_started"), ev(90, "turn_ended"), ev(150, "loop_started")];

    const restarts = restartsOf(events);

    assert.deepEqual(restarts.map((restart) => restart.after), ["stop", "died"]);
    assert.equal(restarts[1]?.silentMs, 60 * 60_000);
  });
});

describe("limitWaitsOf", () => {
  it("measures a wait the probe ended early against the one planned", () => {
    const events = [
      ev(0, "rate_limited", { wakeAt: at(180) }),
      ev(25, "limit_cleared", { early: true }),
      ev(30, "rate_limited", { wakeAt: at(40) }),
      ev(40, "iteration_started"),
    ];

    const [early, full] = limitWaitsOf(events);

    assert.deepEqual([early?.plannedMs, early?.actualMs, early?.early], [180 * 60_000, 25 * 60_000, true]);
    assert.deepEqual([full?.plannedMs, full?.actualMs, full?.early], [10 * 60_000, 10 * 60_000, false]);
  });
});

describe("buildReport", () => {
  it("joins each iteration to its transcript by session id and to its commits by head range", async () => {
    const counted: string[] = [];
    const report = await buildReport({
      events: JOURNAL,
      headNow: "zzz",
      commitsBetween: async (from, to) => {
        counted.push(`${from}..${to}`);
        return from === "aaa" ? 3 : 0;
      },
      transcripts: new Map([
        ["s1", transcript("s1", { costUsd: 1.5 })],
        ["s2", transcript("s2", { llmCalls: 200, compactions: 9 })],
      ]),
    });

    assert.deepEqual(counted, ["aaa..bbb", "bbb..ccc", "ccc..zzz"]);
    assert.deepEqual(report.rows.map((row) => [row.commits, row.costUsd, row.llmCalls, row.compactions]), [
      [3, 1.5, 0, 0],
      [0, null, 200, 9],
      [0, null, 0, 0],
    ]);
  });

  it("prints per-agent figures, the unplanned restarts and the limit waits", async () => {
    const report = await buildReport({
      events: JOURNAL,
      headNow: "zzz",
      commitsBetween: async (from) => (from === "aaa" ? 3 : 0),
      transcripts: new Map([["s1", transcript("s1", { costUsd: 1.5 })]]),
    });

    const text = formatReport(report);

    assert.match(text, /claude\s+done\s+1\s+3\s+0\.7\s+13\.0\s+1\.50/);
    assert.match(text, /restarts not preceded by a deliberate stop: 1 of 1/);
    assert.match(text, /limit waits: 0/);
  });
});
