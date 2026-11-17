import { resolve } from "node:path";
import { loadWorkflow, DEFAULT_WORKFLOW_FILE } from "./workflow.ts";
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
every command: --repo <dir> picks the repository (default: cwd), whose autopilot.config.json names the run
directory; AUTOPILOT_RUN_DIR overrides it`;

async function status(runDir: RunDir): Promise<string> {
  const pid = await runDir.lockHolder();
  const summary = summarizeJournal(await runDir.readEvents());
  return describeSummary(summary, pid, pid !== null && isProcessAlive(pid));
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
  const named = workflowFlag !== null;
  const file = resolve(repoRoot, named ? workflowFlag : DEFAULT_WORKFLOW_FILE);
  const workflow = await loadWorkflow(file, named);
  const path = process.env["AUTOPILOT_RUN_DIR"] ?? resolve(repoRoot, workflow.runDir);
  return new RunDir(resolve(path));
}

async function report(runDir: RunDir, repoRoot: string, json: boolean): Promise<string> {
  const git = new GitCli(repoRoot);
  const built = await buildReport({
    events: await runDir.readEvents(),
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
  const { workflow, rest: argv } = splitWorkflow(afterRepo);
  const runDir = await runDirFor(repoRoot, workflow);
  const [command, id, ...rest] = argv;
  if (command === "service") return service(id ?? "", repoRoot, workflow === null ? rest : ["--workflow", resolve(repoRoot, workflow), ...rest]);
  if (command === "report") return report(runDir, repoRoot, argv.includes("--json"));
  if (command === "status") return status(runDir);
  if (command === "use") {
    if (argv[1] === "--reset") {
      await runDir.clearChoice();
      return "override removed: the workflow's harness, model and effort apply from the next session";
    }
    const choice = useArguments(argv.slice(1));
    await runDir.writeChoice(choice);
    const said = [`harness ${choice.agent}`, choice.model && `model ${choice.model}`, choice.effort && `effort ${choice.effort}`].filter(Boolean).join(", ");
    return `next session: ${said}; anything not said comes from the workflow`;
  }
  if (command === "stop") {
    await runDir.requestStop();
    return "stop requested";
  }
  const { values, why } = splitWhy(rest);
  if (command === "answer" && id && values.length > 0) {
    await runDir.writeAnswer(id, values, why);
    return `answered ${id}`;
  }
  if (command === "reply" && id && values.length > 0) {
    await runDir.writeAnswer(id, values.join(" "), why);
    return `replied ${id}`;
  }
  throw new Error(
    `unknown or incomplete command "${argv.join(" ")}"\n${USAGE}`,
  );
}
