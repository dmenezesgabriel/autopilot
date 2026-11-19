import { describeChoice, type AgentChoice } from "./agent-choice.ts";
import { ITERATION_OUTCOME, LOOP_END, type LoopEnd } from "./event-registry.ts";

export type JournalEvent = {
  at: string;
  type: string;
  [detail: string]: unknown;
};

/** One question of a `needs_answer` event, as `autopilot answer` needs it to check an answer. */
export type AskedQuestion = { header: string; question: string; options: string[] };
export type PendingAsk = {
  id: string;
  kind: "question" | "reply";
  since: string;
  overdue: boolean;
  /** The questions a `question` waits on, one answer each; empty for a reply. */
  questions: AskedQuestion[];
};
export type Decision = {
  at: string;
  id: string;
  how: "answered" | "defaulted";
  answer: unknown;
  why: string | null;
};
export type FinishedIteration = {
  n: number;
  row: string;
  outcome: string;
  detail: string;
  startedAt: string;
  endedAt: string;
};
export type OpenIteration = {
  n: number;
  row: string;
  startedAt: string;
  sessionId: string | null;
  /** What the session really runs on, as the agent read it back; null for a journal that predates it. */
  ranOn: AgentChoice | null;
  mode: string | null;
  running: string[];
  pending: PendingAsk[];
  rateLimitedUntil: string | null;
};
/** How the loop stands: before its first start, running, or how its last run ended (the registry's `ends.loop` words). */
export type LoopStatus = "never_started" | "running" | LoopEnd;
export type JournalSummary = {
  loop: LoopStatus;
  haltReason: string | null;
  open: OpenIteration | null;
  finished: FinishedIteration[];
  decisions: Decision[];
};

/**
 * Rebuilds what the loop is doing, what it finished and what was decided from
 * the append-only event journal alone, so a restarted loop or orchestrator
 * loses nothing: the journal is the only state.
 *
 * @example
 * summarizeJournal(events).open?.pending // questions still waiting for an answer
 */
export function summarizeJournal(events: JournalEvent[]): JournalSummary {
  const summary: JournalSummary = {
    loop: "never_started",
    haltReason: null,
    open: null,
    finished: [],
    decisions: [],
  };
  let started = 0;
  for (const event of events) {
    if (event.type === "iteration_started") started += 1;
    applyLoopEvent(summary, event);
    applyIterationEvent(summary, event, started);
    applyAskEvent(summary, event);
  }
  return summary;
}

function applyLoopEvent(summary: JournalSummary, event: JournalEvent): void {
  if (event.type === "loop_started") {
    summary.loop = "running";
    summary.haltReason = null;
    return;
  }
  const end = LOOP_END[event.type];
  if (end === undefined) return;
  summary.loop = end;
  if (event.type === "loop_halted") summary.haltReason = String(event["reason"]);
}

/**
 * The agent, model and effort a `session_started` event carries. An event that does not carry an agent
 * is not read as any: the journal says nothing there, and a default would be a guess.
 */
function ranOnOf(event: JournalEvent): AgentChoice | null {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const agent = text(event["agent"]);
  return agent === null ? null : { agent, model: text(event["model"]), effort: text(event["effort"]) };
}

function applyIterationEvent(
  summary: JournalSummary,
  event: JournalEvent,
  n: number,
): void {
  if (event.type === "iteration_started") {
    summary.open = {
      n,
      row: String(event["row"] ?? ""),
      startedAt: event.at,
      sessionId: null,
      ranOn: null,
      mode: null,
      running: [],
      pending: [],
      rateLimitedUntil: null,
    };
    return;
  }
  const open = summary.open;
  if (!open) return;
  if (event.type in ITERATION_OUTCOME) return finishIteration(summary, open, event);
  trackSession(open, event);
}

function finishIteration(
  summary: JournalSummary,
  open: OpenIteration,
  event: JournalEvent,
): void {
  summary.finished.push({
    n: open.n,
    row: open.row,
    outcome: ITERATION_OUTCOME[event.type] ?? event.type,
    detail: String(event["head"] ?? event["reason"] ?? ""),
    startedAt: open.startedAt,
    endedAt: event.at,
  });
  summary.open = null;
}

function trackSession(open: OpenIteration, event: JournalEvent): void {
  if (event.type === "session_started") {
    open.sessionId = String(event["sessionId"]);
    open.ranOn = ranOnOf(event);
  }
  if (event.type === "mode_changed") open.mode = String(event["mode"]);
  if (event.type === "rate_limited")
    open.rateLimitedUntil = String(event["wakeAt"]);
  if (event.type === "turn_ended") open.rateLimitedUntil = null;
  if (event.type === "background_started") open.running.push(commandKey(event));
  if (event.type === "background_exited") {
    open.running = open.running.filter(
      (entry) => !entry.startsWith(`${String(event["shellId"])}:`),
    );
  }
}

