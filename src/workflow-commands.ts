import { access, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { runDirFor, splitRepo } from "./ctl.ts";
import { EVENTS, EVENT_NAMES } from "./event-registry.ts";
import { requiredValue } from "./flags.ts";
import { isIgnoredByGit } from "./git-probe.ts";
import type { LoopEvent } from "./mailbox.ts";
import { formatSimulation, simulate } from "./simulate.ts";
import { STARTER_WORKFLOW } from "./starter-workflow.ts";
import { followLines, shouldWake } from "./watch.ts";
import { DEFAULT_WORKFLOW_FILE, loadWorkflow, type Workflow } from "./workflow.ts";
import { summarizeJournal } from "./journal-summary.ts";

type Located = { repoRoot: string; workflowPath: string; workflowFlag: string | null; rest: string[] };

/** Takes `--repo` and `--workflow` off the arguments; the workflow defaults to autopilot.yaml in the repository. */
function locate(args: string[]): Located {
  const { repoRoot, rest } = splitRepo(args, process.cwd());
  const named = requiredValue(rest, "--workflow", "a workflow file");
  const left = named === null ? rest : rest.filter((word, at) => word !== "--workflow" && rest[at - 1] !== "--workflow");
  return { repoRoot, workflowPath: resolve(repoRoot, named ?? DEFAULT_WORKFLOW_FILE), workflowFlag: named, rest: left };
}

/** `autopilot validate`: reads the workflow and says what it will do. */
export async function validate(args: string[]): Promise<string> {
  const { repoRoot, workflowPath } = locate(args);
  const workflow = await loadWorkflow(workflowPath, true);
  const warning = await runDirWarning(repoRoot, workflow.runDir);
  return [`${workflowPath}: ok (schema version ${workflow.schemaVersion})`, ...describeWorkflow(workflow), ...(warning === null ? [] : [warning])].join("\n");
}

/**
 * A run directory git does not ignore makes the tree dirty from the first journal line, so the loop's own
 * check asks the agent for a reply after its first commit and waits for it (seen on a real run with
 * `.autopilot-run` and a `.gitignore` that listed `.run/`).
 */
async function runDirWarning(repoRoot: string, runDir: string): Promise<string | null> {
  const inside = relative(repoRoot, resolve(repoRoot, runDir));
  if (inside === "" || inside.startsWith("..")) return null;
  if ((await isIgnoredByGit(repoRoot, `${inside}/events.jsonl`)) !== false) return null;
  return `  warning: run dir ${runDir} is not ignored by git, so the loop's own journal leaves the tree dirty and every session ends in a dirty_tree reply; add "${inside}/" to .gitignore`;
}

function describeWorkflow(workflow: Workflow): string[] {
  const counts = new Map<string, number>();
  for (const handler of workflow.handlers) counts.set(handler.event, (counts.get(handler.event) ?? 0) + 1);
  const handlers = [...counts].map(([event, n]) => `${event} ${n}`).join(", ") || "none";
  return [
    `  prompt ${workflow.prompt}; run dir ${workflow.runDir}; backlog ${describeBacklog(workflow)}`,
    `  harness ${workflow.harness ?? "claude (default)"}${harnessSummary(workflow)}; plan follow-up ${workflow.planFollowUp ?? "none"}; ${workflow.rules.length} rule lines`,
    `  preflight: ${workflow.leftover.rules.length} leftover rules, ${workflow.leftover.wrappers.length} wrapper rules; limit probe ${workflow.limitProbe}`,
    `  handlers: ${handlers}`,
    `  wake: ${workflow.wake.join(", ")}`,
  ];
}

/** `autopilot events`: every event a handler can name, with the fields its `when` can read. */
export function events(args: string[]): string {
  if (args.includes("--json")) return JSON.stringify(EVENTS, null, 2);
  return EVENT_NAMES.map((name) => `${name.padEnd(26)}${EVENTS[name].kind.padEnd(10)}${EVENTS[name].fields.join(", ").padEnd(52)}${EVENTS[name].means}`).join("\n");
}

/** `autopilot init`: writes a starter autopilot.yaml; an existing one is never overwritten without `--force`. */
export async function init(args: string[]): Promise<string> {
  const { workflowPath } = locate(args);
  const exists = await access(workflowPath).then(() => true, () => false);
  if (exists && !args.includes("--force")) throw new Error(`${workflowPath} already exists; --force replaces it`);
  await writeFile(workflowPath, STARTER_WORKFLOW);
  return `wrote ${workflowPath}; edit it, then \`autopilot validate\``;
}

/** `autopilot simulate`: replays the repository's journal through its workflow, running nothing. */
export async function simulateCommand(args: string[]): Promise<string> {
  const { repoRoot, workflowPath, workflowFlag } = locate(args);
  const runDir = await runDirFor(repoRoot, workflowFlag);
  const workflow = await loadWorkflow(workflowPath, true);
  const result = simulate(await runDir.readEvents(), workflow);
  return args.includes("--json") ? JSON.stringify(result, null, 2) : formatSimulation(result);
}

/** `autopilot pending`: the questions and replies still waiting, each with its full event, as JSON. */
export async function pending(args: string[]): Promise<string> {
  const { repoRoot, workflowFlag } = locate(args);
  const journal = await (await runDirFor(repoRoot, workflowFlag)).readEvents();
  const asks = summarizeJournal(journal).open?.pending ?? [];
  const eventOf = (id: string): LoopEvent | undefined => [...journal].reverse().find((e) => e["id"] === id && e.type.startsWith("needs_"));
  return JSON.stringify(asks.map((ask) => ({ ...ask, event: eventOf(ask.id) ?? null })), null, 2);
}

/**
 * `autopilot watch`: prints, as one JSON line each, the events an orchestrator must act on: those in the
 * workflow's wake list that no handler answered. `--types a,b` replaces the list; `--from-start` replays
 * the journal first. Meant for a Monitor.
 */
export async function watch(args: string[], out: (line: string) => void, signal: AbortSignal): Promise<void> {
  const { repoRoot, workflowPath, workflowFlag, rest } = locate(args);
  const runDir = await runDirFor(repoRoot, workflowFlag);
  const workflow = await loadWorkflow(workflowPath, false);
  const types = requiredValue(rest, "--types", "a comma-separated list of event names");
  const wake = (types === null ? workflow.wake : types.split(",")) as Workflow["wake"];
  await followLines(`${runDir.path}/events.jsonl`, (line) => {
    const event = parseLine(line);
    if (event !== null && shouldWake(event, wake)) out(line);
  }, { fromStart: rest.includes("--from-start"), pollMs: 1000, signal });
}

function parseLine(line: string): LoopEvent | null {
  try {
    return JSON.parse(line) as LoopEvent;
  } catch {
    return null;
  }
}

export async function readVersion(): Promise<string> {
  const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(text) as { version: string }).version;
}

function harnessSummary(workflow: Workflow): string {
  const set = Object.entries(workflow.harnesses).map(([name, s]) => `${name}: model ${s.model ?? "default"}, effort ${s.effort ?? "default"}`);
  return set.length === 0 ? "" : ` (${set.join("; ")})`;
}

function describeBacklog(workflow: Workflow): string {
  const { backlog } = workflow;
  if (backlog.source === "command") return `from a command (${typeof backlog.command === "string" ? backlog.command : backlog.command.join(" ")}), ${backlog.timeoutMs / 1000}s limit`;
  return `${backlog.file} (marker ${JSON.stringify(backlog.marker)})`;
}
