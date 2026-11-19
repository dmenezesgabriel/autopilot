import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { systemClock } from "./clock.ts";
import { AGENT_NAMES, DEFAULT_AGENT, profileFor } from "./agents/index.ts";
import {
  refreshChoice,
  resolveChoice,
  type AgentChoice,
  type ChoiceOverride,
  type RefreshDeps,
} from "./agent-choice.ts";
import { readNextRow, type BacklogPorts } from "./backlog-source.ts";
import { captureFirstLine, runCommand } from "./command-runner.ts";
import { requiredValue } from "./flags.ts";
import { GitCli } from "./git-probe.ts";
import { DEFAULT_TIMING, DirectoryMailboxFiles, Mailbox, nextAskNumber } from "./mailbox.ts";
import { planFollowUpOf, type LoopContext } from "./loop-context.ts";
import {
  readHostReadings,
  readProcEntries,
  waitUntilReady,
  type PreflightDeps,
} from "./preflight.ts";
import { ProgressTracker } from "./progress.ts";
import { RunDir, isProcessAlive } from "./run-dir.ts";
import { journalSignals } from "./signal-journal.ts";
import { summarizeJournal } from "./journal-summary.ts";
import { sessionChoice, runSession } from "./session.ts";
import { isEntryPoint } from "./entry-point.ts";
import { DEFAULT_WORKFLOW_FILE, loadWorkflow } from "./workflow.ts";
import { WorkflowEngine } from "./workflow-engine.ts";
import { WorkflowMailboxFiles } from "./workflow-hook.ts";

const MINUTE = 60_000;

/**
 * Flags: `--repo <dir>` (default: cwd), `--workflow <file>` (default: autopilot.yaml in the repo,
 * optional; a file named here must exist), `--run-dir <dir>` and `--prompt <file>` (each outranks the
 * workflow, which outranks the default), `--harness <name>` (`--agent` is the same flag), `--model <id>`, `--effort <value>` and
 * `--agent-command <path>` (each outranks the workflow's `harness` and `harnesses`, one field at a time;
 * given any of the first three the loop writes them to `choice.json`, where `autopilot use` also writes
 * and where `use --reset` removes them),  * `--plan-follow-up <command>` (outranks the workflow; default: none).
 */
export function parseArguments(argv: string[], cwd: string) {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const repoRoot = resolve(flag("--repo") ?? cwd);
  const harness = harnessFlag(argv);
  const prompt = flag("--prompt");
  const runDir = flag("--run-dir");
  return {
    repoRoot,
    workflowPath: resolve(repoRoot, flag("--workflow") ?? DEFAULT_WORKFLOW_FILE),
    workflowRequired: argv.includes("--workflow"),
    runDir: runDir === undefined ? null : resolve(runDir),
    promptFile: prompt === undefined ? null : resolve(repoRoot, prompt),
    harness,
    agentCommand: flag("--agent-command") ?? null,
    model: requiredValue(argv, "--model", "a model id the harness offers"),
    effort: requiredValue(argv, "--effort", "an effort the harness offers"),
    planFollowUp: requiredValue(
      argv,
      "--plan-follow-up",
      'a command such as "/engineering-mode"',
    ),
  };
}

/** The harness a flag names (`--harness`, or its older spelling `--agent`); null when neither is given. A flag with no value is refused, since guessing would run the wrong harness. */
function harnessFlag(argv: string[]): string | null {
  const at = argv.findIndex((word) => word === "--harness" || word === "--agent");
  return at === -1 ? null : profileFor(argv[at + 1]).name;
}

/** The override the flags make; null when none of them chooses. A flag overrides the workflow for the field it names only. */
export function overrideFromFlags(args: { harness: string | null; model: string | null; effort: string | null }): ChoiceOverride | null {
  if (args.harness === null && args.model === null && args.effort === null) return null;
  return { agent: args.harness, model: args.model, effort: args.effort };
}

const backlogPorts: BacklogPorts = {
  readText: (path) =>
    readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  firstLine: captureFirstLine,
};

function choiceDeps(context: LoopContext): RefreshDeps {
  return {
    read: () => context.runDir.readChoice(),
    resolve: (override) => resolveChoice(override, context.workflow, DEFAULT_AGENT),
    emit: context.emit,
    knowsAgent: (name) => AGENT_NAMES.includes(name),
  };
}

function preflightDeps(context: LoopContext): PreflightDeps {
  return {
    repoRoot: context.repoRoot,
    leftover: context.workflow.leftover,
    nextRow: () => readNextRow(context.workflow.backlog, context.repoRoot, backlogPorts),
    checkHost: context.workflow.hostCheck,
    readHost: readHostReadings,
    readProcs: readProcEntries,
    stopRequested: () => context.runDir.stopRequested(),
    clock: systemClock,
    emit: context.emit,
    recheckMs: MINUTE,
    repeatReportMs: 10 * MINUTE,
  };
}

