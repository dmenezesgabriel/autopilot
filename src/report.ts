import type { LoopEvent } from "./mailbox.ts";
import {
  iterationsOf,
  limitWaitsOf,
  restartsOf,
  type IterationRecord,
  type LimitWait,
  type Restart,
} from "./report-iterations.ts";
import type { TranscriptStats } from "./transcript-stats.ts";

export type ReportInput = {
  events: LoopEvent[];
  headNow: string;
  commitsBetween(from: string, to: string): Promise<number>;
  transcripts: Map<string, TranscriptStats>;
};

export type ReportRow = IterationRecord & {
  commits: number;
  costUsd: number | null;
  llmCalls: number;
  compactions: number;
};

export type Report = { rows: ReportRow[]; restarts: Restart[]; limitWaits: LimitWait[] };

/**
 * Joins the journal to git and to the transcripts by exact keys: an iteration's session id names its
 * transcript, and the heads the journal recorded bound its commits. Nothing here is a time window.
 */
export async function buildReport(input: ReportInput): Promise<Report> {
  const records = iterationsOf(input.events, input.headNow);
  const rows = await Promise.all(records.map((record) => joinRow(record, input)));
  return { rows, restarts: restartsOf(input.events), limitWaits: limitWaitsOf(input.events) };
}

async function joinRow(record: IterationRecord, input: ReportInput): Promise<ReportRow> {
  const stats = record.sessionId === null ? undefined : input.transcripts.get(record.sessionId);
  const commits = record.headEnd === null ? 0 : await input.commitsBetween(record.headStart, record.headEnd);
  return {
    ...record,
    agent: record.agent ?? stats?.agent ?? null,
    commits,
    costUsd: stats?.costUsd ?? null,
    llmCalls: stats?.llmCalls ?? 0,
    compactions: stats?.compactions ?? 0,
  };
}

type Group = { agent: string; outcome: string; rows: ReportRow[] };

function groupsOf(rows: ReportRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const agent = row.agent ?? "unknown";
    const key = `${agent}/${row.outcome}`;
    const group = groups.get(key) ?? { agent, outcome: row.outcome, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => `${a.agent}${a.outcome}`.localeCompare(`${b.agent}${b.outcome}`));
}

const hours = (ms: number): number => ms / 3_600_000;
const sum = (rows: ReportRow[], pick: (row: ReportRow) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0);
const perCommit = (value: number, commits: number): string =>
  commits === 0 ? "-" : (value / commits).toFixed(commits >= 10 ? 0 : 1);

function groupLine(group: Group): string {
  const commits = sum(group.rows, (row) => row.commits);
  const wallMin = sum(group.rows, (row) => row.endMs - row.startMs) / 60_000;
  const cost = sum(group.rows, (row) => row.costUsd ?? 0);
  const calls = sum(group.rows, (row) => row.llmCalls);
  const cols = [
    group.agent.padEnd(8),
    group.outcome.padEnd(12),
    String(group.rows.length).padStart(5),
    String(commits).padStart(8),
    hours(wallMin * 60_000).toFixed(1).padStart(7),
    perCommit(wallMin, commits).padStart(11),
    (cost > 0 ? cost.toFixed(2) : "-").padStart(8),
    (calls > 0 ? perCommit(calls, commits) : "-").padStart(12),
    String(sum(group.rows, (row) => row.compactions)).padStart(12),
  ];
  return cols.join(" ");
}

const HEADER = "agent    outcome      iters  commits   hours  min/commit    cost $  calls/commit  compactions";

function restartLines(restarts: Restart[]): string[] {
  const unplanned = restarts.filter((restart) => restart.after !== "stop");
  const lines = [`restarts not preceded by a deliberate stop: ${unplanned.length} of ${restarts.length}`];
  for (const restart of unplanned) {
    const when = new Date(restart.atMs).toISOString().slice(0, 16);
    lines.push(`  ${when}Z  after ${restart.after.padEnd(6)} silent ${hours(restart.silentMs).toFixed(1)} h before it`);
  }
  return lines;
}

function limitLines(waits: LimitWait[]): string[] {
  const planned = waits.reduce((total, wait) => total + wait.plannedMs, 0);
  const actual = waits.reduce((total, wait) => total + wait.actualMs, 0);
  const early = waits.filter((wait) => wait.early).length;
  return [
    `limit waits: ${waits.length}, planned ${(planned / 60_000).toFixed(0)} min, slept ${(actual / 60_000).toFixed(0)} min, ended early by the probe ${early}`,
  ];
}

/** The report as text: one line per agent and outcome, the unplanned restarts, the limit waits. */
export function formatReport(report: Report): string {
  const lines = [HEADER, ...groupsOf(report.rows).map(groupLine), "", ...restartLines(report.restarts), "", ...limitLines(report.limitWaits)];
  return lines.join("\n");
}
