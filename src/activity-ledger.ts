import { classifyRateLimit, type RateLimitVerdict } from "./rate-limit.ts";
import type { AgentSignal } from "./agent-signal.ts";

export type FinishedShell = {
  command: string;
  exitCode: number | null;
  /** "liveness" when the kernel's process table proved the exit the agent never reported; null when the agent reported it. */
  via: "liveness" | null;
};

type RunningShell = {
  /** The display command the agent reported. */
  command: string;
  /** Every string a spawned process's argv may carry for this shell: the reported command and the command as spawned. */
  candidates: ReadonlySet<string>;
  /** Whether the harness itself backgrounded the call — the only shells the process-liveness probe may rule on. */
  auto: boolean;
};
type RateLimitSignal = Extract<AgentSignal, { type: "rate_limit" }>;

/**
 * What the agent has running that outlives its turn, rebuilt from its
 * signals. The loop asks this, never a clock, whether work is still running: a
 * test suite that is silent for ten minutes still has its background shell.
 * Foreground tool calls are not tracked: the agent waits for them before it
 * ends a turn, and a tool blocked by a hook arrives already failed and never
 * reports again, so counting open tool calls would wait for work that is gone.
 *
 * @example
 * ledger.apply({ type: "background_started", shellId: "b1", toolCallId: "t1", command: "./gradlew testDebugUnitTest", rawCommand: null, auto: true, outputPath: "/x/b1.output" });
 * ledger.isWorking(); // true until the matching background_exited arrives
 */
export class ActivityLedger {
  mode = "";
  proposedPlan: string | null = null;
  /** Set by the loop when it declines the plan exit itself, so the cancelled stop that follows reads as an approval. */
  planDeclined = false;
  /** When the agent last sent any frame at all, in clock milliseconds. */
  lastFrameAtMs = 0;
  private rateLimit: RateLimitSignal | null = null;
  private readonly runningShells = new Map<string, RunningShell>();
  private finishedShells: FinishedShell[] = [];
  private messageText = "";
  private idleWaiters: Array<() => void> = [];

  /**
   * Folds one signal into the ledger. Returns whether it told us something new
   * about modes or background shells, the facts the journal records: the
   * adapter repeats a mode change in several frames.
   */
  apply(signal: AgentSignal): boolean {
    const news = this.isNews(signal);
    this.fold(signal);
    if (!this.isWorking()) this.releaseIdleWaiters();
    return news;
  }

  private isNews(signal: AgentSignal): boolean {
    if (signal.type === "mode_changed") return signal.mode !== this.mode;
    if (signal.type === "background_started") {
      return !this.runningShells.has(signal.shellId);
    }
    if (signal.type === "background_exited") {
      return this.runningShells.has(signal.shellId);
    }
    return false;
  }

  private fold(signal: AgentSignal): void {
    switch (signal.type) {
      case "background_started":
        this.runningShells.set(signal.shellId, {
          command: signal.command,
          candidates: new Set(
            [signal.command, signal.rawCommand].filter(
              (word): word is string => typeof word === "string" && word !== "",
            ),
          ),
          auto: signal.auto,
        });
        break;
      case "background_exited":
        this.finishShell(signal.shellId, signal.exitCode, signal.via ?? null);
        break;
      case "agent_message":
        this.messageText += signal.text;
        break;
      case "mode_changed":
        this.mode = signal.mode;
        break;
      case "rate_limit":
        this.rateLimit = signal.status === "rejected" ? signal : null;
        break;
      case "plan_proposed":
        this.proposedPlan = signal.plan;
        break;
      default:
        break;
    }
  }

  isWorking(): boolean {
    return this.runningShells.size > 0;
  }

  /** Resolves as soon as no background shell is running. */
  whenIdle(): Promise<void> {
    if (!this.isWorking()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  runningCommands(): string[] {
    return [...this.runningShells.values()].map((shell) => shell.command);
  }

  /**
   * Auto-backgrounded shells none of whose commands appears in the live argv
   * set. Only `auto` shells are ruled on: they started as a child of the agent
   * process before the harness backgrounded them, so absence from its
   * descendant tree can only mean exit. A shell with no candidate strings is
   * never ruled dead — nothing about it is proven.
   */
  deadShellIds(liveArgv: ReadonlySet<string>): string[] {
    const dead: string[] = [];
    for (const [shellId, shell] of this.runningShells) {
      if (!shell.auto || shell.candidates.size === 0) continue;
      if ([...shell.candidates].some((word) => liveArgv.has(word))) continue;
      dead.push(shellId);
    }
    return dead;
  }

  /**
   * Whether a command exited that the agent has not been told about. The loop
   * reads a stop with nothing running and nothing committed as an idle agent;
   * with this true the agent is more likely waiting for that exit, which can
   * land milliseconds before the stop.
   */
  hasUnreportedExit(): boolean {
    return this.finishedShells.length > 0;
  }

  /** Background commands that exited since the last call, each reported once. */
  drainFinishedShells(): FinishedShell[] {
    const finished = this.finishedShells;
    this.finishedShells = [];
    return finished;
  }

  /** The agent's words since the last prompt: the orchestrator reads them to judge a stop. */
  lastMessage(): string {
    return this.messageText.trim();
  }

  /** What a rejected rate-limit reading in this turn asks the loop to do, or null. */
  rateLimitVerdict(): RateLimitVerdict | null {
    return this.rateLimit ? classifyRateLimit(this.rateLimit) : null;
  }

  startTurn(): void {
    this.messageText = "";
    this.rateLimit = null;
  }

  private finishShell(
    shellId: string,
    exitCode: number | null,
    via: "liveness" | null,
  ): void {
    const shell = this.runningShells.get(shellId);
    if (shell === undefined) return;
    this.runningShells.delete(shellId);
    this.finishedShells.push({ command: shell.command, exitCode, via });
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const release of waiters) release();
  }
}
