import { spawn, type ChildProcess } from "node:child_process";
import type { LoopEvent } from "./mailbox.ts";

export type RunContext = { repoRoot: string; runDir: string };

/**
 * Ends a command and everything it started. A shell's children share its process group, and killing only
 * the shell leaves them running with the output pipe open, so a timeout would not take effect until they
 * finished on their own (measured: a 300 ms limit on `sh -c 'sleep 5'` returned after 5 s).
 */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** What a command's refusal says when its limit ended it, instead of the bare signal. */
function timedOutMessage(program: string, timeoutMs: number): string {
  return `${program} timed out after ${timeoutMs / 1000}s and was killed`;
}

/**
 * Runs a workflow's command for an event in the repository. A list is run without a shell; a string runs
 * under `sh -c`. The event is on stdin and in AUTOPILOT_EVENT as JSON, with AUTOPILOT_EVENT_TYPE,
 * AUTOPILOT_REPO and AUTOPILOT_RUN_DIR beside it. Rejects on a non-zero exit, a spawn failure or the timeout.
 */
export function runCommand(
  command: string | string[],
  event: LoopEvent,
  timeoutMs: number,
  context: RunContext,
): Promise<void> {
  const json = JSON.stringify(event);
  const [program, ...args] = typeof command === "string" ? ["sh", "-c", command] : command;
  return new Promise((resolve, reject) => {
    const child = spawn(program as string, args, {
      cwd: context.repoRoot,
      env: { ...process.env, AUTOPILOT_EVENT: json, AUTOPILOT_EVENT_TYPE: event.type, AUTOPILOT_REPO: context.repoRoot, AUTOPILOT_RUN_DIR: context.runDir },
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });
    let timedOut = false;
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.on("error", (error) => settle(() => reject(new Error(`could not start ${program}: ${error.message}`))));
    child.on("close", (code, signal) => settle(() => (code === 0 ? resolve() : reject(new Error(timedOut ? timedOutMessage(program as string, timeoutMs) : failure(program as string, code, signal, stderr))))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(json);
    function settle(done: () => void): void {
      clearTimeout(timer);
      done();
    }
  });
}

function failure(program: string, code: number | null, signal: NodeJS.Signals | null, stderr: Buffer[]): string {
  const how = signal === null ? `exit ${String(code)}` : `signal ${signal}`;
  const tail = Buffer.concat(stderr).toString("utf8").trim().slice(-200);
  return `${program} ended with ${how}${tail === "" ? "" : `: ${tail}`}`;
}

/**
 * Runs a command in the repository and returns the first line it printed, trimmed; empty output is null.
 * This is how a repository whose work is not a markdown table says which row is next. A failing command
 * is an error naming its status, never an empty answer: reading a broken command as "no work left"
 * would end the loop quietly.
 */
export function captureFirstLine(command: string | string[], repoRoot: string, timeoutMs: number): Promise<string | null> {
  const [program, ...args] = typeof command === "string" ? ["sh", "-c", command] : command;
  return new Promise((resolve, reject) => {
    const child = spawn(program as string, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let timedOut = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.on("error", (error) => (clearTimeout(timer), reject(new Error(`could not start ${program}: ${error.message}`))));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(timedOutMessage(program as string, timeoutMs)));
      if (code !== 0) return reject(new Error(failure(program as string, code, signal, err)));
      const first = Buffer.concat(out).toString("utf8").split("\n")[0]?.trim() ?? "";
      resolve(first === "" ? null : first);
    });
  });
}
