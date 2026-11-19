import { readFile } from "node:fs/promises";
import { AGENT_NAMES } from "./agents/index.ts";
import { EVENT_NAMES, defaultWakeEvents, isEventName, type EventName } from "./event-registry.ts";
import { asObject, bool, fail, lines, list, number, onlyKeys, optionalText, oneOf, regex, text, type Obj } from "./shape.ts";
import type { WrapperRule } from "./process-wrapper.ts";
import type { HarnessSettings } from "./agent-choice.ts";
import { parseHandlers, type Handler } from "./workflow-handlers.ts";
import { readYaml } from "./yaml-reader.ts";

/** A process a finished session leaves behind: its command line matches `match` and, when given, `alsoMatch` too. */
export type LeftoverRule = { match: RegExp; alsoMatch: RegExp | null };

/** Which source tells the loop whether the live account can take a request again after a rejection. */
export type LimitProbeKind = "cam" | "none";

/**
 * Everything a repository decides about its loop. The engine is the same for every repository; this is
 * read from the repository's own `autopilot.yaml`, again at the start of each iteration.
 */
export type Workflow = {
  /** The schema version the file declared; always {@link WORKFLOW_SCHEMA_VERSION}, since a file of another version is refused. */
  schemaVersion: number;
  prompt: string;
  runDir: string;
  /** Where the next row comes from; exactly one source, chosen by `backlog.source`. */
  backlog: Backlog;
  /**
   * The harness that drives sessions when no flag and no `autopilot use` chose (null: the loop's default),
   * and each harness's own model, effort and executable. A flag or `autopilot use` overrides one field at a time.
   */
  harness: string | null;
  harnesses: Record<string, HarnessSettings>;
  planFollowUp: string | null;
  rules: string[];
  leftover: { rules: LeftoverRule[]; wrappers: WrapperRule[] };
  /** Whether a busy host (load above the cores, tasks stalled for memory) holds a new session back. */
  hostCheck: boolean;
  limitProbe: LimitProbeKind;
  /** The events a watching orchestrator is woken for. */
  wake: EventName[];
  handlers: Handler[];
};

/**
 * The next row is read from a markdown table row that carries `marker` in `file`, or from the first line a
 * `command` prints. In both, nothing found means no row is left, and a source that cannot be read is an error.
 */
export type Backlog =
  | { source: "markdown"; file: string; marker: string }
  | { source: "command"; command: string | string[]; timeoutMs: number };

/**
 * The schema version this autopilot reads, and the only one so far. A file states its own `version`; the
 * key is required, because a file that does not say which schema it is written for cannot be told apart from
 * one written for a later schema that happens to omit it. It changes only when a key is renamed or removed or its
 * meaning changes; a new optional key does not change it.
 */
export const WORKFLOW_SCHEMA_VERSION = 1;

export const DEFAULT_WORKFLOW_FILE = "autopilot.yaml";

const DEFAULT_RUN_DIR_NAME = ".autopilot-run";
const TOP_KEYS = ["version", "prompt", "run_dir", "backlog", "harness", "harnesses", "plan", "rules", "preflight", "limits", "wake", "on"] as const;

/**
 * Reads a workflow over the defaults. A key the loop does not know, a value of the wrong shape or an
 * event it has never emitted is an error that names its path, so a typo never silently runs a default.
 *
 * @example
 * parseWorkflow("version: 1\nbacklog: { marker: '**open ← next' }", "autopilot.yaml").backlog.marker; // "**open ← next"
 */
