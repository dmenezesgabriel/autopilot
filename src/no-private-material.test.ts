import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_LITERALS = join(ROOT, ".sensitive-strings.local");

/** Signals that need no list: an absolute home directory, or a personal mail address. */
const GENERIC = [/\/home\/(?!user\b|u\b)[a-z][\w-]*\//, /\b[\w.+-]+@(gmail|outlook|hotmail|yahoo)\.com\b/i];

/** Every file a commit could contain: tracked, plus untracked and not ignored. */
function committable(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter((path) => path !== "" && existsSync(join(ROOT, path)) && !path.endsWith(".ndjson"));
}

function contentOf(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("a reader of the public repository cannot be pointed at what is private", () => {
  it("no file holds an absolute home directory or a personal mail address", () => {
    const hits = committable().filter((path) => GENERIC.some((pattern) => pattern.test(contentOf(path))));

    assert.deepEqual(hits, []);
  });

  it("no file holds a literal listed in .sensitive-strings.local, when that file exists", { skip: !existsSync(LOCAL_LITERALS) }, () => {
    const literals = readFileSync(LOCAL_LITERALS, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const hits = committable().flatMap((path) => {
      const text = contentOf(path).toLowerCase();
      return literals.filter((literal) => text.includes(literal.toLowerCase())).map((literal) => `${path}: ${literal}`);
    });

    assert.deepEqual(hits, []);
  });
});
