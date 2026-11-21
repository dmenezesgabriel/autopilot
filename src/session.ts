import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ActivityLedger } from "./activity-ledger.ts";
import {
  AcpAgent,
  ModelSelectionError,
  type AgentHandlers,
  type PromptBlock,
} from "./acp-agent.ts";
import type { AgentChoice } from "./agent-choice.ts";
import type { AgentProfile } from "./agent-profile.ts";
import { profileFor } from "./agents/index.ts";
import { BackgroundExitWatcher, fileTaskOutputs } from "./background-exit-watcher.ts";
import { systemClock } from "./clock.ts";
import { buildHandlers } from "./handlers.ts";
import { runIteration, type IterationOutcome } from "./iteration.ts";
import { RpcError } from "./json-rpc.ts";
import { limitProbeFor } from "./limit-probe.ts";
import { planFollowUpOf, promptFileOf, type LoopContext } from "./loop-context.ts";
import { liveArgvOf, nodeProcfs } from "./proc-tree.ts";
import { spawnAcpAgent, type SpawnedAgent } from "./spawn-agent.ts";

const BACKGROUND_POLL_MS = 10_000;

/** What one session runs on: the agent's profile and executable, and the model and effort asked of it. */
export type SessionChoice = {
  profile: AgentProfile;
  command: string;
  model: string | null;
  effort: string | null;
};

/**
 * The executable a harness starts: the `--agent-command` flag when it was given for this harness, else the
 * workflow's `harnesses.<name>.command`, else the harness's own, found on PATH.
 *
 * @example
 * commandFor("devin", null, { devin: { model: null, effort: null, command: "/opt/devin" } }, "devin"); // "/opt/devin"
 */
export function commandFor(
  harness: string,
  flagged: { agent: string; command: string } | null,
  harnesses: Readonly<Record<string, { command: string | null }>>,
  fallback: string,
): string {
  if (flagged !== null && flagged.agent === harness) return flagged.command;
  return harnesses[harness]?.command ?? fallback;
}

export function sessionChoice(context: LoopContext, choice: AgentChoice): SessionChoice {
  const profile = profileFor(choice.agent);
  return {
    profile,
    command: commandFor(profile.name, context.commandOverride, context.workflow.harnesses, profile.defaultCommand),
    model: choice.model,
    effort: choice.effort,
  };
}

/**
 * The prompt file attached, then the workflow's standing rules. The rules are a block of their own so a
 * session hears them as an instruction, not as part of the file; with none configured there is no block.
 */
export async function openingPrompt(
  promptFile: string,
  standingRules: string[],
): Promise<PromptBlock[]> {
  const text = await readFile(promptFile, "utf8");
  const blocks: PromptBlock[] = [
    {
      type: "resource",
      resource: {
        uri: `file://${promptFile}`,
        mimeType: "text/markdown",
        text,
      },
    },
    { type: "text", text: `Follow ${basename(promptFile)} (attached).` },
  ];
  if (standingRules.length > 0) {
    blocks.push({ type: "text", text: standingRules.join("\n") });
  }
  return blocks;
}

type Session = {
  spawned: SpawnedAgent;
  ledger: ActivityLedger;
  watcher: BackgroundExitWatcher;
  agent: AcpAgent;
  probeShellExits: (() => Promise<void>) | null;
};

/**
 * Starts the agent and wires its callbacks. An agent that reports no exit for
 * a background command (Claude) names the file the output goes to, so the
 * watcher reads it and feeds the exit back through the same handler a frame
 * would have used.
 */
function openSession(context: LoopContext, choice: SessionChoice): Session {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const spawned = spawnAcpAgent(
    context.repoRoot,
    join(context.runDir.path, `acp-${stamp}.jsonl`),
    choice.command,
    choice.profile.launchArgs,
  );
  const ledger = new ActivityLedger();
  const handlers = buildHandlers({
    ledger,
    clock: systemClock,
    emit: context.emit,
    askQuestions: (questions) => context.mailbox.askQuestions(questions),
    watchBackground: (shellId, outputPath) =>
      watcher.watch(shellId, outputPath),
    declinePlanExit: planFollowUpOf(context) !== null,
    exitPlan: choice.profile.exitPlan,
  });
  const watcher = new BackgroundExitWatcher(
    systemClock,
    fileTaskOutputs,
    (shellId, exitCode) =>
      handlers.onSignal({ type: "background_exited", shellId, exitCode }),
    (shellId, error) =>
      void context.emit({
        type: "background_watch_error",
        shellId,
        error: error.message,
      }),
    BACKGROUND_POLL_MS,
  );
  const agent = new AcpAgent(
    spawned.channel,
    handlers,
    choice.profile.createDialect(),
  );
  return {
    spawned,
    ledger,
    watcher,
    agent,
    probeShellExits: choice.profile.probesShellLiveness
      ? () => probeShellExits(spawned, ledger, handlers)
      : null,
  };
}

/**
 * An auto-backgrounded shell started life as a `bash -c` child of the agent
 * process, so when the agent reports no exit but the shell's command appears
 * in no descendant argv, the kernel has already recorded the exit the wire
 * lost. `null` from the probe means the tree could not be read and nothing is
 * inferred.
 */
async function probeShellExits(
  spawned: SpawnedAgent,
  ledger: ActivityLedger,
  handlers: AgentHandlers,
): Promise<void> {
  if (spawned.pid === undefined) return;
  const argv = await liveArgvOf(spawned.pid, nodeProcfs);
  if (argv === null) return;
  for (const shellId of ledger.deadShellIds(argv)) {
    handlers.onSignal({
      type: "background_exited",
      shellId,
      exitCode: null,
      via: "liveness",
    });
  }
}

async function driveSession(
  context: LoopContext,
  choice: SessionChoice,
  { agent, ledger, probeShellExits }: Session,
): Promise<IterationOutcome> {
  await agent.initialize();
  const sessionId = await agent.newSession(context.repoRoot);
  const model =
    choice.model === null
      ? agent.currentModel()
      : await agent.selectModel(choice.model);
  const effort =
    choice.effort === null
      ? agent.currentEffort()
      : await agent.selectEffort(choice.effort);
  await context.emit({
    type: "session_started",
    sessionId,
    agent: choice.profile.name,
    model,
    effort,
  });
  return runIteration({
    agent,
    ledger,
    git: context.git,
    clock: systemClock,
    askReply: (why, last) => context.mailbox.askReply(why, last),
    emit: context.emit,
    openingPrompt: await openingPrompt(
      promptFileOf(context),
      context.workflow.rules,
    ),
    planFollowUp: planFollowUpOf(context),
    timing: choice.profile.timing,
    bypassMode: choice.profile.bypassMode,
    classifyError: choice.profile.classifyError,
    limitProbe: choice.profile.usesClaudeAccounts
      ? limitProbeFor(context.workflow.limitProbe)
      : null,
    probeShellExits,
    yieldOnLimit: (wakeAt) =>
      context.engine.yieldReason({ type: "rate_limited", wakeAt }),
  });
}

export async function runSession(
  context: LoopContext,
  choice: SessionChoice,
): Promise<IterationOutcome> {
  const session = openSession(context, choice);
  try {
    return await driveSession(context, choice, session);
  } catch (error) {
    if (error instanceof RpcError) {
      return {
        kind: "halted",
        reason: `session setup failed: ${error.message}`,
      };
    }
    if (error instanceof ModelSelectionError) {
      return { kind: "halted", reason: error.message };
    }
    throw error;
  } finally {
    session.watcher.stopAll();
    await session.spawned.stop();
  }
}

