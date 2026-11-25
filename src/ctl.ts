import { resolve } from "node:path";
import { loadWorkflow, runDirNameOf, DEFAULT_WORKFLOW_FILE, WorkflowMissingError, type Workflow } from "./workflow.ts";
import { selfCommand } from "./self-command.ts";
import { GitCli } from "./git-probe.ts";
import { buildReport, formatReport } from "./report.ts";
import { readTranscripts } from "./transcript-stats.ts";
import type { ChoiceOverride } from "./agent-choice.ts";
import { profileFor } from "./agents/index.ts";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderUnit, unitNameFor } from "./service-unit.ts";
import { requiredValue } from "./flags.ts";
import { describeSummary, summarizeJournal } from "./journal-summary.ts";
import { describeNextSession } from "./next-session.ts";
import { checkAnswer, checkStop, type AnswerRequest, type LoopLiveness } from "./operator-checks.ts";
import { RunDir, isProcessAlive } from "./run-dir.ts";

const USAGE = `usage:
  status                       what runs, what waits, what finished, what was decided
  answer <id> [--why <reason>] <label>...   one label per question of a needs_answer event
  reply  <id> [--why <reason>] <text>       the free-text reply to a needs_reply event
  use <harness> [--model <id>] [--effort <value>]  run the next session on that harness (claude, devin);
                                      anything not said comes from the workflow; a running session is
                                      never interrupted
  use --reset                          remove the override: the workflow's settings apply again
  stop                         finish after the current iteration, then exit
  service print|install [run.ts flags...]   the systemd user unit that starts the loop at boot and
                                      restarts a crash; install writes it, enabling it is yours to do
  report [--json]              per agent and outcome: iterations, commits, hours, cost, calls,
                                      compactions; restarts the loop did not choose; limit waits
every command: --repo <dir> picks the repository (default: cwd), whose autopilot.yaml names the run
directory; --run-dir <dir> or AUTOPILOT_RUN_DIR names it outright (needed only when autopilot.yaml is not YAML)`;

async function livenessOf(runDir: RunDir): Promise<LoopLiveness> {
  const pid = await runDir.lockHolder();
  return { pid, alive: pid !== null && isProcessAlive(pid) };
}

async function status(context: RunContext, repoRoot: string): Promise<string> {
  const { pid, alive } = await livenessOf(context.runDir);
  const summary = summarizeJournal(await context.runDir.readEvents());
  const hint = `orchestrating this loop? \`autopilot guide --repo ${repoRoot}\` says how`;
  return `${describeSummary(summary, pid, alive, await nextSessionLines(context))}\n${hint}`;
}

/** Writes the answer or reply the loop waits on, after checking the journal and the lock say one does. */
async function giveAnswer(runDir: RunDir, request: AnswerRequest, why: string | undefined): Promise<string> {
  const summary = summarizeJournal(await runDir.readEvents());
  const notes = checkAnswer(summary, await livenessOf(runDir), request);
  const text = request.kind === "reply" ? request.values.join(" ") : request.values;
  await runDir.writeAnswer(request.id, text, why);
  return [`${request.kind === "reply" ? "replied" : "answered"} ${request.id}`, ...notes].join("\n");
}

async function stop(runDir: RunDir): Promise<string> {
  const loop = await livenessOf(runDir);
  const nothing = checkStop(loop);
  if (nothing !== null) return nothing;
  await runDir.requestStop();
  const open = summarizeJournal(await runDir.readEvents()).open;
  const now = open === null ? "between iterations" : `after iteration #${open.n}`;
  return `stop requested: the loop (pid ${loop.pid}) exits ${now}`;
}

/** Splits `--why <reason>` off the front of an answer's arguments; the reason goes in the journal. */
export function splitWhy(args: string[]): { values: string[]; why?: string } {
  if (args[0] !== "--why") return { values: args };
  return { why: args[1], values: args.slice(2) };
}

const USE_FLAGS: Record<string, string> = {
  "--model": "a model id the harness offers",
  "--effort": "an effort the harness offers",
};

