import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openingPrompt } from "./session.ts";

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opening-prompt-"));
  file = join(dir, "prompt-execution.md");
  await writeFile(file, "# Execution session\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openingPrompt", () => {
  it("attaches the prompt file, says to follow it, then states the standing rules as one block", async () => {
    const blocks = await openingPrompt(file, ["Rule one.", "Rule two."]);

    assert.deepEqual(blocks, [
      {
        type: "resource",
        resource: {
          uri: `file://${file}`,
          mimeType: "text/markdown",
          text: "# Execution session\n",
        },
      },
      { type: "text", text: "Follow prompt-execution.md (attached)." },
      { type: "text", text: "Rule one.\nRule two." },
    ]);
  });

  it("adds no rules block when the repository configures none", async () => {
    const blocks = await openingPrompt(file, []);

    assert.equal(blocks.length, 2);
  });
});
