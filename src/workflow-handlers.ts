import { AGENT_NAMES } from "./agents/index.ts";
import { parseCondition, placeholdersIn, type Condition } from "./conditions.ts";
import { EVENTS, isEventName, type EventName } from "./event-registry.ts";
import { asObject, fail, list, number, onlyKeys, optionalText, regex, text, type Obj } from "./shape.ts";

/** How a `needs_answer` handler picks each question's option. */
export type AnswerChoice = "recommended" | "first" | { choose: RegExp };

export type Action =
  | { kind: "answer"; choice: AnswerChoice }
  | { kind: "reply"; text: string }
  | { kind: "run"; command: string | string[]; timeoutMs: number }
  | { kind: "use"; agent: string | null; model: string | null; effort: string | null }
  | { kind: "stop" }
  | { kind: "yield"; reason: string };

/** What a repository says to do when an event matches: the first handler whose `when` holds runs its actions. */
export type Handler = {
  event: EventName;
  name: string;
  when: Condition[];
  /** Recorded in the journal beside an answer or reply this handler gives. */
  why: string | null;
  actions: Action[];
};

const ACTIONS = ["answer", "reply", "run", "use", "stop", "yield"] as const;
/** The one event each of these may be used on: the loop reads their result, so they mean nothing elsewhere. */
const ONLY_ON: Record<string, EventName> = { answer: "needs_answer", reply: "needs_reply", yield: "rate_limited" };
const RUN_TIMEOUT_SECONDS = 60;

/** The `on:` mapping as an ordered list of handlers. */
export function parseHandlers(raw: unknown): Handler[] {
  const on = asObject(raw ?? {}, "on");
  return Object.entries(on).flatMap(([event, entries]) => {
    if (!isEventName(event)) return fail(`on.${event}`, `an event name (see \`autopilot events\`)`, event);
    if (event.startsWith("workflow_")) return fail(`on.${event}`, "an event a workflow can react to; workflow_* events are its own record", event);
    return list({ [event]: entries }, event, "on").map((entry, at) => parseHandler(event, entry, at));
  });
}

function parseHandler(event: EventName, raw: unknown, at: number): Handler {
  const where = `on.${event}[${at}]`;
  const obj = asObject(raw, where);
  onlyKeys(obj, ["name", "when", "why", "do"], where);
  const when = Object.entries(asObject(obj["when"] ?? {}, `${where}.when`)).map(([path, value]) => {
    checkField(event, path, `${where}.when.${path}`);
    return parseCondition(path, value, `${where}.when`);
  });
  const actions = actionList(obj["do"], where).map((action, k) => parseAction(event, action, `${where}.do[${k}]`));
  if (actions.length === 0) return fail(`${where}.do`, "at least one action", obj["do"]);
  return { event, name: text(obj, "name", where, `${event}#${at}`), when, why: optionalText(obj, "why", where), actions };
}

function actionList(value: unknown, where: string): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? fail(`${where}.do`, "an action or a list of actions", value) : [value];
}

function checkField(event: EventName, path: string, where: string): void {
  const first = path.split(".")[0] ?? "";
  const known: readonly string[] = ["type", "at", ...EVENTS[event].fields];
  if (!known.includes(first)) fail(where, `a field of ${event} (${known.join(", ")})`, first);
}

function parseAction(event: EventName, raw: unknown, where: string): Action {
  const obj = asObject(raw, where);
  const keys = Object.keys(obj);
  const [name] = keys;
  if (keys.length !== 1 || !(ACTIONS as readonly string[]).includes(name ?? "")) {
    return fail(where, `one action: ${ACTIONS.join(", ")}`, raw);
  }
  const only = ONLY_ON[name as string];
  if (only !== undefined && only !== event) return fail(where, `${name} only on ${only}`, event);
  const value = obj[name as string];
  const path = `${where}.${name}`;
  switch (name as (typeof ACTIONS)[number]) {
    case "answer": return { kind: "answer", choice: parseChoice(value, path) };
    case "reply": return { kind: "reply", text: templated(value, event, path) };
    case "yield": return { kind: "yield", reason: templated(value, event, path) };
    case "run": return parseRun(value, event, path);
    case "use": return parseUse(value, path);
    case "stop": return value === true ? { kind: "stop" } : fail(path, "true", value);
  }
}

function templated(value: unknown, event: EventName, where: string): string {
  if (typeof value !== "string" || value === "") return fail(where, "a non-empty text", value);
  for (const field of placeholdersIn(value)) checkField(event, field, `${where} {{${field}}}`);
  return value;
}

function parseChoice(value: unknown, where: string): AnswerChoice {
  if (value === "recommended" || value === "first") return value;
  const obj = asObject(value, where);
  onlyKeys(obj, ["choose"], where);
  return { choose: regex(obj["choose"], `${where}.choose`) };
}

function parseRun(value: unknown, event: EventName, where: string): Action {
  if (typeof value === "string" || Array.isArray(value)) return runOf(value, event, where, RUN_TIMEOUT_SECONDS);
  const obj = asObject(value, where);
  onlyKeys(obj, ["command", "timeout_seconds"], where);
  return runOf(obj["command"], event, `${where}.command`, number(obj, "timeout_seconds", where, RUN_TIMEOUT_SECONDS));
}

function runOf(command: unknown, event: EventName, where: string, seconds: number): Action {
  if (typeof command === "string") return shellRun(command, where, seconds);
  if (Array.isArray(command) && command.length > 0) {
    const argv = command.map((word, k) => templated(word, event, `${where}[${k}]`));
    return { kind: "run", command: argv, timeoutMs: seconds * 1000 };
  }
  return fail(where, "a shell command text or a non-empty argument list", command);
}

/**
 * A shell string takes no `{{field}}`: event fields such as `lastMessage` are written by the agent, and
 * filling them into a shell would run what the agent wrote. The argument-list form passes them as plain
 * arguments, and every command also gets the whole event as JSON on stdin and in AUTOPILOT_EVENT.
 */
function shellRun(command: string, where: string, seconds: number): Action {
  if (placeholdersIn(command).length > 0) {
    return fail(where, "a shell text without {{field}} (use the argument-list form, or read AUTOPILOT_EVENT)", command);
  }
  return { kind: "run", command, timeoutMs: seconds * 1000 };
}

function parseUse(value: unknown, where: string): Action {
  const obj: Obj = asObject(value, where);
  onlyKeys(obj, ["harness", "model", "effort"], where);
  const agent = optionalText(obj, "harness", where);
  if (agent === null || !AGENT_NAMES.includes(agent)) return fail(`${where}.harness`, `one of ${AGENT_NAMES.join(", ")}`, agent);
  return { kind: "use", agent, model: optionalText(obj, "model", where), effort: optionalText(obj, "effort", where) };
}
