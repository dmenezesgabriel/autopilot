/**
 * Every event the loop journals, with the fields a workflow can match on and what the event means. One
 * declaration: `autopilot events` prints it, a workflow naming an event outside it is refused, and a test
 * fails when the code emits a type that is not listed here.
 */
export type EventKind =
  /** The agent or the loop needs a decision from outside; the orchestrator's job. */
  | "decision"
  /** Something finished or began; worth a report, never a decision. */
  | "progress"
  /** Something went wrong or is about to; worth telling a person. */
  | "alert"
  /** The loop's own bookkeeping; read in the journal, not woken for. */
  | "telemetry";

type EventSpecBase = {
  /** The journal fields a `when:` can read, beside `type` and `at`. */
  readonly fields: readonly string[];
  readonly means: string;
  /**
   * What the event closes: an iteration (with its outcome) or the loop (with how it ended). Every reader of
   * the journal takes this from here, so `status`, `report` and the restart count cannot each keep a list
   * of their own and miss an event the others know.
   */
  readonly ends?: { readonly iteration: string } | { readonly loop: string };
};

/**
 * Whether a watching orchestrator is woken for the event unless the workflow's `wake:` says otherwise. A
 * decision always wakes; an alert must say, so a new one cannot be left out by omission; a progress or
 * telemetry event wakes only where it says so.
 */
export type EventSpec = EventSpecBase &
  (
    | { readonly kind: "alert"; readonly wake: boolean }
    | { readonly kind: Exclude<EventKind, "alert">; readonly wake?: boolean }
  );

export const EVENTS = {
  loop_started: { kind: "progress", fields: ["repoRoot", "pid", "agent", "model", "effort", "planFollowUp"], means: "A loop process began" },
  loop_halted: { kind: "alert", wake: true, ends: { loop: "halted" }, fields: ["reason"], means: "The loop ended on its own: weekly limit with no probe, refusal, repeated stalls or crashes, session setup failure" },
  loop_signalled: { kind: "telemetry", ends: { loop: "signalled" }, fields: ["signal"], means: "SIGTERM, SIGINT or SIGHUP ended the loop (a service stop or a shutdown)" },
  backlog_exhausted: { kind: "progress", wake: true, ends: { loop: "exhausted" }, fields: [], means: "No backlog row carries the marker" },
  stop: { kind: "progress", ends: { loop: "stopped" }, fields: [], means: "`autopilot stop` was run and the loop is leaving" },
  iteration_started: { kind: "progress", fields: ["row", "head"], means: "A fresh session begins on the next row" },
  iteration_done: { kind: "progress", ends: { iteration: "done" }, fields: ["head"], means: "A session ended with a new commit and a clean tree" },
  iteration_stalled: { kind: "alert", wake: true, ends: { iteration: "stalled" }, fields: ["reason"], means: "The agent kept stopping without a commit" },
  iteration_halted: { kind: "alert", wake: true, ends: { iteration: "halted" }, fields: ["reason"], means: "An iteration ended by a halt (limit, refusal, setup failure, background work past its ceiling)" },
  iteration_crashed: { kind: "alert", wake: true, ends: { iteration: "crashed" }, fields: [], means: "The agent's channel closed" },
  iteration_yielded: { kind: "progress", ends: { iteration: "yielded" }, fields: ["reason"], means: "A workflow ended the iteration on purpose, leaving its work in the tree for the next session" },
  iteration_interrupted: { kind: "alert", wake: false, ends: { iteration: "interrupted" }, fields: ["n", "row", "sessionId", "pending", "running"], means: "A previous loop process died mid-iteration" },
  session_started: { kind: "telemetry", fields: ["sessionId", "agent", "model", "effort"], means: "An agent session opened" },
  mode_changed: { kind: "telemetry", fields: ["mode"], means: "The agent changed mode" },
  plan_ready: { kind: "telemetry", fields: ["plan"], means: "The agent proposed a plan" },
  plan_approved: { kind: "telemetry", fields: ["via"], means: "The loop approved the plan under the follow-up command" },
  turn_ended: { kind: "telemetry", fields: ["end", "decision"], means: "A prompt turn ended and the loop chose its next step" },
  awaiting_work: { kind: "telemetry", fields: ["running", "exitUnreported"], means: "The turn ended while a background command still runs" },
  needs_answer: { kind: "decision", fields: ["id", "questions"], means: "The agent asked a multiple-choice question and waits" },
  needs_answer_overdue: { kind: "alert", wake: true, fields: ["id", "waitedMs"], means: "A question waited ten minutes" },
  answer_received: { kind: "telemetry", fields: ["id", "answer", "why"], means: "A question was answered" },
  answer_defaulted: { kind: "alert", wake: false, fields: ["id"], means: "A question was answered with its default after an hour" },
  needs_reply: { kind: "decision", fields: ["id", "why", "lastMessage"], means: "The agent stopped in plan mode, or in bypass with no commit or a dirty tree" },
  reply_received: { kind: "telemetry", fields: ["id", "answer", "why"], means: "A reply was given" },
  reply_defaulted: { kind: "alert", wake: false, fields: ["id", "why"], means: "A reply was sent as the fixed nudge after ten minutes" },
  possibly_hung: { kind: "alert", wake: true, fields: ["silentMs", "running"], means: "No frame for 45 minutes, or a background command beyond its ceiling" },
  hung_cancelled: { kind: "alert", wake: true, fields: ["silentMs"], means: "The turn was cancelled after three hours of silence" },
  permission_requested: { kind: "alert", wake: false, fields: ["tool", "chose"], means: "The permission mode still asked about a tool; the loop allowed it once" },
  exit_plan_bypass_missing: { kind: "alert", wake: true, fields: ["offered"], means: "Leaving plan mode did not offer bypass" },
  exit_plan_reject_missing: { kind: "alert", wake: true, fields: ["offered"], means: "Declining the plan exit was not offered" },
  background_started: { kind: "telemetry", fields: ["shellId", "command"], means: "The agent started a background command" },
  background_exited: { kind: "telemetry", fields: ["shellId", "exitCode", "via"], means: "A background command ended (a null code is a killed task; via liveness means the kernel proved the exit the agent never reported)" },
  background_watch_error: { kind: "alert", wake: true, fields: ["shellId", "error"], means: "The loop could not read a background command's output file" },
  rate_limit_rejected: { kind: "telemetry", fields: ["limitType", "resetsAt"], means: "The agent reported a rejected usage limit" },
  rate_limited: { kind: "alert", wake: false, fields: ["wakeAt"], means: "A usage limit hit and the loop waits" },
  limit_cleared: { kind: "progress", fields: ["early"], means: "The probe saw the account usable again" },
  preflight_wait: { kind: "telemetry", fields: ["reason"], means: "A new session is held back: a busy host or a leftover process" },
  agent_choice_changed: { kind: "telemetry", fields: ["from", "to"], means: "The next session uses a new agent, model or effort" },
  agent_choice_invalid: { kind: "alert", wake: true, fields: ["error"], means: "choice.json could not be read; the current choice stays" },
  agent_signal: { kind: "telemetry", fields: ["method", "params", "cause"], means: "A vendor notification nobody has read yet" },
  workflow_applied: { kind: "telemetry", fields: ["event", "handler", "actions"], means: "A workflow handler ran its actions for an event" },
  workflow_error: { kind: "alert", wake: true, fields: ["event", "handler", "action", "error"], means: "A workflow action failed; the loop goes on" },
  workflow_invalid: { kind: "alert", wake: true, fields: ["error"], means: "The workflow file could not be read at an iteration start; the previous one stays" },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(EVENTS, name);
}