function commandKey(event: JournalEvent): string {
  return `${String(event["shellId"])}: ${String(event["command"])}`;
}

function applyAskEvent(summary: JournalSummary, event: JournalEvent): void {
  const open = summary.open;
  const id = String(event["id"] ?? "");
  if (open && (event.type === "needs_answer" || event.type === "needs_reply")) {
    const kind = event.type === "needs_answer" ? "question" : "reply";
    const questions = kind === "question" ? askedQuestionsOf(event["questions"]) : [];
    open.pending.push({ id, kind, since: event.at, overdue: false, questions });
  }
  if (open && event.type === "needs_answer_overdue") {
    for (const ask of open.pending) if (ask.id === id) ask.overdue = true;
  }
  const how = DECISION_EVENTS[event.type];
  if (!how) return;
  if (open) open.pending = open.pending.filter((ask) => ask.id !== id);
  summary.decisions.push({
    at: event.at,
    id,
    how,
    answer: event["answer"] ?? null,
    why: typeof event["why"] === "string" ? event["why"] : null,
  });
}

function askedQuestionsOf(raw: unknown): AskedQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: Record<string, unknown>) => ({
    header: String(entry["header"] ?? ""),
    question: String(entry["question"] ?? ""),
    options: Array.isArray(entry["options"])
      ? entry["options"].map((option: Record<string, unknown>) => String(option["label"]))
      : [],
  }));
}

const DECISION_EVENTS: Record<string, Decision["how"] | undefined> = {
  answer_received: "answered",
  reply_received: "answered",
  answer_defaulted: "defaulted",
  reply_defaulted: "defaulted",
};

const RECENT = 5;

/**
 * Plain-text report for `autopilot status`; `pidAlive` says whether the process that wrote the journal
 * still runs. `nextSession` is worked out by the caller from the files that decide it, not read from the
 * journal, which only records what an earlier session ran on.
 */
export function describeSummary(
  summary: JournalSummary,
  pid: number | null,
  pidAlive: boolean,
  nextSession: readonly string[] = [],
): string {
  const lines = [
    `loop: ${summary.loop}${pidNote(pid, pidAlive)}${haltNote(summary)}`,
    ...nextSession,
  ];
  if (summary.open) lines.push(...describeOpen(summary.open));
  lines.push(countLine("finished iterations", summary.finished.length));
  for (const done of summary.finished.slice(-RECENT)) {
    lines.push(`  #${done.n} ${done.outcome} ${done.detail} (${done.row})`);
  }
  lines.push(countLine("decisions", summary.decisions.length));
  for (const decision of summary.decisions.slice(-RECENT)) {
    const reason = decision.why ? ` because ${decision.why}` : "";
    const answer = JSON.stringify(decision.answer);
    lines.push(`  ${decision.at.slice(0, 16)}Z ${decision.id} ${decision.how} ${answer}${reason}`);
  }
  return lines.join("\n");
}

/** A count, and when only the latest are listed below it, how many. */
function countLine(label: string, total: number): string {
  return total > RECENT ? `${label}: ${total} (the last ${RECENT} below)` : `${label}: ${total}`;
}

function pidNote(pid: number | null, alive: boolean): string {
  if (pid === null) return "";
  return alive
    ? ` (pid ${pid} alive)`
    : ` (pid ${pid} is NOT running: the loop died, restart it)`;
}

function haltNote(summary: JournalSummary): string {
  return summary.haltReason ? ` — ${summary.haltReason}` : "";
}

function ranOnNote(open: OpenIteration): string {
  return open.ranOn ? ` on ${describeChoice(open.ranOn)}` : "";
}

function describeOpen(open: OpenIteration): string[] {
  const lines = [
    `iteration #${open.n} since ${open.startedAt}: ${open.row}`,
    `  session ${open.sessionId ?? "-"}${ranOnNote(open)}, mode ${open.mode ?? "-"}`,
  ];
  if (open.rateLimitedUntil)
    lines.push(`  rate limited until ${open.rateLimitedUntil}`);
  for (const command of open.running) lines.push(`  running: ${command}`);
  for (const ask of open.pending) {
    const flag = ask.overdue ? " OVERDUE" : "";
    lines.push(`  waiting for ${ask.kind} ${ask.id} since ${ask.since}${flag}`);
  }
  return lines;
}
