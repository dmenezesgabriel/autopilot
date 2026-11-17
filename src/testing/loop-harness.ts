import { execFile, spawn, type ChildProcess } from "node:child_process";
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
  /** The working turn never ends, so a test can kill the loop while the session is open. */
  hold?: boolean;
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
  /** Extra environment for the loop, such as a PATH holding a stand-in for a tool. */
  env?: Record<string, string>;
  /** Runs while the loop runs: waits for its events, calls the CLI as an orchestrator would, kills it, starts another. */
  during?: (live: LiveLoop) => Promise<void>;
};

/** What a test may do to a loop that is running. */
export type LiveLoop = {
  dir: string;
  /** The first journal line of that type, once it exists. */
  waitForEvent(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Signals the first loop and resolves once it has exited, so a restart never meets a lock it still holds. */
  kill(signal: NodeJS.Signals): Promise<void>;
  /** Starts another `autopilot run` in the same repository, and says how it ended. */
  startAnother(): Promise<{ code: number | null; stderr: string }>;
  /** Runs an `autopilot` command against this repository, as an orchestrating agent would. */
  cli(...args: string[]): Promise<string>;
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
    "autopilot.yaml": `version: 1\nrun_dir: .run\npreflight: { host_check: false }\n${spec.workflow}`,
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
  const first = spawnLoop(dir, stateDir, spec);
  const live = liveLoop(dir, stateDir, spec, first);
  const driven = spec.during === undefined ? Promise.resolve() : spec.during(live);
  const exitCode = (await first.done).code;
  await driven;
  return resultOf(dir, stateDir, exitCode);
}

type Spawned = { child: ChildProcess; done: Promise<{ code: number | null; stderr: string }> };

function spawnLoop(dir: string, stateDir: string, spec: LoopCase): Spawned {
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", CLI, "run", "--repo", dir, ...(spec.omitAgentCommand === true ? [] : ["--agent-command", FAKE_AGENT]), ...(spec.args ?? [])],
    { env: { ...process.env, ...spec.env, FAKE_ACP_SCENARIO: join(stateDir, "scenario.json"), FAKE_ACP_STATE: stateDir }, stdio: ["ignore", "ignore", "pipe"] },
  );
  const chunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutMs ?? 60_000);
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stderr: Buffer.concat(chunks).toString("utf8") })));
  });
  return { child, done };
}

function liveLoop(dir: string, stateDir: string, spec: LoopCase, first: Spawned): LiveLoop {
  const journal = join(dir, ".run", "events.jsonl");
  return {
    dir,
    kill: async (signal) => {
      first.child.kill(signal);
      await first.done;
    },
    startAnother: () => spawnLoop(dir, stateDir, spec).done,
    cli: async (...args) => (await run(process.execPath, ["--experimental-transform-types", "--no-warnings", CLI, ...args, "--repo", dir])).stdout,
    waitForEvent: async (type, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const lines = (await readFile(journal, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
        const found = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event["type"] === type);
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`no ${type} event in the journal within ${timeoutMs} ms`);
    },
  };
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