/**
 * Reads the workflow again, so an edit takes effect at the next iteration with no restart: a rule
 * changed in a loop that holds its text in memory would otherwise need a deploy and a restart. A file
 * that no longer reads keeps the previous workflow and is journaled; a typo must not stop a working loop.
 * The run directory is the one thing a running loop cannot move, so it is not re-read.
 */
async function reloadWorkflow(context: LoopContext): Promise<void> {
  try {
    context.workflow = await loadWorkflow(context.workflowPath, context.workflowRequired);
    context.engine.replace(context.workflow.handlers);
  } catch (error) {
    await context.emit({ type: "workflow_invalid", error: (error as Error).message });
  }
}

async function runLoop(
  context: LoopContext,
  startingChoice: AgentChoice,
): Promise<number> {
  const tracker = new ProgressTracker();
  let current = startingChoice;
  for (;;) {
    await reloadWorkflow(context);
    const ready = await waitUntilReady(preflightDeps(context));
    if (ready.kind !== "ready") {
      await context.emit({ type: ready.kind });
      return 0;
    }
    current = await refreshChoice(choiceDeps(context), current);
    await context.emit({ type: "iteration_started", row: ready.row, head: await context.git.head() });
    const outcome = await runSession(context, sessionChoice(context, current));
    await context.emit({ type: `iteration_${outcome.kind}`, ...outcome });
    const verdict = tracker.record(outcome);
    if (!verdict.keepGoing) {
      await context.emit({ type: "loop_halted", reason: verdict.reason });
      return 1;
    }
  }
}

/** A previous loop died mid-iteration: say so in the journal, so the unfinished work is not forgotten. */
async function recordInterrupted(context: LoopContext): Promise<void> {
  const { open } = summarizeJournal(await context.runDir.readEvents());
  if (!open) return;
  await context.emit({
    type: "iteration_interrupted",
    n: open.n,
    row: open.row,
    sessionId: open.sessionId,
    pending: open.pending.map((ask) => ask.id),
    running: open.running,
  });
}

/** The loop's journal, with the workflow in front of it: every event passes the engine on its way in. */
function workflowFiles(runDir: RunDir, repoRoot: string, workflowHandlers: LoopContext["workflow"]["handlers"]) {
  const inner = new DirectoryMailboxFiles(runDir.path, () => new Date().toISOString());
  const holder: { files?: WorkflowMailboxFiles } = {};
  const engine = new WorkflowEngine(workflowHandlers, {
    writeAnswer: (id, answer, why) => runDir.writeAnswer(id, answer, why),
    writeChoice: (choice) => runDir.writeChoice(choice),
    requestStop: () => runDir.requestStop(),
    run: (command, event, timeoutMs) => runCommand(command, event, timeoutMs, { repoRoot, runDir: runDir.path }),
    emit: (event) => (holder.files as WorkflowMailboxFiles).appendEvent(event),
  });
  holder.files = new WorkflowMailboxFiles(inner, engine);
  return { files: holder.files, engine };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArguments(argv, process.cwd());
  const workflow = await loadWorkflow(args.workflowPath, args.workflowRequired);
  const runDir = new RunDir(args.runDir ?? resolve(args.repoRoot, workflow.runDir));
  await runDir.acquireLock(process.pid, isProcessAlive);
  const { files, engine } = workflowFiles(runDir, args.repoRoot, workflow.handlers);
  const context: LoopContext = {
    repoRoot: args.repoRoot,
    workflowPath: args.workflowPath,
    workflowRequired: args.workflowRequired,
    workflow,
    engine,
    flags: { prompt: args.promptFile, planFollowUp: args.planFollowUp },
    commandOverride: null,
    runDir,
    git: new GitCli(args.repoRoot),
    mailbox: new Mailbox(files, systemClock, DEFAULT_TIMING, nextAskNumber(await runDir.readEvents())),
    emit: (event) => files.appendEvent(event),
  };
  journalSignals({
    on: (signal, handler) => process.once(signal, handler),
    emit: context.emit,
    release: () => runDir.releaseLock(),
    exit: (code) => process.exit(code),
  });
  try {
    const flagged = overrideFromFlags(args);
    if (flagged !== null) await runDir.writeChoice(flagged);
    const choice = resolveChoice(await runDir.readChoice(), context.workflow, DEFAULT_AGENT);
    context.commandOverride = args.agentCommand === null ? null : { agent: choice.agent, command: args.agentCommand };
    await context.emit({
      type: "loop_started",
      repoRoot: args.repoRoot,
      pid: process.pid,
      ...choice,
      planFollowUp: planFollowUpOf(context),
    });
    await recordInterrupted(context);
    return await runLoop(context, choice);
  } finally {
    // A command the workflow started on the last event (a page on loop_halted) must not be cut off by exiting.
    await context.engine.idle();
    await runDir.releaseLock();
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(JSON.stringify({ type: "loop_crashed", error: String(error) }));
      process.exit(2);
    },
  );
}
