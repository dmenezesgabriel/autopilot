import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeChoice,
  parseChoiceFile,
  refreshChoice,
  resolveChoice,
  sameChoice,
  type AgentChoice,
  type ChoiceOverride,
  type HarnessDefaults,
} from "./agent-choice.ts";
import type { LoopEvent } from "./mailbox.ts";

const CLAUDE: AgentChoice = { agent: "claude", model: null, effort: null };
const DEVIN_HIGH: AgentChoice = { agent: "devin", model: "swe-2-high", effort: "high" };

/** A workflow that names a harness and settings for both. */
const WORKFLOW: HarnessDefaults = {
  harness: "claude",
  harnesses: {
    claude: { model: "sonnet", effort: "high", command: null },
    devin: { model: "swe-2-high", effort: null, command: null },
  },
};
const NONE: HarnessDefaults = { harness: null, harnesses: {} };
const say = (partial: Partial<ChoiceOverride>): ChoiceOverride => ({ agent: null, model: null, effort: null, ...partial });

describe("sameChoice", () => {
  it("is true only when the agent, the model and the effort all agree", () => {
    assert.equal(sameChoice(DEVIN_HIGH, { ...DEVIN_HIGH }), true);
    assert.equal(sameChoice(DEVIN_HIGH, { ...DEVIN_HIGH, effort: null }), false);
    assert.equal(sameChoice(DEVIN_HIGH, { ...DEVIN_HIGH, model: "x" }), false);
    assert.equal(sameChoice(CLAUDE, DEVIN_HIGH), false);
  });
});

describe("describeChoice", () => {
  it("names the harness, then the model and effort, or default where none is named", () => {
    assert.equal(describeChoice(DEVIN_HIGH), "devin, model swe-2-high, effort high");
    assert.equal(describeChoice(CLAUDE), "claude, model default, effort default");
  });
});

describe("resolveChoice", () => {
  it("takes everything from the workflow when nothing was said on purpose", () => {
    assert.deepEqual(resolveChoice(null, WORKFLOW, "claude"), { agent: "claude", model: "sonnet", effort: "high" });
  });

  it("lets a flag or `use` override one field and leaves the others to the workflow", () => {
    assert.deepEqual(resolveChoice(say({ model: "haiku" }), WORKFLOW, "claude"), { agent: "claude", model: "haiku", effort: "high" });
    assert.deepEqual(resolveChoice(say({ effort: "low" }), WORKFLOW, "claude"), { agent: "claude", model: "sonnet", effort: "low" });
  });

  it("takes the model and effort of the harness in use, so switching harness never carries a model across", () => {
    assert.deepEqual(resolveChoice(say({ agent: "devin" }), WORKFLOW, "claude"), { agent: "devin", model: "swe-2-high", effort: null });
    assert.deepEqual(resolveChoice(say({ agent: "claude" }), { ...WORKFLOW, harness: "devin" }, "claude"), { agent: "claude", model: "sonnet", effort: "high" });
  });

  it("falls back to the loop's default harness, and to the harness's own default model, when the workflow says nothing", () => {
    assert.deepEqual(resolveChoice(null, NONE, "claude"), CLAUDE);
    assert.deepEqual(resolveChoice(say({ agent: "devin" }), NONE, "claude"), { agent: "devin", model: null, effort: null });
  });

  it("applies a workflow edit at once, since nothing stale stands between it and the choice", () => {
    const before = resolveChoice(null, WORKFLOW, "claude");
    const edited = { ...WORKFLOW, harnesses: { ...WORKFLOW.harnesses, claude: { model: "opus", effort: "high", command: null } } };

    assert.equal(before.model, "sonnet");
    assert.equal(resolveChoice(null, edited, "claude").model, "opus");
  });
});

