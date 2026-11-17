import { readdir, readFile, readlink } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import type { Clock } from "./clock.ts";
import { hintFor, isWrapper, type WrapperRule } from "./process-wrapper.ts";
import type { LeftoverRule } from "./workflow.ts";
import type { LoopEvent } from "./mailbox.ts";

export type HostReadings = {
  load1: number;
  cores: number;
  memoryStallAvg60: number;
};
export type ProcEntry = { pid: number; cwd: string; cmdline: string };

/** What counts as a process a finished session left behind, as the repository's config states it. */
export type LeftoverPolicy = { rules: LeftoverRule[]; wrappers: WrapperRule[] };

/**
 * Why a new session waits. The kind is stable while the cause holds and is what the loop compares to
 * decide whether to say it again; the reason is the journal text and carries the reading of the moment,
 * which changes every time it is read. Without the split a busy host, whose load reading moves every
 * minute, would be journaled once a minute for as long as it stayed busy.
 */
type Blocker = { kind: string; reason: string };

/** Wait while load exceeds the cores or tasks already stall for memory. */
function hostBusyBlocker(readings: HostReadings): Blocker | null {
  if (readings.load1 > readings.cores) {
    return {
      kind: "host_load",
      reason: `1-minute load ${readings.load1} exceeds ${readings.cores} cores`,
    };
  }
  if (readings.memoryStallAvg60 > 0) {
    return {
      kind: "host_memory",
      reason: `tasks stalled for memory ${readings.memoryStallAvg60}% of the last minute`,
    };
  }
  return null;
}

export function hostBusyReason(readings: HostReadings): string | null {
  return hostBusyBlocker(readings)?.reason ?? null;
}

/**
 * What a finished session left running in the repo: a process the workflow's rules name, or a wrapper
 * (a job queue's, say) around a job that is queued or running. The second is the one a name list cannot
 * see: a gate's first tiers are `tsc` and `eslint`, and its job outlives the session that started it.
 */
export function leftoversIn(
  entries: ProcEntry[],
  repoRoot: string,
  policy: LeftoverPolicy,
): ProcEntry[] {
  return entries.filter(
    (entry) =>
      (entry.cwd === repoRoot || entry.cwd.startsWith(`${repoRoot}/`)) &&
      isLeftover(entry.cmdline, policy),
  );
}

function isLeftover(cmdline: string, policy: LeftoverPolicy): boolean {
  if (policy.wrappers.some((rule) => isWrapper(cmdline, rule))) return true;
  return policy.rules.some(
    (rule) => rule.match.test(cmdline) && (rule.alsoMatch?.test(cmdline) ?? true),
  );
}

/**
 * The 1-minute load comes from `os.loadavg()`, which every Unix has. Memory stall is Linux's pressure
 * file, and a kernel without it (PSI off, some containers) or another OS reads as no stall: a host the
 * loop cannot read must not stop it, and `preflight.host_check: false` turns the whole check off.
 */
export async function readHostReadings(): Promise<HostReadings> {
  const pressure = await readFile("/proc/pressure/memory", "utf8").catch(() => null);
  return { load1: loadavg()[0] ?? 0, cores: cpus().length, memoryStallAvg60: memoryStallOf(pressure) };
}

/** The `some avg60` figure of a pressure file's text; null (no such file) and unreadable text are 0. */
export function memoryStallOf(pressure: string | null): number {
  const stall = /some avg10=\S+ avg60=([\d.]+)/.exec(pressure ?? "");
  return Number(stall?.[1] ?? 0);
}

/**
 * Every process with its working directory and command line, from `/proc`. Where there is no `/proc`
 * (not Linux) it finds none, so no leftover is ever seen there; the rest of preflight is unaffected.
 */
export async function readProcEntries(): Promise<ProcEntry[]> {
  const names = await readdir("/proc").catch(() => []);
  const pids = names.filter((name) => /^\d+$/.test(name));
  const entries = await Promise.all(pids.map(readProcEntry));
  return entries.filter((entry): entry is ProcEntry => entry !== null);
}