/**
 * The choice `ctl use` records. The agent is checked now, against the ones the loop can drive; the
 * model and effort can only be checked by the next session, which is the one place the agent lists them.
 *
 * @example
 * useArguments(["devin", "--model", "swe-2-high"]);
 * // => { agent: "devin", model: "swe-2-high", effort: null }
 */
export function useArguments(args: string[]): ChoiceOverride {
  const [name, ...flags] = args;
  const agent = profileFor(name).name;
  for (let at = 0; at < flags.length; at += 2) {
    const flag = flags[at] ?? "";
    if (!(flag in USE_FLAGS)) {
      throw new Error(`ctl use takes --model and --effort, got ${JSON.stringify(flag)}`);
    }
  }
  return {
    agent,
    model: requiredValue(flags, "--model", USE_FLAGS["--model"] ?? ""),
    effort: requiredValue(flags, "--effort", USE_FLAGS["--effort"] ?? ""),
  };
}

/** Takes `--repo <dir>` off the arguments; the rest is the command. */
export function splitRepo(argv: string[], cwd: string): { repoRoot: string; rest: string[] } {
  const at = argv.indexOf("--repo");
  if (at === -1) return { repoRoot: resolve(cwd), rest: argv };
  const value = requiredValue(argv, "--repo", "a repository directory") ?? cwd;
  return { repoRoot: resolve(cwd, value), rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/** Takes `--workflow <file>` off the arguments; null when none is named. */
export function splitWorkflow(argv: string[]): { workflow: string | null; rest: string[] } {
  const at = argv.indexOf("--workflow");
  if (at === -1) return { workflow: null, rest: argv };
  const workflow = requiredValue(argv, "--workflow", "a workflow file") ?? "";
  return { workflow, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/**
 * The run directory of a repository: the one its workflow names. The workflow is the repository's own
 * autopilot.yaml, or the file `--workflow` names, which must exist. Every command that reads or writes the run
 * directory resolves it here, so `stop`, `answer` and `status` reach the directory the loop actually uses.
 */
export async function runDirFor(repoRoot: string, workflowFlag: string | null = null): Promise<RunDir> {
  const { runDir, workflow, problem } = await runContextFor(repoRoot, workflowFlag);
  if (workflow === null) throw new Error(problem ?? "the workflow does not read");
  return runDir;
}

/** What an operator command knows of a repository: its run directory always, its workflow when that reads. */
export type RunContext = { runDir: RunDir; workflow: Workflow | null; problem: string | null };

/**
 * The run directory of a repository and, when it reads, the workflow that named it. A workflow that does
 * not read still names its run directory unless it is not YAML at all, so `stop`, `answer` and `status`
 * keep working while the loop runs on the workflow it last read; `problem` says why it does not read.
 * `--run-dir` and AUTOPILOT_RUN_DIR name the directory outright, in that order of precedence.
 */
export async function runContextFor(repoRoot: string, workflowFlag: string | null = null, runDirFlag: string | null = null): Promise<RunContext> {
  const named = workflowFlag !== null;
  const file = resolve(repoRoot, named ? workflowFlag : DEFAULT_WORKFLOW_FILE);
  const given = runDirFlag === null ? process.env["AUTOPILOT_RUN_DIR"] : resolve(runDirFlag);
  try {
    const workflow = await loadWorkflow(file, named);
    return { runDir: runDirOf(repoRoot, workflow, given), workflow, problem: null };
  } catch (error) {
    if (error instanceof WorkflowMissingError) throw error;
    const problem = (error as Error).message;
    const name = given ?? (await runDirNameOf(file).catch(() => null));
    if (name === null) {
      throw new Error(`${problem}\nit does not read as YAML, so it cannot name the run directory either: say which with --run-dir <dir>`);
    }
    return { runDir: new RunDir(resolve(repoRoot, name)), workflow: null, problem };
  }
}

/** The run directory a workflow names, unless `given` (the flag or AUTOPILOT_RUN_DIR) says another. */
export function runDirOf(repoRoot: string, workflow: Workflow, given: string | undefined = process.env["AUTOPILOT_RUN_DIR"]): RunDir {
  return new RunDir(resolve(given ?? resolve(repoRoot, workflow.runDir)));
}

/** Takes `--run-dir <dir>` off the arguments; null when none is named. */
export function splitRunDir(argv: string[]): { runDir: string | null; rest: string[] } {
  const at = argv.indexOf("--run-dir");
  if (at === -1) return { runDir: null, rest: argv };
  const runDir = requiredValue(argv, "--run-dir", "a run directory") ?? "";
  return { runDir, rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/** The lines that say what the next session runs on, or why that cannot be said while the workflow does not read. */
async function nextSessionLines(context: RunContext): Promise<string[]> {
  if (context.workflow === null) {
    return [`next session: not worked out, because the workflow does not read: ${context.problem}`, "  a running loop keeps the workflow it last read; `autopilot validate` shows the error"];
  }
  return describeNextSession(context.runDir, context.workflow);
}

async function report(runDir: RunDir, repoRoot: string, json: boolean): Promise<string> {
  const events = await runDir.readEvents();
  if (events.length === 0) return `no iterations yet: ${runDir.path}/events.jsonl holds no events`;
  const git = new GitCli(repoRoot);
  const built = await buildReport({
    events,
    headNow: await git.head(),
    commitsBetween: (from, to) => git.countCommits(from, to),
    transcripts: await readTranscripts(runDir.path),
  });
  return json ? JSON.stringify(built, null, 2) : formatReport(built);
}

/** The unit for a repository, built from where this checkout lives and which node runs it. */
export async function service(action: string, repoRoot: string, runArguments: string[]): Promise<string> {
  const unit = renderUnit({ repoRoot, command: selfCommand(), home: homedir(), runArguments });
  if (action === "print") return unit;
  if (action !== "install") throw new Error(`ctl service takes print or install, got ${JSON.stringify(action)}`);
  const dir = join(homedir(), ".config/systemd/user");
  const name = unitNameFor(repoRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), unit);
  return `wrote ${join(dir, name)}\nstop any loop started by hand in ${repoRoot} first (one loop per run directory), then:\n  systemctl --user daemon-reload && systemctl --user enable --now ${name}\nto keep it down across a reboot after \`ctl stop\`: systemctl --user disable ${name}`;
}

/** The operator commands: status, answer, reply, use, stop, report and service. */
export async function runCtl(args: string[]): Promise<string> {
  const { repoRoot, rest: afterRepo } = splitRepo(args, process.cwd());
  const { workflow, rest: afterWorkflow } = splitWorkflow(afterRepo);
  const { runDir: runDirFlag, rest: argv } = splitRunDir(afterWorkflow);
  const context = await runContextFor(repoRoot, workflow, runDirFlag);
  const { runDir } = context;
  const [command, id, ...rest] = argv;
  if (command === "service") return service(id ?? "", repoRoot, workflow === null ? rest : ["--workflow", resolve(repoRoot, workflow), ...rest]);
  if (command === "report") return report(runDir, repoRoot, argv.includes("--json"));
  if (command === "status") return status(context, repoRoot);
  if (command === "use") {
    if (argv[1] === "--reset") {
      const had = (await runDir.readChoice().catch(() => ({}))) !== null;
      await runDir.clearChoice();
      const lines = await nextSessionLines(context);
      return [had ? "override removed" : "no override was set", ...lines].join("\n");
    }
    const choice = useArguments(argv.slice(1));
    await runDir.writeChoice(choice);
    return (await nextSessionLines(context)).join("\n");
  }
  if (command === "stop") return stop(runDir);
  const { values, why } = splitWhy(rest);
  if ((command === "answer" || command === "reply") && id && values.length > 0) {
    const kind = command === "answer" ? "question" : "reply";
    return giveAnswer(runDir, { id, kind, values }, why);
  }
  throw new Error(
    `unknown or incomplete command "${argv.join(" ")}"\n${USAGE}`,
  );
}