export function parseWorkflow(source: string, name: string): Workflow {
  const raw = asObject(readYaml(source, name) ?? {}, name);
  onlyKeys(raw, TOP_KEYS, name);
  const schemaVersion = checkedSchemaVersion(raw, name);
  const plan = section(raw, "plan", ["follow_up"], name);
  const preflight = section(raw, "preflight", ["leftover", "wrappers", "host_check"], name);
  const limits = section(raw, "limits", ["probe"], name);
  return {
    schemaVersion,
    prompt: text(raw, "prompt", name, "prompt-execution.md"),
    runDir: text(raw, "run_dir", name, DEFAULT_RUN_DIR_NAME),
    backlog: parseBacklog(raw, name),
    harness: harnessName(raw["harness"] ?? null, `${name}.harness`),
    harnesses: harnessTable(raw, name),
    planFollowUp: optionalText(plan, "follow_up", `${name}.plan`),
    rules: lines(raw, "rules", name),
    leftover: { rules: leftoverRules(preflight, name), wrappers: wrapperRules(preflight, name) },
    hostCheck: bool(preflight, "host_check", `${name}.preflight`, true),
    limitProbe: oneOf(limits, "probe", `${name}.limits`, ["cam", "none"], "none"),
    wake: wakeEvents(raw, name),
    handlers: parseHandlersAt(raw, name),
  };
}

/**
 * The file's `version`, which must be present, an integer, and the one this autopilot reads. Each refusal says
 * what to do: a file from a newer schema needs a newer autopilot, and one with no version needs the key.
 *
 * @example
 * checkedSchemaVersion({ version: 1 }, "autopilot.yaml"); // 1
 */
function checkedSchemaVersion(raw: Obj, name: string): number {
  const where = `${name}.version`;
  const version = raw["version"];
  if (version === undefined) {
    throw new Error(`${name}: version is missing; add "version: ${WORKFLOW_SCHEMA_VERSION}" as the first key (the schema version this autopilot reads)`);
  }
  if (typeof version === "number" && Number.isInteger(version) && version > WORKFLOW_SCHEMA_VERSION) {
    throw new Error(`${where}: ${version} is newer than the schema this autopilot reads (${WORKFLOW_SCHEMA_VERSION}); upgrade autopilot, or write this file for version ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (version !== WORKFLOW_SCHEMA_VERSION) return fail(where, `the integer ${WORKFLOW_SCHEMA_VERSION}`, version);
  return version;
}

function parseHandlersAt(raw: Obj, name: string): Handler[] {
  try {
    return parseHandlers(raw["on"]);
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
}

function section(raw: Obj, key: string, allowed: readonly string[], name: string): Obj {
  const obj = asObject(raw[key] ?? {}, `${name}.${key}`);
  onlyKeys(obj, allowed, `${name}.${key}`);
  return obj;
}

const BACKLOG_KEYS = { markdown: ["file", "marker"], command: ["command", "timeout_seconds"] } as const;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;

/**
 * The `backlog:` section: `source` (default `markdown`) says which keys are meaningful. A key that belongs to
 * the other source is an error that says so, never an override that silently wins.
 */
function parseBacklog(raw: Obj, name: string): Backlog {
  const where = `${name}.backlog`;
  const obj = asObject(raw["backlog"] ?? {}, where);
  const source = oneOf(obj, "source", where, ["markdown", "command"], "markdown");
  const otherSource = source === "markdown" ? "command" : "markdown";
  const stray = BACKLOG_KEYS[otherSource].find((key) => key in obj);
  if (stray !== undefined) {
    throw new Error(`${where}: "${stray}" belongs to source "${otherSource}" but source is "${source}"; set source: ${otherSource}, or remove "${stray}"`);
  }
  onlyKeys(obj, ["source", ...BACKLOG_KEYS[source]], where);
  if (source === "markdown") {
    return { source, file: text(obj, "file", where, "docs/backlog.md"), marker: text(obj, "marker", where, "← next") };
  }
  return { source, command: requiredCommand(obj, where), timeoutMs: positiveSeconds(obj, where) * 1000 };
}

function requiredCommand(obj: Obj, where: string): string | string[] {
  const command = obj["command"];
  if (typeof command === "string" && command !== "") return command;
  if (Array.isArray(command) && command.length > 0 && command.every((word) => typeof word === "string")) return command as string[];
  return fail(`${where}.command`, "a shell text or a non-empty argument list", command);
}

function positiveSeconds(obj: Obj, where: string): number {
  const seconds = number(obj, "timeout_seconds", where, DEFAULT_COMMAND_TIMEOUT_SECONDS);
  return seconds > 0 ? seconds : fail(`${where}.timeout_seconds`, "a number above 0", seconds);
}

function harnessName(value: unknown, where: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && AGENT_NAMES.includes(value)) return value;
  return fail(where, `one of ${AGENT_NAMES.join(", ")}`, value);
}

function harnessTable(raw: Obj, name: string): Record<string, HarnessSettings> {
  const table = asObject(raw["harnesses"] ?? {}, `${name}.harnesses`);
  const settings: Record<string, HarnessSettings> = {};
  for (const [harness, entry] of Object.entries(table)) {
    const where = `${name}.harnesses.${harness}`;
    if (!AGENT_NAMES.includes(harness)) fail(where, `a known harness (${AGENT_NAMES.join(", ")})`, harness);
    const obj = asObject(entry ?? {}, where);
    onlyKeys(obj, ["model", "effort", "command"], where);
    settings[harness] = { model: optionalText(obj, "model", where), effort: optionalText(obj, "effort", where), command: optionalText(obj, "command", where) };
  }
  return settings;
}

function leftoverRules(preflight: Obj, name: string): LeftoverRule[] {
  return list(preflight, "leftover", `${name}.preflight`).map((entry, at) => {
    const where = `${name}.preflight.leftover[${at}]`;
    const obj = asObject(entry, where);
    onlyKeys(obj, ["match", "also_match"], where);
    const also = obj["also_match"];
    return { match: regex(obj["match"], `${where}.match`), alsoMatch: also === undefined ? null : regex(also, `${where}.also_match`) };
  });
}

function wrapperRules(preflight: Obj, name: string): WrapperRule[] {
  return list(preflight, "wrappers", `${name}.preflight`).map((entry, at) => {
    const where = `${name}.preflight.wrappers[${at}]`;
    const obj = asObject(entry, where);
    onlyKeys(obj, ["program", "ignore_args", "hint"], where);
    return { program: text(obj, "program", where, ""), ignoreArgs: lines(obj, "ignore_args", where), hint: optionalText(obj, "hint", where) };
  });
}

function wakeEvents(raw: Obj, name: string): EventName[] {
  if (raw["wake"] === undefined) return defaultWakeEvents();
  return lines(raw, "wake", name).map((event) => {
    if (isEventName(event)) return event;
    return fail(`${name}.wake`, `an event name (${EVENT_NAMES.length} known; see \`autopilot events\`)`, event);
  });
}

