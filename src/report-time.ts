import type { LoopEvent } from "./mailbox.ts";

/** What the agent was waiting for while no turn was open, in the order that wins when a gap shows several. */
export type IdleKind = "limit" | "human" | "background" | "other";

/** Where the time of the finished iterations that have turn events went. */
export type TimeSplit = {
  iterations: number;
  /** When the first counted iteration began. */
  sinceMs: number;
  inTurnMs: number;
  idleMs: Record<IdleKind, number>;
  /** Time preflight held a session back before the counted iterations; it lies between iterations, outside the rest. */
  heldMs: number;
};

type Span = { startMs: number; endMs: number };
type Window = Span & { turns: Span[]; heldMs: number };

const atMs = (event: LoopEvent): number => Date.parse(String(event["at"]));
const ANSWERED = new Set(["answer_received", "answer_defaulted", "reply_received", "reply_defaulted"]);
const ASKS = new Set(["needs_answer", "needs_reply"]);
const CLOSERS = new Set(["iteration_done", "iteration_stalled", "iteration_halted", "iteration_crashed", "iteration_yielded", "iteration_interrupted"]);

/**
 * Splits the time of the iterations that ended in a commit and have turn events into time in a turn and
 * time between turns, and attributes each wait between turns to what the journal shows in it: a rate
 * limit, a question or reply waiting, or a command the agent started. A gap that shows several is
 * attributed to the first of them in that order. Null when no such iteration has turn events, as in a
 * journal written before `turn_started` existed.
 *
 * A turn includes the time the agent spends blocked on its own tool calls, so an agent that waits for a
 * command inside a turn (Devin) shows little idle time, and one that ends its turn to wait (Claude) shows a lot.
 *
 * @example
 * timeSplitOf(events)?.idleMs.background; // milliseconds spent waiting between turns for background commands
 */
export function timeSplitOf(events: LoopEvent[]): TimeSplit | null {
  const windows = windowsOf(events).filter((window) => window.turns.length > 0);
  if (windows.length === 0) return null;
  const marks = marksOf(events);
  const split: TimeSplit = { iterations: windows.length, sinceMs: windows[0]?.startMs ?? 0, inTurnMs: 0, idleMs: { limit: 0, human: 0, background: 0, other: 0 }, heldMs: 0 };
  for (const window of windows) addWindow(split, window, marks);
  return split;
}

function addWindow(split: TimeSplit, window: Window, marks: Marks): void {
  split.heldMs += window.heldMs;
  let cursor = window.startMs;
  for (const turn of window.turns) {
    addGap(split, { startMs: cursor, endMs: turn.startMs }, marks);
    split.inTurnMs += turn.endMs - turn.startMs;
    cursor = turn.endMs;
  }
  addGap(split, { startMs: cursor, endMs: window.endMs }, marks);
}

function addGap(split: TimeSplit, gap: Span, marks: Marks): void {
  if (gap.endMs <= gap.startMs) return;
  split.idleMs[kindOfGap(gap, marks)] += gap.endMs - gap.startMs;
}

type Marks = { limits: number[]; awaiting: number[]; asks: Span[] };

function kindOfGap(gap: Span, marks: Marks): IdleKind {
  const inside = (ms: number): boolean => ms >= gap.startMs && ms <= gap.endMs;
  if (marks.limits.some(inside)) return "limit";
  if (marks.asks.some((ask) => ask.startMs <= gap.endMs && ask.endMs >= gap.startMs)) return "human";
  if (marks.awaiting.some(inside)) return "background";
  return "other";
}

function marksOf(events: LoopEvent[]): Marks {
  const marks: Marks = { limits: [], awaiting: [], asks: [] };
  const open = new Map<string, number>();
  for (const event of events) {
    const ms = atMs(event);
    if (event.type === "rate_limited") marks.limits.push(ms);
    else if (event.type === "awaiting_work") marks.awaiting.push(ms);
    else if (ASKS.has(event.type)) open.set(String(event["id"]), ms);
    else if (ANSWERED.has(event.type) && open.has(String(event["id"]))) {
      marks.asks.push({ startMs: open.get(String(event["id"])) ?? ms, endMs: ms });
      open.delete(String(event["id"]));
    }
  }
  return marks;
}

/** The iterations that ended in a commit, each with its turns and the time preflight held it back before it began. */
function windowsOf(events: LoopEvent[]): Window[] {
  const windows: Window[] = [];
  let current: { startMs: number; heldMs: number; events: LoopEvent[] } | null = null;
  let firstWaitMs: number | null = null;
  for (const event of events) {
    if (event.type === "preflight_wait" && firstWaitMs === null) firstWaitMs = atMs(event);
    if (event.type === "iteration_started") {
      current = { startMs: atMs(event), heldMs: firstWaitMs === null ? 0 : atMs(event) - firstWaitMs, events: [] };
      firstWaitMs = null;
    } else if (current !== null && CLOSERS.has(event.type)) {
      if (event.type === "iteration_done") windows.push({ startMs: current.startMs, endMs: atMs(event), heldMs: current.heldMs, turns: turnsOf(current.events, atMs(event)) });
      current = null;
      firstWaitMs = null;
    } else current?.events.push(event);
  }
  return windows;
}

/** Each turn runs from its start to the next end, or to the next start (or the iteration's end) when it has none. */
function turnsOf(events: LoopEvent[], endMs: number): Span[] {
  const marks = events.filter((event) => event.type === "turn_started" || event.type === "turn_ended");
  const turns: Span[] = [];
  marks.forEach((event, at) => {
    if (event.type !== "turn_started") return;
    const next = marks[at + 1];
    turns.push({ startMs: atMs(event), endMs: next === undefined ? endMs : atMs(next) });
  });
  return turns;
}

const hours = (ms: number): string => (ms / 3_600_000).toFixed(1);

/** The report's time section, or the reason there is none. */
export function timeLines(split: TimeSplit | null): string[] {
  if (split === null) return ["where the time goes: not available, this journal has no turn_started events (a loop started before this build does not write them)"];
  const idle = split.idleMs;
  const total = split.inTurnMs + idle.limit + idle.human + idle.background + idle.other;
  const row = (label: string, ms: number): string => `  ${label.padEnd(38)} ${hours(ms).padStart(5)} h (${Math.round((100 * ms) / Math.max(total, 1))}%)`;
  const since = new Date(split.sinceMs).toISOString().slice(0, 10);
  return [
    `where the time goes, in ${split.iterations} finished iteration${split.iterations === 1 ? "" : "s"} since ${since} (${hours(total)} h):`,
    row("in a turn", split.inTurnMs),
    row("idle, background commands running", idle.background),
    row("idle, waiting for an answer or reply", idle.human),
    row("idle, rate-limit sleep", idle.limit),
    row("idle, other", idle.other),
    `  ${"held by preflight before a session".padEnd(38)} ${hours(split.heldMs).padStart(5)} h (between iterations, outside the above)`,
    "a turn includes the time the agent spends blocked on its own tool calls: an agent that waits inside a turn shows little idle time here",
  ];
}