/** The events a watching orchestrator is woken for when the workflow does not say: the decisions, and the alerts that need a person. */
export function defaultWakeEvents(): EventName[] {
  return EVENT_NAMES.filter((name) => specOf(name).kind === "decision" || specOf(name).wake === true);
}

function specOf(name: EventName): EventSpec {
  return EVENTS[name];
}

/** How an iteration can end: the `ends.iteration` words of the events above. */
export type IterationOutcome = {
  [K in EventName]: (typeof EVENTS)[K] extends { ends: { iteration: infer O } } ? O : never;
}[EventName];

/** How a loop run can end: the `ends.loop` words of the events above. */
export type LoopEnd = {
  [K in EventName]: (typeof EVENTS)[K] extends { ends: { loop: infer O } } ? O : never;
}[EventName];

type Closes = "iteration" | "loop";

/** The events that close `what`, each with the word that says how, read from the `ends` of the registry. */
function closingEvents(what: Closes): Readonly<Record<string, string>> {
  const closing: Record<string, string> = {};
  for (const name of EVENT_NAMES) {
    const ends = specOf(name).ends;
    if (ends !== undefined && what in ends) closing[name] = (ends as Record<string, string>)[what] as string;
  }
  return closing;
}

/** Iteration-closing event -> its outcome ("iteration_done" -> "done"). */
export const ITERATION_OUTCOME = closingEvents("iteration") as Readonly<Record<string, IterationOutcome>>;

/** Loop-closing event -> how the loop ended ("loop_signalled" -> "signalled"). */
export const LOOP_END = closingEvents("loop") as Readonly<Record<string, LoopEnd>>;
