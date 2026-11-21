import { readdir, readFile } from "node:fs/promises";

export type ProcEntry = {
  pid: number;
  ppid: number;
  /** The single-letter state from /proc/<pid>/stat ("Z" is a zombie). */
  state: string;
  argv: string[];
};

/** The part of /proc the reader needs, injected so tests run on fixtures. */
export interface ProcfsIo {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export const nodeProcfs: ProcfsIo = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, "utf8"),
};

/**
 * Every argv element held by the live descendants of `rootPid`, read from the
 * kernel's own table. Returns null when the tree cannot be established —
 * /proc missing, the root pid gone — so a caller can only ever treat a
 * missing match as "the process exited", never as "I could not look".
 *
 * @example
 * const argv = await liveArgvOf(child.pid!, nodeProcfs);
 * // argv is null, or the Set of every argv word under the agent process
 */
export async function liveArgvOf(
  rootPid: number,
  fs: ProcfsIo,
  procRoot = "/proc",
): Promise<Set<string> | null> {
  const entries = await readEntries(fs, procRoot);
  if (entries === null) return null;
  return descendantArgv(rootPid, entries);
}

async function readEntries(
  fs: ProcfsIo,
  procRoot: string,
): Promise<Map<number, ProcEntry> | null> {
  let names: string[];
  try {
    names = await fs.readdir(procRoot);
  } catch {
    return null;
  }
  const entries = new Map<number, ProcEntry>();
  await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        const entry = await readEntry(fs, procRoot, Number(name));
        if (entry) entries.set(entry.pid, entry);
      }),
  );
  return entries;
}

// A pid that exits between readdir and its reads is skipped: an exited
// process was dead anyway, so skipping never manufactures liveness.
async function readEntry(
  fs: ProcfsIo,
  procRoot: string,
  pid: number,
): Promise<ProcEntry | null> {
  try {
    const [stat, cmdline] = await Promise.all([
      fs.readFile(`${procRoot}/${pid}/stat`),
      fs.readFile(`${procRoot}/${pid}/cmdline`),
    ]);
    const parsed = parseStat(stat);
    if (parsed === null) return null;
    return {
      pid,
      ppid: parsed.ppid,
      state: parsed.state,
      argv: cmdline.split("\0").filter((word) => word !== ""),
    };
  } catch {
    return null;
  }
}

// stat is `pid (comm) state ppid ...`; comm itself may hold spaces and
// parens, so the fields start after the last ')'.
function parseStat(stat: string): { state: string; ppid: number } | null {
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const [state, ppidText] = fields;
  if (close < 0 || state === undefined || ppidText === undefined) return null;
  const ppid = Number(ppidText);
  return Number.isInteger(ppid) ? { state, ppid } : null;
}

/**
 * The argv elements of `rootPid`'s non-zombie descendants in `entries`, or
 * null when the root is absent: then nothing about the tree is proven, and
 * matching a shell's command against the empty set would call a live shell
 * dead.
 */
export function descendantArgv(
  rootPid: number,
  entries: ReadonlyMap<number, ProcEntry>,
): Set<string> | null {
  if (!entries.has(rootPid)) return null;
  const children = new Map<number, number[]>();
  for (const entry of entries.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const argv = new Set<string>();
  const queue = [...(children.get(rootPid) ?? [])];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    const entry = entries.get(pid);
    if (!entry) continue;
    if (entry.state !== "Z") {
      for (const word of entry.argv) argv.add(word);
    }
    queue.push(...(children.get(pid) ?? []));
  }
  return argv;
}
