/**
 * What the loop needs to know about an agent session, normalised from the
 * wire frames of whichever agent runs. Each agent's dialect produces these;
 * the ledger, the handlers and the loop read nothing else.
 */
export type AgentSignal =
  | { type: "tool_started"; toolCallId: string; title: string }
  | { type: "tool_finished"; toolCallId: string }
  /** The shell command a tool call carries; it arrives in a frame of its own, before the call finishes. */
  | { type: "tool_command"; toolCallId: string; command: string }
  /** The id Claude Code gave a command it moved to the background. */
  | { type: "background_task_id"; toolCallId: string; taskId: string }
  /** The text a tool call returned; for a backgrounded command it names the file the output goes to. */
  | { type: "tool_output"; toolCallId: string; text: string }
  | {
      type: "background_started";
      shellId: string;
      /** The tool call the shell was backgrounded from; null when the agent does not name one. */
      toolCallId: string | null;
      command: string;
      /**
       * The command as the harness spawned it, when it differs from the
       * reported `command`: devin's exec runs `bash -c <rawInput.command>` and
       * its `backgroundCommand` meta can be a rewritten form, so a process's
       * argv is matched against both.
       */
      rawCommand: string | null;
      /**
       * True when the harness itself moved a foreground call to the background
       * (devin's ~10s exec timeout), rather than the model asking for it. The
       * lost-terminal_exit race lives in that transition, so only these shells
       * are checked against the kernel process table.
       */
      auto: boolean;
      /** The file the command's output goes to; null when the agent reports the command's exit itself. */
      outputPath: string | null;
    }
  | {
      type: "background_exited";
      shellId: string;
      exitCode: number | null;
      /**
       * "liveness" when the loop proved the process gone from the kernel's
       * table after the agent never reported the exit; unset when the agent
       * reported it normally.
       */
      via?: "liveness";
    }
  | { type: "agent_message"; text: string }
  | { type: "mode_changed"; mode: string }
  | { type: "plan_proposed"; plan: string }
  | {
      type: "rate_limit";
      status: string;
      resetsAtMs: number | null;
      limitType: string | null;
    }
  /** The agent ended its turn of work, with the cause it gave. */
  | { type: "agent_stopped"; cause: string }
  | { type: "vendor"; method: string; params: unknown };
