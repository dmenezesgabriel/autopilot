import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isIgnoredByGit } from "./git-probe.ts";
import { validate } from "./workflow-commands.ts";

const run = promisify(execFile);

describe("a run directory git does not ignore", () => {
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ignore-"));
    await run("git", ["init", "-q"], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const withIgnore = async (text: string): Promise<void> => writeFile(join(repo, ".gitignore"), text);
  const workflow = async (runDir: string): Promise<void> => writeFile(join(repo, "autopilot.yaml"), `version: 1\nrun_dir: ${runDir}\n`);

  it("is told apart from one it ignores, whether the pattern names the directory, its contents or a parent", async () => {
    assert.equal(await isIgnoredByGit(repo, ".run/events.jsonl"), false);
    for (const pattern of [".run/", ".run/*", ".run", "ops/"]) {
      await withIgnore(`${pattern}\n`);
      assert.equal(await isIgnoredByGit(repo, `${pattern === "ops/" ? "ops/state" : ".run"}/events.jsonl`), true, pattern);
    }
  });

  it("is unknown to git when the path is outside the repository", async () => {
    assert.equal(await isIgnoredByGit(repo, "../elsewhere/events.jsonl"), null);
  });

  it("is warned about by `autopilot validate`, naming the line to add", async () => {
    await withIgnore(".run/\n");
    await workflow(".autopilot-run");

    const text = await validate(["--repo", repo]);

    assert.match(text, /warning: run dir \.autopilot-run is not ignored by git/);
    assert.match(text, /add "\.autopilot-run\/" to \.gitignore/);
  });

  it("is not warned about when git ignores it, or when it lies outside the repository", async () => {
    await withIgnore(".autopilot-run/\n");
    await workflow(".autopilot-run");
    assert.doesNotMatch(await validate(["--repo", repo]), /warning/);

    await workflow("/var/tmp/autopilot-elsewhere");
    assert.doesNotMatch(await validate(["--repo", repo]), /warning/);
  });
});
