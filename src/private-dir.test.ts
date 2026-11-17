import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ensurePrivateDir } from "./private-dir.ts";
import { RunDir } from "./run-dir.ts";
import { DirectoryMailboxFiles } from "./mailbox.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "private-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("ensurePrivateDir", () => {
  it("creates a directory only its owner can enter, whatever the umask", async () => {
    const previous = process.umask(0o000);
    try {
      const path = join(root, "a", "b");

      await ensurePrivateDir(path);

      assert.equal(await modeOf(path), 0o700);
    } finally {
      process.umask(previous);
    }
  });

  it("tightens a directory that already exists with looser permissions, as an earlier run would have left it", async () => {
    const path = join(root, "old-run");
    await mkdir(path, { mode: 0o775 });
    await chmod(path, 0o775);

    await ensurePrivateDir(path);

    assert.equal(await modeOf(path), 0o700);
  });

  it("leaves what is inside it alone", async () => {
    const path = join(root, "run");
    await ensurePrivateDir(path);
    await writeFile(join(path, "events.jsonl"), "{}\n");

    await ensurePrivateDir(path);

    assert.equal((await stat(join(path, "events.jsonl"))).size, 3);
  });
});

describe("the run directory is private wherever the loop or `autopilot` creates it", () => {
  it("is 700 after a lock is taken, after a stop is requested and after an answer is written", async () => {
    const path = join(root, "locked");
    const locked = new RunDir(path);
    await locked.acquireLock(process.pid, () => false);
    await locked.releaseLock();

    const stopped = join(root, "stopped");
    await new RunDir(stopped).requestStop();

    const answered = join(root, "answered");
    await new RunDir(answered).writeAnswer("q1", ["x"], "why");

    for (const dir of [path, stopped, answered]) assert.equal(await modeOf(dir), 0o700, dir);
    assert.equal(await modeOf(join(answered, "answers")), 0o700);
  });

  it("is 700 after the first journal line, and a directory an older run left open is closed", async () => {
    const fresh = join(root, "fresh");
    await new DirectoryMailboxFiles(fresh, () => "t").appendEvent({ type: "loop_started" });

    const old = join(root, "older");
    await mkdir(old, { mode: 0o775 });
    await chmod(old, 0o775);
    await new DirectoryMailboxFiles(old, () => "t").appendEvent({ type: "loop_started" });

    assert.equal(await modeOf(fresh), 0o700);
    assert.equal(await modeOf(old), 0o700);
  });
});
