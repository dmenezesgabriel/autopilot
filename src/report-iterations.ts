import { ITERATION_OUTCOME, LOOP_END, type IterationOutcome, type LoopEnd } from "./event-registry.ts";
import type { LoopEvent } from "./mailbox.ts";

/** How an iteration ended, as the registry words it, or "open" when the journal has no ending for it. */
export type Outcome = IterationOutcome | "open";

/** One loop iteration as the journal recorded it; commits and transcript figures are joined in afterwards. */
export type IterationRecord = {
  n: number;
  row: string | null;
  sessionId: string | null;
  agent: string | null;
  outcome: Outcome;
  reason: string | null;
  startMs: number;
  /** The terminal event's time; for an interrupted or open iteration the time of the last thing it did (a lower bound). */
  endMs: number;
  headStart: string;
  /** Where the commit range ends: the head the loop recorded when done, else where the next iteration began. */
  headEnd: string | null;
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
  const terminal = window.find((event) => event.type in ITERATION_OUTCOME);
  const outcome: Outcome = terminal ? (ITERATION_OUTCOME[terminal.type] as IterationOutcome) : "open";
  const session = window.find((event) => event.type === "session_started");
  return {
    n,
    row: typeof started["row"] === "string" ? started["row"] : null,
    sessionId: typeof session?.["sessionId"] === "string" ? session["sessionId"] : null,
    agent: typeof session?.["agent"] === "string" ? session["agent"] : null,
    outcome,
    reason: typeof terminal?.["reason"] === "string" ? terminal["reason"] : null,
    startMs: atMs(started),
    endMs: endOf(window, terminal),
    headStart: String(started["head"]),
    headEnd: outcome === "done" ? String(terminal?.["head"]) : nextHead,
  };
}

/**
 * When the iteration stopped working. A finished one ends at its own closing event. An interrupted or
 * open one has none that says when, and the events after it are not its own: the next loop process writes
 * `loop_started`, `iteration_interrupted` and its own waits (`preflight_wait` fills a busy host's hours)
 * into the same stretch of the journal, hours after the one that died (a real run recorded 21.9 h for an
 * iteration whose last event came 1.1 h in). A new `loop_started` means the old process is gone, so the
 * iteration ends at the last event before it.
 */
function endOf(window: LoopEvent[], terminal: LoopEvent | undefined): number {
  if (terminal !== undefined && terminal.type !== "iteration_interrupted") return atMs(terminal);
  const restart = window.findIndex((event, at) => at > 0 && event.type === "loop_started");
  const own = restart === -1 ? window : window.slice(0, restart);
  return atMs(own[own.length - 1] as LoopEvent);
}

/** One restart of the loop and what preceded it. */
export type Restart = {
  atMs: number;
  /** How the previous run ended, in the registry's words, or "died" when its last event is not one that ends a loop. */
  after: LoopEnd | "died";
  /** The silence before the restart: an upper bound on the downtime, since a quiet loop writes nothing. */
  silentMs: number;
};

export function restartsOf(events: LoopEvent[]): Restart[] {
  const restarts: Restart[] = [];
  events.forEach((event, at) => {
    const before = events[at - 1];
    if (event.type !== "loop_started" || before === undefined) return;
    const after = LOOP_END[before.type] ?? "died";
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
