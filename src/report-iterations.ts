import type { LoopEvent } from "./mailbox.ts";

export type Outcome = "done" | "stalled" | "halted" | "yielded" | "interrupted" | "open";

/** One loop iteration as the journal recorded it; commits and transcript figures are joined in afterwards. */
export type IterationRecord = {
  n: number;
  row: string | null;
  sessionId: string | null;
  agent: string | null;
  outcome: Outcome;
  reason: string | null;
  startMs: number;
  /** The terminal event's time; for an interrupted or open iteration the last event it had (a lower bound). */
  endMs: number;
  headStart: string;
  /** Where the commit range ends: the head the loop recorded when done, else where the next iteration began. */
  headEnd: string | null;
};

const TERMINAL: Record<string, Outcome> = {
  iteration_done: "done",
  iteration_stalled: "stalled",
  iteration_halted: "halted",
  iteration_yielded: "yielded",
  iteration_interrupted: "interrupted",
};

const atMs = (event: LoopEvent): number => Date.parse(String(event["at"]));

/**
 * Cuts the journal at each `iteration_started`. Each cut becomes a record; the session, the outcome and
 * the commit range come from that cut's own events, never from clock windows.
 *
 * @example
 * iterationsOf(events)[0]?.outcome; // "done"
 */
export function iterationsOf(events: LoopEvent[], headNow: string): IterationRecord[] {
  const starts = events.flatMap((event, at) => (event.type === "iteration_started" ? [at] : []));
  return starts.map((from, k) => {
    const to = starts[k + 1] ?? events.length;
    const nextHead = k + 1 < starts.length ? String(events[to]?.["head"]) : headNow;
    return recordOf(k, events.slice(from, to), nextHead);
  });
}

function recordOf(n: number, window: LoopEvent[], nextHead: string): IterationRecord {
  const started = window[0] as LoopEvent;
  const terminal = window.find((event) => event.type in TERMINAL);
  const outcome = terminal ? (TERMINAL[terminal.type] as Outcome) : "open";
  const session = window.find((event) => event.type === "session_started");
  const last = window[window.length - 1] as LoopEvent;
  return {
    n,
    row: typeof started["row"] === "string" ? started["row"] : null,
    sessionId: typeof session?.["sessionId"] === "string" ? session["sessionId"] : null,
    agent: typeof session?.["agent"] === "string" ? session["agent"] : null,
    outcome,
    reason: typeof terminal?.["reason"] === "string" ? terminal["reason"] : null,
    startMs: atMs(started),
    endMs: atMs(terminal ?? last),
    headStart: String(started["head"]),
    headEnd: outcome === "done" ? String(terminal?.["head"]) : nextHead,
  };
}

/** One restart of the loop and what preceded it. */
export type Restart = {
  atMs: number;
  /** What the journal's previous event was: a deliberate `stop`, a `loop_halted`, or anything else (the loop died). */
  after: "stop" | "halted" | "died";
  /** The silence before the restart: an upper bound on the downtime, since a quiet loop writes nothing. */
  silentMs: number;
};

export function restartsOf(events: LoopEvent[]): Restart[] {
  const restarts: Restart[] = [];
  events.forEach((event, at) => {
    const before = events[at - 1];
    if (event.type !== "loop_started" || before === undefined) return;
    const after = before.type === "stop" ? "stop" : before.type === "loop_halted" ? "halted" : "died";
    restarts.push({ atMs: atMs(event), after, silentMs: atMs(event) - atMs(before) });
  });
  return restarts;
}

/** One wait for a usage limit and how it ended. */
export type LimitWait = { atMs: number; plannedMs: number; actualMs: number; early: boolean };

export function limitWaitsOf(events: LoopEvent[]): LimitWait[] {
  const waits: LimitWait[] = [];
  events.forEach((event, at) => {
    if (event.type !== "rate_limited") return;
    const planned = Date.parse(String(event["wakeAt"])) - atMs(event);
    const next = events.slice(at + 1).find((e) => e.type === "limit_cleared" || e.type === "iteration_started" || e.type === "loop_started");
    const cleared = next?.type === "limit_cleared" ? atMs(next) - atMs(event) : planned;
    waits.push({ atMs: atMs(event), plannedMs: planned, actualMs: Math.min(planned, cleared), early: cleared < planned });
  });
  return waits;
}
