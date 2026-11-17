import { basename } from "node:path";

/**
 * A program that stays alive for as long as a job it wraps is queued or running (a job queue, a task
 * runner). A session that started such a job leaves the wrapper behind when it ends, whatever the job's
 * own first steps are called, so the next session waits for it.
 */
export type WrapperRule = {
  /** The wrapper's file name, as run directly or as the script a shell runs. */
  program: string;
  /** First arguments that print and exit without queueing anything, such as `--status`. */
  ignoreArgs: string[];
  /** Text added to the journal line naming the process; `{{pid}}` and `{{dir}}` (its working directory's name) are filled in. */
  hint: string | null;
};

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash"]);

/**
 * Whether a process command line is a wrapper `rule` describes. It checks the program being run, never
 * the text: a shell whose long command merely mentions the program is not a wrapper.
 *
 * @example
 * const rule = { program: "jobq", ignoreArgs: ["--status"], hint: null };
 * isWrapper("bash /home/u/.local/bin/jobq ./gate.sh", rule); // true
 * isWrapper("bash /home/u/.local/bin/jobq --status", rule); // false
 * isWrapper("grep jobq notes.md", rule); // false
 */
export function isWrapper(cmdline: string, rule: WrapperRule): boolean {
  const words = cmdline.split(/\s+/).filter((word) => word !== "");
  const [program = "", ...rest] = words;
  // A script with a shebang starts as `bash <path> <arguments>`.
  const [script = "", firstArgument = ""] = SHELLS.has(basename(program)) ? rest : words;
  if (basename(script) !== rule.program) return false;
  return !rule.ignoreArgs.includes(firstArgument);
}

/** The rule's hint for one wrapper process, or null when the rule has none. */
export function hintFor(rule: WrapperRule, process: { pid: number; cwd: string }): string | null {
  if (rule.hint === null) return null;
  return rule.hint.replaceAll("{{pid}}", String(process.pid)).replaceAll("{{dir}}", basename(process.cwd));
}
