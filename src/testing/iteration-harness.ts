import type { ReplyReason, StopReason } from "../decide.ts";
import { ActivityLedger } from "../activity-ledger.ts";
import { CLAUDE_PROFILE } from "../agents/claude/profile.ts";
import type { IterationDeps, IterationTiming } from "../iteration.ts";
import type { LoopEvent } from "../mailbox.ts";
import { FakeAgentSession, FakeGit } from "./fake-agent-session.ts";
import { CallRecorder } from "./call-recorder.ts";
import { FakeClock } from "./fake-mailbox.ts";

export const TIMING: IterationTiming = {
  possiblyHungAfterMs: 45 * 60_000,
  cancelAfterSilenceMs: 3 * 60 * 60_000,
  backgroundCeilingMs: 3 * 60 * 60_000,
  backgroundLivenessProbeMs: 60_000,
  limitPollMs: 30 * 60_000,
  limitProbeMs: 60_000,
  limitMarginMs: 60_000,
  watchEveryMs: 60_000,
};

export function build(turnsFor: (parts: Parts) => Array<() => StopReason>) {
  const ledger = new ActivityLedger();
  const clock = new FakeClock();
  const git = new FakeGit();
  const events: LoopEvent[] = [];
  const parts: Parts = { ledger, clock, git, events };
  const agent = new FakeAgentSession(turnsFor(parts));
  const askReply = CallRecorder.resolving<[ReplyReason, string], string>(
    "Use the existing helper.",
  );
  const deps: IterationDeps = {
    agent,
    ledger,
    git,
    clock,
    askReply: askReply.fn,
    emit: async (event) => {
      events.push(event);
    },
    openingPrompt: [{ type: "text", text: "run the task" }],
    planFollowUp: null,
    timing: TIMING,
    bypassMode: CLAUDE_PROFILE.bypassMode,
    classifyError: CLAUDE_PROFILE.classifyError,
    limitProbe: null,
    probeShellExits: null,
    yieldOnLimit: () => null,
  };
  return { deps, agent, ...parts, askReply };
}

export type Parts = {
  ledger: ActivityLedger;
  clock: FakeClock;
  git: FakeGit;
  events: LoopEvent[];
};

/** The agent leaves plan mode and commits, as the happy path does. */
export const commitsInBypass =
  ({ ledger, git }: Parts, sha = "bbb222"): (() => StopReason) =>
  () => {
    ledger.apply({ type: "mode_changed", mode: "bypass" });
    git.headSha = sha;
    return "end_turn";
  };
