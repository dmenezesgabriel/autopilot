# Orchestrator runbook

The loop opens a fresh session of the chosen agent in plan mode, gives it the repository's prompt file, answers nothing itself, lets the session leave plan mode, waits for its commit and starts the next. A headed Claude Code session is the orchestrator: it reads the loop's events and answers what only judgement can. The answering policy, and any standing rule about demos, belong to each repository (its `AGENTS.md` and its config's `standingRules`); this file is only how to run the loop.

**Orchestrating a loop right now? Run `autopilot guide --repo <repo>`.** It prints this runbook's working parts for that repository, generated from the installed build, its workflow and the event registry: the commands with the path filled in, the events that wake you with what each needs, the rules, and where to keep your notes (the run directory, never the repository tree). This file holds the rationale and the measurements behind it.

## Start

`autopilot` is installed once ([README](../README.md)); a repository needs only its `autopilot.yaml`. `--repo` names the repository (default: the current directory).

```sh
# as a service that survives the shell and reboots, and restarts a crash (preferred)
autopilot service install --repo <repo> [run flags]
systemctl --user daemon-reload && systemctl --user enable --now autopilot-<repo>.service

# or by hand
nohup autopilot run --repo <repo> > /dev/null 2>&1 &
```

Start it from a shell whose PATH has `claude-agent-acp` (or add `--agent-command <absolute path>`); the generated unit puts node's own directory and `~/.local/bin` on PATH. Then, in the Claude session (auto mode):

```
/goal The loop in <repo> reported backlog_exhausted or stop, or it reported loop_halted and I looked at why. Until then: keep a Monitor armed on `autopilot watch --repo <repo>` (re-arm at each 30-minute expiry), answer every needs_answer and needs_reply per the repository's policy, push-notify me on the events marked ESCALATE, and report each iteration_done with its commit. Stop after 40 iterations.
```

`autopilot watch` prints one JSON line per event the orchestrator must act on: the events in the workflow's `wake` list that no handler has already answered. By default that is the decisions and the escalations, not `iteration_done` or `permission_requested` (69 of the 160 wake-ups the old `tail | grep` Monitor sent). A repository that wants a report of each commit puts it in its workflow as a command, `on: iteration_done: - do: { run: [...] }`, which costs no orchestrator turn. `autopilot pending` lists what is still unanswered, with each full event, when a session starts or resumes.

An orchestrator whose agent has no Monitor tool (a Devin session, for one) waits with `autopilot wait --repo <repo>` instead: it prints the next such event and returns at once, or exits 124 with no output after `--timeout` seconds (default 270, the longest single wait a Devin orchestrator has been seen to block on). One call is one model request, whatever the wait. A cursor in the run directory (`wait.cursor`) makes consecutive calls lossless: an event written between two calls is delivered by the next, in order, and the first call starts at the end of the journal, like `watch`. Do not build this from `autopilot watch | head -n 1`: measured, the pipeline returns only when `watch` exits, so every answer waits out the whole timeout, and an event written between two such calls is lost.

## Choosing the agent

The workflow's `harness` and `harnesses` say it ([workflow.md](workflow.md#harness-model-effort-and-command)); `--harness claude|devin`, `--model <id>`, `--effort <value>` override it at start, one field at a time: a flag changes only the field it names and keeps the rest of the override `autopilot use` set, except that naming another harness drops the old model and effort. A restart needs no flag when `autopilot.yaml` already names the harness. To switch while the loop runs, change the choice between iterations, never inside one:

```sh
autopilot use devin --model swe-2-high --effort high --repo <repo>
autopilot use claude --repo <repo>
autopilot use --reset --repo <repo>   # the workflow decides again
autopilot status --repo <repo>      # "next session: ..." is worked out now from the workflow and choice.json (an override line says so); "session <id> on ..." is what the open session runs on
```

A model or effort the harness does not offer halts the iteration with the offered values listed. `autopilot use` and the flags of `run` write `choice.json`; whatever it leaves unsaid comes from the workflow, and then from the harness's own default.

## Nothing is lost: the journal is the only state

`events.jsonl` is append-only and holds every question, answer, session, mode change, background command, limit wait and iteration outcome. `autopilot status` rebuilds from it. A new orchestrator session starts with `autopilot status` and `autopilot pending`, re-arms the Monitor, and answers what it lists. If the loop died mid-iteration, the next start journals `iteration_interrupted` and opens a new session; nothing in the tree is discarded. Each session's frames are in `<run dir>/acp-<timestamp>.jsonl`; never delete the run directory while a loop runs.

`autopilot report --repo <repo>` is the measurement (an interrupted or crashed iteration counts to its last activity, never to the restart that recorded it): per agent and outcome, iterations, commits (counted from the heads the journal recorded), hours, Claude cost, Devin calls per commit, compactions; the restarts after a run that did not end by a stop, a signal or an empty backlog; the limit waits and how many the probe ended early.

## Keeping the cost low

Measured on three loops (see [rationale.md](rationale.md)), the orchestrator sessions cost a large share of the total, because each ran thousands of messages. So:

- Never poll. The Monitor (`autopilot watch`), or one `autopilot wait` call per wake-up where there is no Monitor, is the only wake-up. A model that re-reads the journal every second spends a request each time: one Devin orchestrator sent 610 requests in 9 minutes that way and tripped the account's free-model limit for the worker too (that limit is shared across the free SWE models; the highest rolling hour without a hit was 494 requests across all repos, the hits came at 651 to 929).
- One short action per event: grep the one PRD or ADR row a question names, run one `autopilot` command, say nothing else.
- Start a fresh orchestrator session every few iterations, and use a small model for it. The journal and `autopilot status` carry all state.
- A question whose Recommended option follows the repository's policy needs no long reasoning; measured, an orchestrator chose that option for 10 of the 18 questions that had one.

## Events and what to do

The events that wake an orchestrator, each with what it needs, are printed by `autopilot guide`; they are written once, as the `act` of each event in `src/event-registry.ts`, so this file cannot disagree with the loop. `autopilot events` lists every event a workflow can name, with its fields and meaning. An event that is not in the workflow's `wake` list never needs you: the loop reads `iteration_started`, `iteration_done`, `rate_limited`, `preflight_wait`, `awaiting_work` and the like by itself, and `autopilot report` summarises them. A repository that wants a report of each commit puts it in its workflow as a command (`on: iteration_done`), which costs no orchestrator turn.

Two behaviours worth knowing, from the loop's own code and measurements: an answer to an id that nothing waits on is refused and writes nothing, and ids are unique in a run directory (`q5` is never asked twice), so a late answer cannot land on the wrong question.

## Facts the loop relies on

Measured against `claude-agent-acp 0.91.0` driving `claude 2.1.325` (2026-11-13) and `devin 3000.12.57` (2026-11-16); the recorded frames are in `testdata/autopilot-frames/`. A new adapter version may change them, and `agent_signal` events are how that would show.

- **Claude.** A new session starts in `auto` mode; `AskUserQuestion` reaches the client only when `initialize` declares `elicitation.form`; leaving plan mode is a `session/request_permission` for `ExitPlanMode` with an `exit-plan-bypass` option. A command run with `run_in_background` ends its tool call at once and names an output file that ends with `[exited with code N]`, or `[killed]` (no code) when Claude Code stopped it, so the loop watches the file. A rate limit is `rate_limit_info` (`status` `rejected`, `resetsAt` in epoch seconds, `rateLimitType` `five_hour` or `seven_day*`) on a `usage_update`'s `_meta["_claude/rateLimit"]`; each usage frame also carries the session's running `cost` in USD.
- **Devin.** `session/new` lists `configOptions` (`mode`, `model`, `thought_level`); `initialize` must declare `_meta["cognition.ai/clientProvidedModels"]` or a model variant silently runs its family's default. Leaving plan mode is a `session/request_permission` that names its tool call only by id, with options `plan_accept_edits`, `plan_bypass` and `reject_once`. A background command reports its own exit. A limit is an error text; "monthly usage limit" halts the loop. Usage frames carry token counts per model call, sent twice, and no cost.
