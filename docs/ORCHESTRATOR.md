# Orchestrator runbook

The loop opens a fresh session of the chosen agent in plan mode, gives it the repository's prompt file, answers nothing itself, lets the session leave plan mode, waits for its commit and starts the next. A headed Claude Code session is the orchestrator: it reads the loop's events and answers what only judgement can. The answering policy, and any standing rule about demos, belong to each repository (its `AGENTS.md` and its config's `standingRules`); this file is only how to run the loop.

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

## Choosing the agent

The workflow's `harness` and `harnesses` say it ([workflow.md](workflow.md#harness-model-effort-and-command)); `--harness claude|devin`, `--model <id>`, `--effort <value>` override it at start, one field at a time. To switch while the loop runs, change the choice between iterations, never inside one:

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

- Never poll. The Monitor (`autopilot watch`) is the only wake-up.
- One short action per event: grep the one PRD or ADR row a question names, run one `autopilot` command, say nothing else.
- Start a fresh orchestrator session every few iterations, and use a small model for it. The journal and `autopilot status` carry all state.
- A question whose Recommended option follows the repository's policy needs no long reasoning; measured, an orchestrator chose that option for 10 of the 18 questions that had one.

## Events and what to do

| Event | Meaning | Do |
| --- | --- | --- |
| `iteration_started`, `iteration_done` | One session began; one ended with a new commit and a clean tree | Report the commit in one line |
| `needs_answer {id, questions}` | The agent asked a multiple-choice question and waits | `autopilot answer <id> --why "<evidence>" "<label>" ...`, one label per question; `--why` is journaled. A label that is not an offered option is sent as the question's own "Other" text (the command says so). The command refuses an id that nothing waits on, a reply to a question, a wrong number of labels, and any answer when no loop runs, and writes nothing then. Ids are unique in a run directory (`q5` is never asked twice). ESCALATE when it needs the user |
| `needs_answer_overdue` | Ten minutes without an answer | ESCALATE. At 60 minutes the loop answers with the option marked Recommended, else the first, and logs `answer_defaulted` |
| `needs_reply {id, why, lastMessage}` | The agent stopped in plan mode, or in bypass with no commit or a dirty tree | `autopilot reply <id> --why "<reason>" "<text>"`. At 10 minutes the loop sends a fixed nudge and logs `reply_defaulted` |
| `awaiting_work` | The agent ended its turn while a background command it started still runs | Nothing: the loop watches for the exit, then tells the agent how it ended |
| `possibly_hung` | 45 minutes without a frame, or a background command beyond its 3 hour ceiling | Read the newest `acp-*.jsonl` tail; `autopilot stop` if stuck. The loop cancels after 3 hours of silence |
| `rate_limited {wakeAt}` | A usage limit hit; the loop waits | Nothing |
| `limit_cleared {early}` | The probe saw the account usable again (`early` is true before `wakeAt`) and the loop went on | Nothing |
| `rate_limit_rejected` | Claude Code reported a rejected limit with its type and reset time | Nothing. Without a probe a seven-day limit becomes `loop_halted`; with one it is waited out |
| `preflight_wait {reason}` | A new session is held back: a busy host, or a leftover process or a wrapped job | Nothing for a busy host. For a leftover, look at it and tell the user; never kill what you did not start |
| `permission_requested` | The permission mode still asked about a tool; the loop allowed it once | Read the tool. ESCALATE if destructive or outside the repo |
| `background_watch_error {shellId, error}` | The loop could not read a background command's output file | Look at the file the error names. Never edit it by hand |
| `exit_plan_bypass_missing`, `exit_plan_reject_missing {offered}` | Leaving plan mode did not offer bypass, or declining was not offered; the iteration halts | ESCALATE with the offered option ids |
| `agent_signal` | A notification or session update nobody has read yet | Note its payload in your report |
| `agent_choice_changed`, `agent_choice_invalid` | A new `choice.json` was read, or could not be | Say it; fix an invalid one with `autopilot use` |
| `agent_stopped {cause}` | Devin ended its turn for a reason other than completing | Read `cause`; a limit or error is followed by the loop's own wait or retry |
| `plan_approved {via}` | The loop declined the plan exit, left plan mode and handed the agent its plan under the follow-up command | Nothing |
| `loop_signalled {signal}` | The loop received SIGTERM, SIGINT or SIGHUP and exited (a service stop or a shutdown) | Nothing; the next start journals `iteration_interrupted` |
| `loop_halted {reason}` | Refusal, repeated stalls or crashes, session setup failure, or a weekly limit with no probe | ESCALATE with the reason; do not restart without looking |
| `workflow_applied`, `workflow_error`, `workflow_invalid` | A workflow handler ran, one of its actions failed, or the workflow file could not be read at an iteration start (the previous one stays) | `workflow_error` and `workflow_invalid` name the handler or path: fix the workflow file; the loop reads it again at the next iteration |
| `iteration_yielded {reason}` | A workflow handler ended the iteration on purpose (for example to fail over to the other agent); its work is in the tree | Nothing; the next session picks the work up |
| `backlog_exhausted`, `stop` | No row carries the marker, or `autopilot stop` was run | Done: end the goal |

## Facts the loop relies on

Measured against `claude-agent-acp 0.91.0` driving `claude 2.1.325` (2026-11-13) and `devin 3000.12.57` (2026-11-16); the recorded frames are in `testdata/autopilot-frames/`. A new adapter version may change them, and `agent_signal` events are how that would show.

- **Claude.** A new session starts in `auto` mode; `AskUserQuestion` reaches the client only when `initialize` declares `elicitation.form`; leaving plan mode is a `session/request_permission` for `ExitPlanMode` with an `exit-plan-bypass` option. A command run with `run_in_background` ends its tool call at once and names an output file that ends with `[exited with code N]`, or `[killed]` (no code) when Claude Code stopped it, so the loop watches the file. A rate limit is `rate_limit_info` (`status` `rejected`, `resetsAt` in epoch seconds, `rateLimitType` `five_hour` or `seven_day*`) on a `usage_update`'s `_meta["_claude/rateLimit"]`; each usage frame also carries the session's running `cost` in USD.
- **Devin.** `session/new` lists `configOptions` (`mode`, `model`, `thought_level`); `initialize` must declare `_meta["cognition.ai/clientProvidedModels"]` or a model variant silently runs its family's default. Leaving plan mode is a `session/request_permission` that names its tool call only by id, with options `plan_accept_edits`, `plan_bypass` and `reject_once`. A background command reports its own exit. A limit is an error text; "monthly usage limit" halts the loop. Usage frames carry token counts per model call, sent twice, and no cost.
