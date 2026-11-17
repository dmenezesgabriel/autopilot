import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captureFirstLine, runCommand } from "./command-runner.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runner-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const context = () => ({ repoRoot: dir, runDir: join(dir, ".run") });
const EVENT = { type: "iteration_done", head: "abc" };

describe("runCommand", () => {
  it("passes the event as JSON on stdin and in the environment, and runs in the repository", async () => {
    const script = join(dir, "record.cjs");
    await writeFile(script, `
      let stdin = "";
      process.stdin.on("data", (chunk) => { stdin += chunk; });
      process.stdin.on("end", () => require("fs").writeFileSync("seen.json", JSON.stringify({
        stdin: JSON.parse(stdin), env: JSON.parse(process.env.AUTOPILOT_EVENT), type: process.env.AUTOPILOT_EVENT_TYPE,
        repo: process.env.AUTOPILOT_REPO, run: process.env.AUTOPILOT_RUN_DIR, cwd: process.cwd() })));
    `);

    await runCommand([process.execPath, script], EVENT, 10_000, context());

    const seen = JSON.parse(await readFile(join(dir, "seen.json"), "utf8"));
    assert.deepEqual(seen.stdin, EVENT);
    assert.deepEqual(seen.env, EVENT);
    assert.equal(seen.type, "iteration_done");
    assert.equal(seen.repo, dir);
    assert.equal(seen.run, join(dir, ".run"));
    assert.equal(await import("node:fs").then((fs) => fs.realpathSync(seen.cwd)), await import("node:fs").then((fs) => fs.realpathSync(dir)));
  });

  it("runs a string under a shell", async () => {
    await runCommand('echo "$AUTOPILOT_EVENT_TYPE" > out.txt', EVENT, 10_000, context());

    assert.equal((await readFile(join(dir, "out.txt"), "utf8")).trim(), "iteration_done");
  });

  it("rejects with the exit status and the end of stderr when the command fails", async () => {
    await assert.rejects(
      () => runCommand([process.execPath, "-e", 'console.error("no such channel"); process.exit(3)'], EVENT, 10_000, context()),
      /ended with exit 3: no such channel/,
    );
  });

  it("rejects when the program does not exist", async () => {
    await assert.rejects(() => runCommand(["definitely-not-a-program-xyz"], EVENT, 10_000, context()), /could not start definitely-not-a-program-xyz/);
  });

  it("kills a command that outlives its timeout", async () => {
    await assert.rejects(
      () => runCommand([process.execPath, "-e", "setTimeout(() => {}, 30000)"], EVENT, 200, context()),
      /timed out after 0\.2s and was killed/,
    );
  });
});

describe("captureFirstLine", () => {
  it("returns the first line the command printed, trimmed", async () => {
    assert.equal(await captureFirstLine('printf "  TASK-7  \\nTASK-8\\n"', dir, 10_000), "TASK-7");
  });

  it("returns null when the command prints nothing, which means no row is left", async () => {
    assert.equal(await captureFirstLine("true", dir, 10_000), null);
  });

  it("runs in the repository and takes an argument list without a shell", async () => {
    await writeFile(join(dir, "NEXT"), "R-1\n");

    assert.equal(await captureFirstLine(["cat", "NEXT"], dir, 10_000), "R-1");
  });

  it("fails when the command fails, rather than reading a broken command as an empty backlog", async () => {
    await assert.rejects(() => captureFirstLine("echo boom >&2; exit 4", dir, 10_000), /ended with exit 4: boom/);
  });
});

describe("a command's time limit", () => {
  it("ends a shell command together with the child it started, at the limit and not when the child finishes", async () => {
    const started = Date.now();

    await assert.rejects(() => captureFirstLine("sleep 10; echo late", dir, 300), /timed out after 0\.3s and was killed/);

    assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started} ms for a 300 ms limit`);
  });

  it("does the same for an action's command", async () => {
    const started = Date.now();

    await assert.rejects(() => runCommand("sleep 10", EVENT, 300, context()), /timed out after 0\.3s and was killed/);

    assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started} ms for a 300 ms limit`);
  });

  it("names the limit in the failure, so a waiting loop's journal says why it waits", async () => {
    await assert.rejects(() => captureFirstLine(["sleep", "10"], dir, 200), /sleep timed out after 0\.2s and was killed/);
  });
});
