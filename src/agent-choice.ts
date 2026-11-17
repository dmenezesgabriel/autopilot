import type { LoopEvent } from "./mailbox.ts";

/**
 * Which harness (the agent program the loop drives) runs a session, on which model and at which effort.
 * A null model or effort leaves that setting on the harness's own default.
 */
export type AgentChoice = {
  agent: string;
  model: string | null;
  effort: string | null;
};

/**
 * What an operator said on purpose: the flags of `run` or `autopilot use`, kept in `choice.json`. Each
 * field is its own instruction; a null one says nothing, and the workflow answers it instead.
 */
export type ChoiceOverride = {
  agent: string | null;
  model: string | null;
  effort: string | null;
};

/** What a workflow's `harnesses:` table says about one harness. */
export type HarnessSettings = {
  model: string | null;
  effort: string | null;
  command: string | null;
};

/** The part of a workflow that picks a harness: which one by default, and each one's own settings. */
export type HarnessDefaults = {
  harness: string | null;
  harnesses: Readonly<Record<string, HarnessSettings>>;
};

const FILE_SHAPE =
  '{"agent": "<name>" | null, "model": "<id>" | null, "effort": "<value>" | null}';

export function sameChoice(left: AgentChoice, right: AgentChoice): boolean {
  return (
    left.agent === right.agent &&
    left.model === right.model &&
    left.effort === right.effort
  );
}

/**
 * One line for a person: the harness, then the model and effort or "default" where none is named.
 *
 * @example
 * describeChoice({ agent: "devin", model: "swe-2-high", effort: null });
 * // => "devin, model swe-2-high, effort default"
 */
export function describeChoice(choice: AgentChoice): string {
  const model = choice.model ?? "default";
  const effort = choice.effort ?? "default";
  return `${choice.agent}, model ${model}, effort ${effort}`;
}

/**
 * The choice a session runs on, one field at a time: the operator's override, then the workflow's
 * settings for the harness in use, then the harness's own default (null). The workflow's model and effort
 * are those of the harness they sit under, so an override that switches harness never carries a model
 * across to one that does not offer it.
 *
 * @example
 * resolveChoice({ agent: null, model: "haiku", effort: null }, { harness: "claude", harnesses: { claude: { model: "sonnet", effort: "high", command: null } } }, "claude");
 * // => { agent: "claude", model: "haiku", effort: "high" }
 */
export function resolveChoice(
  override: ChoiceOverride | null,
  defaults: HarnessDefaults,
  fallbackHarness: string,
): AgentChoice {
  const agent = override?.agent ?? defaults.harness ?? fallbackHarness;
  const settings = defaults.harnesses[agent];
  return {
    agent,
    model: override?.model ?? settings?.model ?? null,
    effort: override?.effort ?? settings?.effort ?? null,
  };
}

function textOrNull(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * The override a `choice.json` holds. A half-written or hand-edited file is refused with its path and
 * the shape it should have, because the loop reads it between iterations and must not guess. A file
 * written before the workflow could choose a harness names an agent, and still reads.
 *
 * @example
 * parseChoiceFile('{"agent":"devin","model":"swe-2-high"}', "/run/choice.json");
 * // => { agent: "devin", model: "swe-2-high", effort: null }
 */
export function parseChoiceFile(text: string, path: string): ChoiceOverride {
  const refusal = (why: string): Error =>
    new Error(`choice file ${path} ${why}: expected ${FILE_SHAPE}, got ${text}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refusal("is not valid JSON");
  }
  const fields = (parsed ?? {}) as Record<string, unknown>;
  const agent = textOrNull(fields["agent"]);
  const model = textOrNull(fields["model"]);
  const effort = textOrNull(fields["effort"]);
  if (agent === undefined) throw refusal("has an agent that is not text");
  if (model === undefined) throw refusal("has a model that is not text");
  if (effort === undefined) throw refusal("has an effort that is not text");
  return { agent, model, effort };
}

export type RefreshDeps = {
  /** The choice file's content, null when absent; throws when it cannot be read as a choice. */
  read(): Promise<ChoiceOverride | null>;
  /** What the override and the workflow, as they are now, add up to. */
  resolve(override: ChoiceOverride | null): AgentChoice;
  emit(event: LoopEvent): Promise<void>;
  knowsAgent(name: string): boolean;
};

/**
 * The choice the next session uses, worked out between iterations so `autopilot use`, an edit to the
 * workflow and a reset all take effect without a restart and never inside a running session. An unreadable
 * file or an unknown harness keeps the current choice and is journaled: a typo must not stop a loop that
 * is working.
 */
export async function refreshChoice(
  deps: RefreshDeps,
  current: AgentChoice,
): Promise<AgentChoice> {
  try {
    const wanted = deps.resolve(await deps.read());
    if (sameChoice(wanted, current)) return current;
    if (!deps.knowsAgent(wanted.agent)) {
      throw new Error(`unknown harness "${wanted.agent}" in the choice file`);
    }
    await deps.emit({ type: "agent_choice_changed", from: current, to: wanted });
    return wanted;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await deps.emit({ type: "agent_choice_invalid", error: reason });
    return current;
  }
}
