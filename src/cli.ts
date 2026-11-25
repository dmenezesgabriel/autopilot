import { runCtl } from "./ctl.ts";
import { isEntryPoint } from "./entry-point.ts";
import { main as runLoop } from "./run.ts";
import { events, init, pending, readVersion, simulateCommand, validate, waitCommand, watch } from "./workflow-commands.ts";

const USAGE = `autopilot: drives an ACP coding agent through a repository's backlog, one session per commit.

usage: autopilot <command> [--repo <dir>] ...

  run [flags]        start the loop (flags: --harness --model --effort --agent-command --prompt --workflow
                     --run-dir --plan-follow-up)
  init               write a starter autopilot.yaml
  validate           read autopilot.yaml and say what it does
  events [--json]    every event a workflow can name, with its fields
  simulate           replay the journal through the workflow, running nothing
  status             what runs, what waits, what finished
  pending            the questions and replies still waiting, as JSON
  watch              print, as JSON lines, the events an orchestrator must act on
  wait [--timeout s] print the next such event and return (exit 124 after --timeout s, default 270)
  answer <id> [--why <reason>] <label>...
  reply <id> [--why <reason>] <text>
  use <harness> [--model <id>] [--effort <value>] | use --reset
  stop
  report [--json]
  service print|install [run flags]
  --version

--repo <dir> names the repository (default: the current directory); its autopilot.yaml says everything else.`;

const CTL_COMMANDS = new Set(["status", "answer", "reply", "use", "stop", "report", "service"]);

/** Routes a command line to its command; the exit code is the loop's own for `run`, 0 or 1 otherwise. */
export async function cli(argv: string[]): Promise<number> {
  const [command = "", ...rest] = argv;
  if (command === "run") return runLoop(rest);
  if (command === "watch") return watchUntilInterrupted(rest);
  if (command === "wait") return waitUntilInterrupted(rest);
  const print = (text: string): number => (console.log(text), 0);
  if (CTL_COMMANDS.has(command)) return print(await runCtl(argv));
  if (command === "validate") return print(await validate(rest));
  if (command === "events") return print(events(rest));
  if (command === "init") return print(await init(rest));
  if (command === "simulate") return print(await simulateCommand(rest));
  if (command === "pending") return print(await pending(rest));
  if (command === "--version" || command === "-v") return print(await readVersion());
  if (command === "" || command === "--help" || command === "-h" || command === "help") return print(USAGE);
  throw new Error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
}

async function watchUntilInterrupted(args: string[]): Promise<number> {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  await watch(args, (line) => console.log(line), controller.signal);
  return 0;
}

async function waitUntilInterrupted(args: string[]): Promise<number> {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  return waitCommand(args, (line) => console.log(line), (text) => console.error(text), controller.signal);
}

export function main(argv: string[]): void {
  cli(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

/** Run as a script (`node src/cli.ts`, `node dist/cli.js`, a service unit), not only through bin/autopilot.js. */
if (isEntryPoint(import.meta.url)) main(process.argv.slice(2));
