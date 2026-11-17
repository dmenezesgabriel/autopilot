import { resolve } from "node:path";
import type { GitCli } from "./git-probe.ts";
import type { LoopEvent, Mailbox } from "./mailbox.ts";
import type { RunDir } from "./run-dir.ts";
import type { Workflow } from "./workflow.ts";
import type { WorkflowEngine } from "./workflow-engine.ts";

/** Everything one loop run shares: the repository, its workflow as last read, and the ways to journal and ask. */
export type LoopContext = {
  repoRoot: string;
  workflowPath: string;
  /** True when a flag named the workflow file, so a missing file is an error instead of the defaults. */
  workflowRequired: boolean;
  /** Re-read at the start of each iteration, so an edit to the file takes effect without a restart. */
  workflow: Workflow;
  engine: WorkflowEngine;
  /** Flags outrank the workflow. */
  flags: { prompt: string | null; planFollowUp: string | null };
  /** `--agent-command` names the executable of the harness the loop started on; any other harness uses the workflow's `command`, else its own. */
  commandOverride: { agent: string; command: string } | null;
  runDir: RunDir;
  git: GitCli;
  mailbox: Mailbox;
  emit(event: LoopEvent): Promise<void>;
};

export function promptFileOf(context: LoopContext): string {
  return context.flags.prompt ?? resolve(context.repoRoot, context.workflow.prompt);
}

export function planFollowUpOf(context: LoopContext): string | null {
  return context.flags.planFollowUp ?? context.workflow.planFollowUp;
}
