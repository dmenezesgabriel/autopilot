# autopilot

A command-line tool that drives an ACP coding agent (Claude through `claude-agent-acp`, Devin through `devin acp`) through a repository's backlog: a fresh session per backlog row, in plan mode, handed the repository's prompt file, its questions answered by an orchestrator or by rules the repository wrote, until it commits with a clean tree; then the next session. It contains no model. Its journal (`events.jsonl`) is the only state, so a restarted loop loses nothing.

Install it once; each repository keeps one file, `autopilot.yaml`, and no copy of the code. What the file can say is in [docs/workflow.md](docs/workflow.md); why it works this way, with the measurements, is in [docs/rationale.md](docs/rationale.md); how an orchestrating agent runs it is in [docs/ORCHESTRATOR.md](docs/ORCHESTRATOR.md).

## Install

Needs Node 22.12 or newer.

```sh
cd autopilot        # this repository's checkout
npm ci && npm run build      # compiles src/ to dist/
npm install -g .             # puts `autopilot` on PATH (a link to this checkout)
autopilot --version
```

To hand it to another machine, `npm pack` makes a `autopilot-<version>.tgz` that `npm install -g` takes. Updating is `git pull && npm run build`; every repository gets the new loop at its next start, and a new `autopilot.yaml` at its next iteration.

## Use it on a repository

```sh
cd path/to/your-repo
autopilot init                # writes a starter autopilot.yaml (or copy one from examples/)
autopilot validate            # says what it will do
autopilot simulate            # replays this repository's journal through it, running nothing
autopilot run --harness devin   # starts the loop; or, as a service that survives reboots:
autopilot service install --harness devin
systemctl --user daemon-reload && systemctl --user enable --now autopilot-your-repo.service
```

Every command takes `--repo <dir>` (default: the current directory) and finds the run directory from that repository's workflow.

| Command | Does |
| --- | --- |
| `run [flags]` | start the loop (`--harness --model --effort --agent-command --prompt --workflow --run-dir --plan-follow-up`; flags override the workflow, one field at a time) |
| `init`, `validate`, `events`, `simulate` | write, check, and try a workflow; list the events it can name |
| `guide` | the orchestrator's brief for this repository: commands with the path filled in, the events that wake it and what each needs, the rules, where to keep notes |
| `status`, `pending`, `watch`, `wait` | what runs and waits; the open questions as JSON; JSON lines for the events an orchestrator must act on; the next such event, one call per wake-up |
| `answer <id>`, `reply <id>` | answer a question or reply, with `--why` |
| `use <harness>`, `use --reset`, `stop` | override the next session's harness, model or effort (or remove the override) and print what the next session will run on; finish the current iteration and exit (said plainly when no loop runs) |
| `report [--json]` | iterations, commits, hours, cost, calls, compactions, restarts, limit waits, and where the time of finished iterations went (in a turn, idle for background commands, for an answer, for a limit; held by preflight) |
| `service print\|install` | the systemd user unit that starts the loop at boot and restarts a crash (Linux with systemd; elsewhere `run` under your own supervisor, such as launchd) |

`stop` ends the loop; the unit does not bring it back until the next boot. To keep it down across a reboot, `systemctl --user disable` the unit.

## The workflow in one view

```yaml
backlog: { marker: "**open ← next" }
plan: { follow_up: "/engineering-mode" }
rules: ["Never end your turn to wait for the host; start the job as a background command."]
preflight:
  wrappers: [{ program: jobq, ignore_args: [--status] }]
  leftover: [{ match: '\b(vite|vitest)\b' }]
limits: { probe: cam }
on:
  needs_reply:
    - when: { why: no_commit, lastMessage: { matches: "[Ww]ait" } }
      do: { reply: "Continue the task. Do not end your turn to wait." }
  iteration_done:
    - do: { run: ["./scripts/notify.sh", "committed {{head}}"] }
  loop_halted:
    - do: { run: ./scripts/page-me.sh }
```

`examples/` holds four complete workflows to copy from: a minimal one, one with guardrails and handlers, one that fails over between harnesses, and one for a repository whose work is not a markdown table.

## Layout

| Path | Holds |
| --- | --- |
| `src/cli.ts`, `bin/autopilot.js` | the one command and its routing |
| `src/run.ts`, `src/session.ts`, `src/iteration.ts`, `src/decide.ts` | the loop, one session, one iteration, and the one place a turn's end becomes an action |
| `src/workflow*.ts`, `src/conditions.ts`, `src/event-registry.ts`, `src/simulate.ts` | the workflow schema, its handlers and engine, and the list of events |
| `src/agents/claude`, `src/agents/devin` | what differs between agents on the wire: profile, dialect, signals, limit text |
| `src/preflight.ts`, `src/limit-probe.ts` | what holds a session back; the account probe |
| `src/report*.ts`, `src/transcript-stats.ts`, `src/watch.ts`, `src/wait.ts`, `src/guide.ts` | `report`, `watch`, `wait`, `guide` |
| `src/service-unit.ts`, `src/signal-journal.ts` | the systemd unit and the signal line in the journal |
| `testdata/autopilot-frames/` | recorded ACP frames of each agent, the fixtures its signal tests read |

## Tests

```sh
npm test          # node --test over src/**/*.test.ts
npm run typecheck # tsc
```

On a host with a job queue, run them through it. A new adapter version shows as an `agent_signal` event in the journal.