async function readProcEntry(pid: string): Promise<ProcEntry | null> {
  try {
    const cwd = await readlink(`/proc/${pid}/cwd`);
    const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
      .replaceAll("\0", " ")
      .trim();
    return { pid: Number(pid), cwd, cmdline };
  } catch {
    return null; // the process ended, or belongs to another user
  }
}

export type PreflightDeps = {
  repoRoot: string;
  leftover: LeftoverPolicy;
  /** The id of the row to work on next, or null when none is left; where it comes from is the workflow's business. */
  nextRow(): Promise<string | null>;
  /** Whether a busy host holds a new session back. */
  checkHost: boolean;
  readHost(): Promise<HostReadings>;
  readProcs(): Promise<ProcEntry[]>;
  stopRequested(): Promise<boolean>;
  clock: Clock;
  emit(event: LoopEvent): Promise<void>;
  recheckMs: number;
  repeatReportMs: number;
};

export type PreflightResult =
  /** A session may start, on the row preflight itself read: it is never read a second time. */
  | { kind: "ready"; row: string }
  | { kind: "backlog_exhausted" }
  | { kind: "stop" };

type RowReading = { kind: "row"; row: string | null } | { kind: "unreadable"; blocker: Blocker };

/** The next row, or why it cannot be read: a source that fails holds the loop back and is reported, and never ends it. */
async function readRow(deps: PreflightDeps): Promise<RowReading> {
  try {
    return { kind: "row", row: await deps.nextRow() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "unreadable", blocker: { kind: "backlog_error", reason: `the backlog could not be read: ${message}` } };
  }
}

/** Says why a session waits once per cause, again when the cause changes or goes stale, then sleeps one recheck. */
function waitingReporter(deps: PreflightDeps): (blocker: Blocker) => Promise<void> {
  let reportedKind = "";
  let reportedAt = -Infinity;
  return async (blocker) => {
    const stale = deps.clock.now() - reportedAt >= deps.repeatReportMs;
    if (blocker.kind !== reportedKind || stale) {
      reportedKind = blocker.kind;
      reportedAt = deps.clock.now();
      await deps.emit({ type: "preflight_wait", reason: blocker.reason });
    }
    await deps.clock.sleep(deps.recheckMs);
  };
}

/**
 * Holds the loop until a new session may start: a next backlog row exists, the host has room, and the
 * previous session left nothing the workflow names in the repo. It reports why it waits, never kills what
 * it did not start, and gives up only when the backlog is empty or a stop was asked for. A backlog source
 * that fails is a reason to wait, not to stop: the loop is never ended by reading a broken source as empty.
 */
export async function waitUntilReady(deps: PreflightDeps): Promise<PreflightResult> {
  const wait = waitingReporter(deps);
  for (;;) {
    if (await deps.stopRequested()) return { kind: "stop" };
    const reading = await readRow(deps);
    if (reading.kind === "unreadable") {
      await wait(reading.blocker);
      continue;
    }
    if (reading.row === null) return { kind: "backlog_exhausted" };
    const blocker = await blockingReason(deps);
    if (blocker === null) return { kind: "ready", row: reading.row };
    await wait(blocker);
  }
}

/** A wrapper is named with its rule's hint, such as the command that ends it: the loop waits, and only a person or the orchestrator stops it. */
function describeProcess(entry: ProcEntry, policy: LeftoverPolicy): string {
  const text = `${entry.pid} ${entry.cmdline.slice(0, 60)}`;
  const rule = policy.wrappers.find((candidate) => isWrapper(entry.cmdline, candidate));
  const hint = rule === undefined ? null : hintFor(rule, entry);
  return hint === null ? text : `${text} (${hint})`;
}

async function blockingReason(deps: PreflightDeps): Promise<Blocker | null> {
  const busy = deps.checkHost ? hostBusyBlocker(await deps.readHost()) : null;
  if (busy) return busy;
  const left = leftoversIn(await deps.readProcs(), deps.repoRoot, deps.leftover);
  if (left.length === 0) return null;
  const described = left.map((entry) => describeProcess(entry, deps.leftover)).join("; ");
  return {
    // A new process, or one gone, is a new fact worth saying; its command line is not.
    kind: `leftover:${left.map((entry) => entry.pid).join(",")}`,
    reason: `leftover processes in the repo: ${described}`,
  };
}