/** A workflow file that was asked for and is not there, as opposed to one that is there and does not read. */
export class WorkflowMissingError extends Error {}

/**
 * The run directory a workflow file names, read from the YAML alone. The loop keeps its previous workflow
 * when an edit stops reading, so the operator commands that only need the directory (`stop`, `answer`,
 * `status`) must not fail on the same edit: a stop that needs a valid workflow is out of reach exactly when
 * the workflow was just broken. A file that is not YAML at all has no such answer and throws.
 *
 * @example
 * await runDirNameOf("autopilot.yaml"); // => "scripts/loop/.run", even when `on:` below it has a typo
 */
export async function runDirNameOf(path: string): Promise<string> {
  const raw = readYaml(await readFile(path, "utf8"), path);
  const name = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["run_dir"] : undefined;
  if (name === undefined) return DEFAULT_RUN_DIR_NAME;
  if (typeof name !== "string") throw new Error(`${path}: run_dir must be text, got ${JSON.stringify(name)}`);
  return name;
}

/** Reads the file at `path`. A missing file is the defaults unless the caller named it, since a repository may need no workflow at all. */
export async function loadWorkflow(path: string, required: boolean): Promise<Workflow> {
  try {
    return parseWorkflow(await readFile(path, "utf8"), path);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (missing && !required) return parseWorkflow(`version: ${WORKFLOW_SCHEMA_VERSION}\n`, path);
    if (missing) throw new WorkflowMissingError(`workflow file ${path} does not exist; \`autopilot init\` writes a starter one`);
    throw error;
  }
}
