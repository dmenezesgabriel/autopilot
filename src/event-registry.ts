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

export type EventSpec = {
  readonly kind: EventKind;
  /** The journal fields a `when:` can read, beside `type` and `at`. */
  readonly fields: readonly string[];
  readonly means: string;
};

export const EVENTS = {
  loop_started: { kind: "progress", fields: ["repoRoot", "pid", "agent", "model", "effort", "planFollowUp"], means: "A loop process began" },
  loop_halted: { kind: "alert", fields: ["reason"], means: "The loop ended on its own: weekly limit with no probe, refusal, repeated stalls or crashes, session setup failure" },
  loop_signalled: { kind: "telemetry", fields: ["signal"], means: "SIGTERM, SIGINT or SIGHUP ended the loop (a service stop or a shutdown)" },
  backlog_exhausted: { kind: "progress", fields: [], means: "No backlog row carries the marker" },
  stop: { kind: "progress", fields: [], means: "`autopilot stop` was run and the loop is leaving" },
  iteration_started: { kind: "progress", fields: ["row", "head"], means: "A fresh session begins on the next row" },
  iteration_done: { kind: "progress", fields: ["head"], means: "A session ended with a new commit and a clean tree" },
  iteration_stalled: { kind: "alert", fields: ["reason"], means: "The agent kept stopping without a commit" },
  iteration_halted: { kind: "alert", fields: ["reason"], means: "An iteration ended by a halt (limit, refusal, setup failure, background work past its ceiling)" },
  iteration_crashed: { kind: "alert", fields: [], means: "The agent's channel closed" },
  iteration_yielded: { kind: "progress", fields: ["reason"], means: "A workflow ended the iteration on purpose, leaving its work in the tree for the next session" },
  iteration_interrupted: { kind: "alert", fields: ["n", "row", "sessionId", "pending", "running"], means: "A previous loop process died mid-iteration" },
  session_started: { kind: "telemetry", fields: ["sessionId", "agent", "model", "effort"], means: "An agent session opened" },
  mode_changed: { kind: "telemetry", fields: ["mode"], means: "The agent changed mode" },
  plan_ready: { kind: "telemetry", fields: ["plan"], means: "The agent proposed a plan" },
  plan_approved: { kind: "telemetry", fields: ["via"], means: "The loop approved the plan under the follow-up command" },
  turn_ended: { kind: "telemetry", fields: ["end", "decision"], means: "A prompt turn ended and the loop chose its next step" },
  awaiting_work: { kind: "telemetry", fields: ["running", "exitUnreported"], means: "The turn ended while a background command still runs" },
  needs_answer: { kind: "decision", fields: ["id", "questions"], means: "The agent asked a multiple-choice question and waits" },
  needs_answer_overdue: { kind: "alert", fields: ["id", "waitedMs"], means: "A question waited ten minutes" },
  answer_received: { kind: "telemetry", fields: ["id", "answer", "why"], means: "A question was answered" },
  answer_defaulted: { kind: "alert", fields: ["id"], means: "A question was answered with its default after an hour" },
  needs_reply: { kind: "decision", fields: ["id", "why", "lastMessage"], means: "The agent stopped in plan mode, or in bypass with no commit or a dirty tree" },
  reply_received: { kind: "telemetry", fields: ["id", "answer", "why"], means: "A reply was given" },
  reply_defaulted: { kind: "alert", fields: ["id", "why"], means: "A reply was sent as the fixed nudge after ten minutes" },
  possibly_hung: { kind: "alert", fields: ["silentMs", "running"], means: "No frame for 45 minutes, or a background command beyond its ceiling" },
  hung_cancelled: { kind: "alert", fields: ["silentMs"], means: "The turn was cancelled after three hours of silence" },
  permission_requested: { kind: "alert", fields: ["tool", "chose"], means: "The permission mode still asked about a tool; the loop allowed it once" },
  exit_plan_bypass_missing: { kind: "alert", fields: ["offered"], means: "Leaving plan mode did not offer bypass" },
  exit_plan_reject_missing: { kind: "alert", fields: ["offered"], means: "Declining the plan exit was not offered" },
  background_started: { kind: "telemetry", fields: ["shellId", "command"], means: "The agent started a background command" },
  background_exited: { kind: "telemetry", fields: ["shellId", "exitCode"], means: "A background command ended (a null code is a killed task)" },
  background_watch_error: { kind: "alert", fields: ["shellId", "error"], means: "The loop could not read a background command's output file" },
  rate_limit_rejected: { kind: "telemetry", fields: ["limitType", "resetsAt"], means: "The agent reported a rejected usage limit" },
  rate_limited: { kind: "alert", fields: ["wakeAt"], means: "A usage limit hit and the loop waits" },
  limit_cleared: { kind: "progress", fields: ["early"], means: "The probe saw the account usable again" },
  preflight_wait: { kind: "telemetry", fields: ["reason"], means: "A new session is held back: a busy host or a leftover process" },
  agent_choice_changed: { kind: "telemetry", fields: ["from", "to"], means: "The next session uses a new agent, model or effort" },
  agent_choice_invalid: { kind: "alert", fields: ["error"], means: "choice.json could not be read; the current choice stays" },
  agent_signal: { kind: "telemetry", fields: ["method", "params", "cause"], means: "A vendor notification nobody has read yet" },
  workflow_applied: { kind: "telemetry", fields: ["event", "handler", "actions"], means: "A workflow handler ran its actions for an event" },
  workflow_error: { kind: "alert", fields: ["event", "handler", "action", "error"], means: "A workflow action failed; the loop goes on" },
  workflow_invalid: { kind: "alert", fields: ["error"], means: "The workflow file could not be read at an iteration start; the previous one stays" },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(EVENTS, name);
}

/** The events a watching orchestrator is woken for when the workflow does not say: the decisions, and what needs a person. */
export function defaultWakeEvents(): EventName[] {
  return EVENT_NAMES.filter((name) => EVENTS[name].kind === "decision" || isEscalation(name));
}

const ESCALATIONS: ReadonlySet<string> = new Set([
  "needs_answer_overdue",
  "possibly_hung",
  "hung_cancelled",
  "exit_plan_bypass_missing",
  "exit_plan_reject_missing",
  "background_watch_error",
  "loop_halted",
  "iteration_stalled",
  "iteration_halted",
  "iteration_crashed",
  "backlog_exhausted",
]);

function isEscalation(name: string): boolean {
  return ESCALATIONS.has(name);
}
