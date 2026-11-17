import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selfCommand } from "./self-command.ts";

describe("selfCommand", () => {
  it("runs the TypeScript source with node's transform flags", () => {
    assert.deepEqual(selfCommand("file:///a/src/self-command.ts"), [
      process.execPath, "--experimental-transform-types", "--no-warnings", "/a/src/cli.ts",
    ]);
  });

  it("runs the built JavaScript with plain node", () => {
    assert.deepEqual(selfCommand("file:///a/dist/self-command.js"), [process.execPath, "/a/dist/cli.js"]);
  });
});
