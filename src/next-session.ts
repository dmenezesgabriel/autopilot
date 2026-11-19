import { describeChoice, resolveChoice, type ChoiceOverride, type HarnessDefaults } from "./agent-choice.ts";
import { AGENT_NAMES, DEFAULT_AGENT } from "./agents/index.ts";
import type { RunDir } from "./run-dir.ts";

/** What an override says, field by field, for a person: "harness devin, model swe-2-high". */
export function describeOverride(override: ChoiceOverride): string {
  const said = [
    override.agent && `harness ${override.agent}`,
    override.model && `model ${override.model}`,
    override.effort && `effort ${override.effort}`,
  ].filter(Boolean);
  return said.length === 0 ? "nothing" : said.join(", ");
}

/**
 * What the next session will run on, worked out the way the loop works it out between iterations: the
 * workflow as it is now plus `choice.json` as it is now, through the same `resolveChoice`. The journal
 * cannot answer this, because it only records what earlier sessions ran on, and an `autopilot use` or an
 * edit to the workflow made since then is in no event until the next iteration begins. A file the loop
 * would refuse is said so, because the loop then keeps its current choice.
 *
 * @example
 * await describeNextSession(runDir, workflow);
 * // => ["next session: devin, model swe-2-high, effort default",
 * //     "  override in choice.json (harness devin, model swe-2-high); `autopilot use --reset` returns it to the workflow"]
 */
export async function describeNextSession(runDir: RunDir, workflow: HarnessDefaults): Promise<string[]> {
  let override: ChoiceOverride | null;
  try {
    override = await runDir.readChoice();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [`next session: the current choice stays, because ${reason}`];
  }
  const choice = resolveChoice(override, workflow, DEFAULT_AGENT);
  if (!AGENT_NAMES.includes(choice.agent)) {
    return [`next session: the current choice stays, because harness "${choice.agent}" is not one of ${AGENT_NAMES.join(", ")}`];
  }
  const source = override === null ? " (from the workflow)" : "";
  const lines = [`next session: ${describeChoice(choice)}${source}`];
  if (override !== null) {
    lines.push(`  override in choice.json (${describeOverride(override)}); \`autopilot use --reset\` returns it to the workflow`);
  }
  return lines;
}
