import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitProbe } from "./iteration.ts";

const run = promisify(execFile);

/**
 * Whether git ignores `path` (a file inside the run directory, so `dir/`, `dir/*` and `dir` patterns all count),
 * or null when git cannot say: the path is outside the repository, or this is not a repository.
 */
export async function isIgnoredByGit(repoRoot: string, path: string): Promise<boolean | null> {
  try {
    await run("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot });
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 1 ? false : null;
  }
}

/** Reads the two git facts an iteration is judged by: the commit at HEAD and whether the tree is clean. */
export class GitCli implements GitProbe {
  constructor(private readonly repoRoot: string) {}

  async head(): Promise<string> {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: this.repoRoot,
    });
    return stdout.trim();
  }

  async isClean(): Promise<boolean> {
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: this.repoRoot,
    });
    return stdout.trim() === "";
  }

  /** How many commits `to` has that `from` does not: what an iteration shipped, by the heads the journal recorded. */
  async countCommits(from: string, to: string): Promise<number> {
    if (from === to) return 0;
    const { stdout } = await run(
      "git",
      ["rev-list", "--count", "--no-merges", `${from}..${to}`],
      { cwd: this.repoRoot },
    );
    return Number(stdout.trim());
  }
}
