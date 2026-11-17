import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.ts");
export const FAKE_AGENT = join(HERE, "..", "..", "testdata", "fake-claude-acp.mjs");

/** One session of the scripted agent, as `testdata/fake-claude-acp.mjs` documents. */
export type SessionScript = {
  question?: { header: string; question: string; options: string[] };
  plan?: string;
  work?: string;
  silentFirstTurn?: string;
  rateLimit?: { resetsInSeconds?: number; type?: string };
};

export type LoopCase = {
  /** The workflow file; the harness adds `run_dir: .run` and turns the host check off unless the case sets them. */
  workflow: string;
  sessions: SessionScript[];
  /** Extra files, or replacements; a null value leaves the default file out. */
  files?: Record<string, string | null>;
  args?: string[];
  /** Leaves `--agent-command` out, so the workflow's own `command` is what starts the agent. */
  omitAgentCommand?: boolean;
  timeoutMs?: number;
};

export type LoopResult = {
  exitCode: number | null;
  events: Array<Record<string, unknown>>;
  /** Subjects of the commits made after the initial one, oldest first. */
  commits: string[];
  dir: string;
  read(path: string): Promise<string>;
  state(name: string): Promise<string>;
  cleanup(): Promise<void>;
};

export const TWO_ROWS = "| ID | State |\n| `R-1` | open ← next |\n| `R-2` | open |\n";
export const GIT_AUTHOR = "-c user.email=t@t -c user.name=t";

/** A shell text that marks row `done` shipped and `next` as the next row, then commits everything. */
export function shipRow(done: string, next: string | null, subject: string): string {
  const promote = next === null ? "" : `; sed -i 's/\`${next}\` | open /\`${next}\` | open ← next /' docs/backlog.md`;
  return `sed -i 's/\`${done}\` | open ← next/\`${done}\` | shipped/' docs/backlog.md${promote}; echo ${done} > ${done}.txt; git add -A; git ${GIT_AUTHOR} commit -q -m "${subject}"`;
}

/**
 * Runs the real `autopilot run` in a throwaway git repository against the scripted agent, which speaks the
 * frames recorded from claude-agent-acp, until the loop exits. No model is involved, so a case costs no credits.
 */
export async function runLoop(spec: LoopCase): Promise<LoopResult> {
  const dir = await mkdtemp(join(tmpdir(), "loop-"));
  const stateDir = `${dir}-state`;
  await mkdir(stateDir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const files: Record<string, string | null> = {
    "docs/backlog.md": TWO_ROWS,
    "prompt-execution.md": "# Do the next row\n",
    ".gitignore": ".run/\n",
    "autopilot.yaml": `run_dir: .run\npreflight: { host_check: false }\n${spec.workflow}`,
    ...spec.files,
  };
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await writeFile(join(stateDir, "scenario.json"), JSON.stringify({ sessions: spec.sessions }));
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "initial"], { cwd: dir });
  const exitCode = await runCli(dir, stateDir, spec);
  return resultOf(dir, stateDir, exitCode);
}

function runCli(dir: string, stateDir: string, spec: LoopCase): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", CLI, "run", "--repo", dir, ...(spec.omitAgentCommand === true ? [] : ["--agent-command", FAKE_AGENT]), ...(spec.args ?? [])],
      { env: { ...process.env, FAKE_ACP_SCENARIO: join(stateDir, "scenario.json"), FAKE_ACP_STATE: stateDir }, stdio: ["ignore", "ignore", "inherit"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutMs ?? 60_000);
    child.on("close", (code) => (clearTimeout(timer), resolve(code)));
  });
}

async function resultOf(dir: string, stateDir: string, exitCode: number | null): Promise<LoopResult> {
  const journal = await readFile(join(dir, ".run", "events.jsonl"), "utf8").catch(() => "");
  const events = journal.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  const { stdout } = await run("git", ["log", "--format=%s", "--reverse", "-n", "50"], { cwd: dir });
  return {
    exitCode,
    events,
    commits: stdout.split("\n").filter((line) => line !== "").slice(1),
    dir,
    read: (path) => readFile(join(dir, path), "utf8"),
    state: (name) => readFile(join(stateDir, name), "utf8").catch(() => ""),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

export const typesOf = (result: LoopResult): string[] => result.events.map((event) => String(event["type"]));
