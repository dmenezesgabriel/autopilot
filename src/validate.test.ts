import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validate } from "./workflow-commands.ts";

describe("autopilot validate: what it says of a file and of the next session", () => {
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "validate-next-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("names the missing file and the command that writes one, instead of a bare ENOENT", async () => {
    await assert.rejects(() => validate(["--repo", repo]), /workflow file .*autopilot\.yaml does not exist; `autopilot init` writes a starter one/);
  });

  it("says what the next session will run on, and that an override in choice.json outranks the workflow", async () => {
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nharness: devin\n");
    assert.match(await validate(["--repo", repo]), /\n  next session: devin, model default, effort default \(from the workflow\)/);

    await mkdir(join(repo, ".autopilot-run"));
    await writeFile(join(repo, ".autopilot-run/choice.json"), '{"agent":"claude","model":"haiku","effort":null}');

    assert.match(await validate(["--repo", repo]), /next session: claude, model haiku, effort default\n  override in choice\.json/);
  });
});
