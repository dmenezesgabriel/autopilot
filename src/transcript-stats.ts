import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** What one agent session's frame transcript (`acp-*.jsonl`) says about its cost, calls and context pressure. */
export type TranscriptStats = {
  file: string;
  sessionId: string | null;
  /** Which agent the usage frames come from, for journals that predate `agent` on `session_started`. */
  agent: "claude" | "devin" | null;
  /** Claude reports a running cost in USD on every usage frame; the last one is the session's. */
  costUsd: number | null;
  /** Devin reports tokens per model call and no cost; each call is one usage frame, sent twice. */
  llmCalls: number;
  compactions: number;
  firstFrameMs: number | null;
  lastFrameMs: number | null;
};

type Frame = { atMs: number; message: Record<string, unknown> };

function parseFrame(line: string): Frame | null {
  try {
    const outer = JSON.parse(line) as { at: number; line: string };
    return { atMs: outer.at, message: JSON.parse(outer.line) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function usageUpdate(message: Record<string, unknown>): Record<string, unknown> | null {
  if (message["method"] !== "session/update") return null;
  const params = message["params"] as { update?: Record<string, unknown> } | undefined;
  const update = params?.update;
  return update?.["sessionUpdate"] === "usage_update" ? update : null;
}

function costOf(update: Record<string, unknown>): number | null {
  const cost = update["cost"] as { amount?: unknown } | undefined;
  return typeof cost?.amount === "number" ? cost.amount : null;
}

/** Devin's usage frames carry the call's token counts under its own vendor key; Claude's carry a cost instead. */
function isDevinCall(update: Record<string, unknown>): boolean {
  const meta = update["_meta"] as Record<string, unknown> | undefined;
  return typeof meta?.["cognition.ai/inputTokens"] === "number";
}

function isCompactionDone(message: Record<string, unknown>): boolean {
  const method = message["method"];
  const params = message["params"] as { status?: unknown } | undefined;
  return typeof method === "string" && method.includes("compaction") && params?.status === "completed";
}

/** Folds one transcript. Frames are read as a stream: a long session is tens of megabytes. */
export async function readTranscript(path: string, file: string): Promise<TranscriptStats> {
  const stats: TranscriptStats = {
    file, sessionId: null, agent: null, costUsd: null, llmCalls: 0, compactions: 0, firstFrameMs: null, lastFrameMs: null,
  };
  const newSessionIds = new Set<unknown>();
  const seenCalls = new Set<string>();
  for await (const line of createInterface({ input: createReadStream(path) })) {
    const frame = parseFrame(line);
    if (frame === null) continue;
    stats.firstFrameMs ??= frame.atMs;
    stats.lastFrameMs = frame.atMs;
    foldFrame(stats, frame, newSessionIds, seenCalls);
  }
  return stats;
}

function foldFrame(
  stats: TranscriptStats,
  { atMs, message }: Frame,
  newSessionIds: Set<unknown>,
  seenCalls: Set<string>,
): void {
  if (message["method"] === "session/new") newSessionIds.add(message["id"]);
  const result = message["result"] as { sessionId?: unknown } | undefined;
  if (typeof result?.sessionId === "string" && newSessionIds.has(message["id"])) {
    stats.sessionId ??= result.sessionId;
  }
  if (isCompactionDone(message)) stats.compactions += 1;
  const update = usageUpdate(message);
  if (update === null) return;
  const cost = costOf(update);
  if (cost !== null) {
    stats.costUsd = cost;
    stats.agent = "claude";
  }
  const key = `${atMs}:${String(update["used"])}`;
  if (isDevinCall(update) && !seenCalls.has(key)) {
    seenCalls.add(key);
    stats.llmCalls += 1;
    stats.agent = "devin";
  }
}

/** Every transcript in a run directory, by the session id its own frames name. */
export async function readTranscripts(runDir: string): Promise<Map<string, TranscriptStats>> {
  const bySession = new Map<string, TranscriptStats>();
  const files = (await readdir(runDir)).filter((name) => /^acp-.*\.jsonl$/.test(name)).sort();
  for (const file of files) {
    const stats = await readTranscript(join(runDir, file), file);
    if (stats.sessionId !== null) bySession.set(stats.sessionId, stats);
  }
  return bySession;
}
