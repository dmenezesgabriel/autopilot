import type { LoopEvent } from "./mailbox.ts";

export type SignalJournalDeps = {
  on(signal: NodeJS.Signals, handler: () => void): void;
  emit(event: LoopEvent): Promise<void>;
  release(): Promise<void>;
  exit(code: number): void;
};

const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * Writes the signal that ends the loop into the journal before it exits. Four of the fifteen
 * interrupted iterations died with no trace at all; with this a shutdown or a service stop shows as
 * `loop_signalled`, and a death with no such line was a kill that cannot be caught. Exit code 0: a
 * stop someone asked for is not a failure, so a service manager does not restart it.
 */
export function journalSignals(deps: SignalJournalDeps): void {
  for (const signal of SIGNALS) {
    deps.on(signal, () => {
      void deps
        .emit({ type: "loop_signalled", signal })
        .then(() => deps.release())
        .finally(() => deps.exit(0));
    });
  }
}
