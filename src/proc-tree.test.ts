import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  descendantArgv,
  liveArgvOf,
  type ProcEntry,
  type ProcfsIo,
} from "./proc-tree.ts";

const stat = (pid: number, state: string, ppid: number) =>
  `${pid} (comm of ${pid}) ${state} ${ppid} 1 2 3`;
const cmdline = (...words: string[]) => `${words.join("\0")}\0`;

/**
 * A /proc tree on fixture data: `files` maps `<pid>/stat` and `<pid>/cmdline`
 * to what the kernel would report, `listing` is what readdir returns.
 */
class FakeProcfs implements ProcfsIo {
  constructor(
    private readonly listing: string[],
    private readonly files: ReadonlyMap<string, string>,
  ) {}

  async readdir(path: string): Promise<string[]> {
    if (path !== "/proc") throw new Error(`unexpected readdir ${path}`);
    return this.listing;
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file ${path}`);
    return content;
  }
}

function procfsOf(
  entries: Array<[number, ProcEntry]>,
): [string[], Map<string, string>] {
  const files = new Map<string, string>();
  for (const [pid, entry] of entries) {
    files.set(`/proc/${pid}/stat`, stat(pid, entry.state, entry.ppid));
    files.set(`/proc/${pid}/cmdline`, cmdline(...entry.argv));
  }
  return [entries.map(([pid]) => String(pid)), files];
}

const entry = (pid: number, ppid: number, argv: string[], state = "S") => [
  pid,
  { pid, ppid, state, argv },
] as [number, ProcEntry];

describe("liveArgvOf", () => {
  it("collects the argv of the root's descendants", async () => {
    const [listing, files] = procfsOf([
      entry(10, 1, ["devin", "acp"]),
      entry(11, 10, ["bash", "-c", "sleep 45"]),
      entry(12, 99, ["unrelated"]),
    ]);

    const argv = await liveArgvOf(10, new FakeProcfs(listing, files));

    assert.deepEqual(argv, new Set(["bash", "-c", "sleep 45"]));
  });

  it("follows the tree past the first generation", async () => {
    const [listing, files] = procfsOf([
      entry(10, 1, ["devin"]),
      entry(11, 10, ["bash", "-c", "hostjob make test"]),
      entry(12, 11, ["systemd-run", "--wait", "make test"]),
      entry(13, 12, ["leaf"]),
    ]);

    const argv = await liveArgvOf(10, new FakeProcfs(listing, files));

    assert.ok(argv?.has("systemd-run"));
    assert.ok(argv?.has("leaf"));
  });

  it("skips zombies: their argv is gone but they keep a process slot", async () => {
    const [listing, files] = procfsOf([
      entry(10, 1, ["devin"]),
      entry(11, 10, ["bash", "-c", "sleep 45"], "Z"),
      entry(12, 11, ["still-live"]),
    ]);

    const argv = await liveArgvOf(10, new FakeProcfs(listing, files));

    assert.equal(argv?.has("sleep 45"), false);
    assert.ok(argv?.has("still-live"));
  });

  it("abstains when the root pid is absent from the listing", async () => {
    const [listing, files] = procfsOf([entry(11, 1, ["stray"])]);

    assert.equal(await liveArgvOf(10, new FakeProcfs(listing, files)), null);
  });

  it("abstains when /proc cannot be listed at all", async () => {
    const fs = new FakeProcfs([], new Map());
    class NoProcfs implements ProcfsIo {
      readdir(): Promise<string[]> {
        return Promise.reject(new Error("no /proc"));
      }
      readFile(): Promise<string> {
        return fs.readFile("/never");
      }
    }

    assert.equal(await liveArgvOf(10, new NoProcfs()), null);
  });

  it("skips a pid that exits between the listing and its reads", async () => {
    const files = new Map([
      ["/proc/10/stat", stat(10, "S", 1)],
      ["/proc/10/cmdline", cmdline("devin")],
    ]);
    const argv = await liveArgvOf(10, new FakeProcfs(["10", "11"], files));

    assert.deepEqual(argv, new Set());
  });
});

describe("descendantArgv", () => {
  it("returns the empty set for a root with no children", () => {
    const entries = new Map([entry(10, 1, ["devin"])]);

    assert.deepEqual(descendantArgv(10, entries), new Set());
  });
});