describe("parseChoiceFile", () => {
  it("reads the three fields back as `use` wrote them", () => {
    assert.deepEqual(parseChoiceFile(JSON.stringify(DEVIN_HIGH), "/run/choice.json"), DEVIN_HIGH);
  });

  it("reads an absent field as not said, whichever it is", () => {
    assert.deepEqual(parseChoiceFile('{"agent":"claude"}', "/run/choice.json"), CLAUDE);
    assert.deepEqual(parseChoiceFile('{"model":"x"}', "/run/choice.json"), say({ model: "x" }));
    assert.deepEqual(parseChoiceFile("{}", "/run/choice.json"), say({}));
  });

  it("refuses text that is not JSON, naming the file and what it should hold", () => {
    assert.throws(
      () => parseChoiceFile("{half a wri", "/run/choice.json"),
      (error: Error) => error.message.includes("/run/choice.json") && error.message.includes('{"agent": "<name>"'),
    );
  });

  it("refuses a field that is not text, quoting the offending value", () => {
    assert.throws(() => parseChoiceFile('{"agent":"claude","model":7}', "/run/choice.json"), (error: Error) => error.message.includes('"model":7'));
    assert.throws(() => parseChoiceFile('{"agent":3}', "/run/choice.json"), (error: Error) => error.message.includes("agent that is not text"));
  });
});

function refresher(read: () => Promise<ChoiceOverride | null>, defaults: HarnessDefaults = NONE) {
  const events: LoopEvent[] = [];
  const deps = {
    read,
    resolve: (override: ChoiceOverride | null) => resolveChoice(override, defaults, "claude"),
    emit: async (event: LoopEvent) => {
      events.push(event);
    },
    knowsAgent: (name: string) => name === "claude" || name === "devin",
  };
  return { deps, events };
}

describe("refreshChoice", () => {
  it("keeps the choice and says nothing when the file is absent or adds up to the same", async () => {
    const absent = refresher(async () => null);
    const same = refresher(async () => ({ ...CLAUDE }));

    assert.deepEqual(await refreshChoice(absent.deps, CLAUDE), CLAUDE);
    assert.deepEqual(await refreshChoice(same.deps, CLAUDE), CLAUDE);
    assert.deepEqual([...absent.events, ...same.events], []);
  });

  it("takes a changed choice and journals the one it leaves and the one it takes", async () => {
    const { deps, events } = refresher(async () => DEVIN_HIGH);

    const taken = await refreshChoice(deps, CLAUDE);

    assert.deepEqual(taken, DEVIN_HIGH);
    assert.deepEqual(events, [{ type: "agent_choice_changed", from: CLAUDE, to: DEVIN_HIGH }]);
  });

  it("follows an edit to the workflow when no override is in the way, and a reset hands control back to it", async () => {
    const edited: HarnessDefaults = { harness: "devin", harnesses: { devin: { model: "swe-2-high", effort: "high", command: null } } };
    const { deps, events } = refresher(async () => null, edited);

    const taken = await refreshChoice(deps, CLAUDE);

    assert.deepEqual(taken, DEVIN_HIGH);
    assert.equal(events.length, 1);
  });

  it("keeps an override over the workflow until it is reset", async () => {
    const { deps } = refresher(async () => say({ model: "haiku" }), WORKFLOW);

    const taken = await refreshChoice(deps, { agent: "claude", model: "sonnet", effort: "high" });

    assert.deepEqual(taken, { agent: "claude", model: "haiku", effort: "high" });
  });

  it("keeps the current choice and journals why when the file names a harness the loop does not know", async () => {
    const { deps, events } = refresher(async () => say({ agent: "gemini" }));

    const kept = await refreshChoice(deps, DEVIN_HIGH);

    assert.deepEqual(kept, DEVIN_HIGH);
    assert.deepEqual(events, [{ type: "agent_choice_invalid", error: 'unknown harness "gemini" in the choice file' }]);
  });

  it("keeps the current choice and journals the reason when the file cannot be read", async () => {
    const { deps, events } = refresher(async () => {
      throw new Error("choice file /run/choice.json is not valid JSON");
    });

    const kept = await refreshChoice(deps, CLAUDE);

    assert.deepEqual(kept, CLAUDE);
    assert.deepEqual(events, [{ type: "agent_choice_invalid", error: "choice file /run/choice.json is not valid JSON" }]);
  });
});
