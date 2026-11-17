import { basename, dirname, join } from "node:path";

export type UnitInput = {
  /** The repository the loop drives; its directory name names the unit. */
  repoRoot: string;
  /** How this autopilot runs (node, its flags and the CLI file), so the unit runs the code it was generated from. */
  command: string[];
  home: string;
  /** Extra `run.ts` flags, such as `--agent devin --model swe-2-high`. */
  runArguments: string[];
};

export const unitNameFor = (repoRoot: string): string => `autopilot-${basename(repoRoot)}.service`;

/**
 * A systemd user unit that starts the loop at boot and brings it back when it dies. A loop started by
 * hand does not survive a host shutdown, and nothing starts it again when the host returns.
 *
 * The loop's own exit codes decide what is restarted. Exit 1 is its circuit breaker (no progress in two
 * iterations, a weekly limit, a refusal): restarting that would spend credits on a run the loop judged
 * stuck, so it is excluded. A crash (exit 2) or a kill is restarted, after a pause, at most five times an
 * hour. `systemd` reads the loop's SIGTERM stop as a normal stop.
 *
 * @example
 * renderUnit({ repoRoot: "/r/app", command: ["/n/bin/node", "/a/dist/cli.js"], home: "/h", runArguments: [] });
 */
export function renderUnit(input: UnitInput): string {
  const exec = [
    ...input.command.map(quote),
    "run",
    "--repo",
    quote(input.repoRoot),
    ...input.runArguments.map(quote),
  ].join(" ");
  return [
    "[Unit]",
    `Description=autopilot loop for ${basename(input.repoRoot)}`,
    "StartLimitIntervalSec=3600",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${input.repoRoot}`,
    `Environment=PATH=${pathFor(input)}`,
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=30",
    "RestartPreventExitStatus=1",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** The node that runs the loop also holds the agents installed beside it (`claude-agent-acp`); the user's own bin holds tools such as `cam` and `devin`. */
function pathFor(input: UnitInput): string {
  return [dirname(input.command[0] as string), join(input.home, ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
