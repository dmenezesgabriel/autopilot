import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoopEvent } from "./mailbox.ts";
import { journalSignals, type SignalJournalDeps } from "./signal-journal.ts";

function harness() {
  const handlers = new Map<string, () => void>();
  const log: string[] = [];
  const deps: SignalJournalDeps = {
    on: (signal, handler) => handlers.set(signal, handler),
    emit: async (event: LoopEvent) => {
      log.push(`emit ${event.type} ${String(event["signal"])}`);
    },
    release: async () => {
      log.push("release");
    },
    exit: (code) => {
      log.push(`exit ${code}`);
    },
  };
  return { handlers, log, deps };
}

describe("journalSignals", () => {
  it("listens for the signals that end a loop run by a shell, a terminal or a service", () => {
    const { handlers, deps } = harness();

    journalSignals(deps);

    assert.deepEqual([...handlers.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM"]);
  });

  it("journals the signal, releases the lock, then exits cleanly, in that order", async () => {
    const { handlers, log, deps } = harness();
    journalSignals(deps);

    handlers.get("SIGTERM")?.();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(log, ["emit loop_signalled SIGTERM", "release", "exit 0"]);
  });
});
