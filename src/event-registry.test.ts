import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { defaultWakeEvents, EVENT_NAMES, EVENTS, isEventName } from "./event-registry.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

/** `type: "x"` strings in the source that name an agent signal, a schema, or the one line printed to stderr when the loop crashes before it has a journal. */
const NOT_EVENTS: ReadonlySet<string> = new Set([
  "agent_message", "agent_stopped", "array", "background_task_id", "loop_crashed", "object", "plan_proposed",
  "rate_limit", "resource", "string", "text", "tool_command", "tool_finished", "tool_output",
  "tool_started", "vendor",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/testing/") ? [path] : [];
  });
}

const SOURCE = sourceFiles(SRC).map((path) => readFileSync(path, "utf8")).join("\n");

describe("the event registry", () => {
  it("lists every event type the code emits, so a workflow can name it and `autopilot events` shows it", () => {
    const emitted = [...SOURCE.matchAll(/\btype: "([a-z_]+)"/g)].map((match) => match[1] as string);

    const unregistered = [...new Set(emitted)].filter((name) => !NOT_EVENTS.has(name) && !isEventName(name));

    assert.deepEqual(unregistered, [], "emitted but not in EVENTS (or NOT_EVENTS if it is a signal)");
  });

  it("lists no event that nothing emits", () => {
    const generated = (name: string): boolean => name.startsWith("iteration_") || name === "backlog_exhausted" || name === "stop";

    const dead = EVENT_NAMES.filter((name) => !generated(name) && !SOURCE.includes(`"${name}"`));

    assert.deepEqual(dead, []);
  });

  it("wakes an orchestrator for decisions and escalations, not for reports the loop can make itself", () => {
    const wake = defaultWakeEvents();

    assert.ok(wake.includes("needs_answer") && wake.includes("needs_reply"));
    assert.ok(wake.includes("loop_halted") && wake.includes("possibly_hung"));
    assert.equal(wake.includes("iteration_done"), false);
    assert.equal(wake.includes("permission_requested"), false);
  });

  it("gives every event a meaning", () => {
    for (const name of EVENT_NAMES) assert.ok(EVENTS[name].means.length > 10, name);
  });
});
