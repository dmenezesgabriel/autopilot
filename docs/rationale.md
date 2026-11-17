# Why autopilot works the way it does

Autopilot's design comes from running coding-agent loops, not from theory. This page records what was measured, which change each measurement led to, and which ideas were tested and rejected, so a change is not rebuilt on the same hunch.

**Method.** Four days of three loops (each driving one repository's backlog), two harnesses (Claude and Devin) and three subscription accounts, sharing one 8-core machine. Every figure joins records by exact keys: a journal's `session_started.sessionId` names its transcript, the commit heads a journal recorded bound an iteration's commits (`git rev-list --count <start>..<done>`), and the host's job-queue and account-manager logs give per-job and per-account readings. No figure is a clock window or a guess at what a command meant. `autopilot report` recomputes the first block from any run directory.

## Changes, and the measurement behind each

| Finding | Measurement | Change |
| --- | --- | --- |
| Loops stayed down after the machine came back | 8 of 15 interrupted iterations followed a host shutdown; loops stayed down 22.1 h after the host returned, 20.7 h of it one event | `autopilot service install` writes a systemd user unit that starts with the session and restarts a crash or kill, never the loop's own circuit-breaker halt |
| Deaths left no trace | 4 of 15 interrupted iterations left no journal line and no log | the loop journals `loop_signalled` on SIGTERM, SIGINT and SIGHUP |
| Loops slept through a limit while another account had headroom | 5 rejections in four days; 708 min slept, of which 477 minutes ended with an account under 85% on both its windows (the cutoff chosen for that count). 19 of 65 Claude sessions changed account mid-session | a limit wait asks a probe whether the live account is usable every minute and stops at the first yes (`limits.probe`) |
| A weekly limit halted a loop for hours | one loop halted 28.8 h and another 5 h on one account's 7-day limit while a different account ran | with a probe, a weekly limit is waited out; without one it still halts |
| A fix lived in one fork only | of 17 shared modules only 3 were byte-identical across the three forks | one shared program; what differs per repository is one `autopilot.yaml` |
| A busy host was reported every minute | 192, 150 and 367 `preflight_wait` events in the three journals | a blocker is reported once per cause, repeated when the cause changes or goes stale |
| Prompt text needed a deploy | six commits changed only a session's standing text, and a running loop holds that text in memory | `rules:` in the workflow, re-read at the start of every iteration |
| An orchestrator was woken for reports | of 160 events a `tail \| grep` filter sent, 40 (25%) needed judgement, 93 (58%) were `iteration_done` reports | `on:` handlers (a report is a command, a routine answer is a rule) and `autopilot watch`, which wakes only for the wake list and skips what a handler answered: 51 events on the same journals |
| An edit to a harness choice did nothing once a choice file existed | the start-up code read the stored choice before the workflow's setting, so the workflow was consulted only when no choice file existed | each of harness, model, effort and command resolves on its own: flag, then `autopilot use`, then the workflow, then the harness's default |
| Numbers lived in scratch scripts | every figure here was first computed by throwaway code | `autopilot report` |

## What the data showed and the loop does not change

- **Where the time goes.** For one harness 99% of an iteration was inside agent turns (foreground tools 62%, the model 37%), with 24 foreground calls over 10 minutes. For the other, 78% was the loop waiting between turns on background jobs, which costs no tokens. The time is in a repository's own checks, not in the agent.
- **Contention.** Time queued per hour of job runtime: 0.50, 0.23 and 0.10 across the three repositories. Of seven commands that ran both alone and overlapped, six were slower overlapped (median ×1.17); the sample is small. CPU stall did not change the share of failing jobs.
- **Compaction.** Across 42 iterations of one harness, context compactions and LLM calls per commit correlate (Spearman 0.63, 90% interval 0.44 to 0.76): an association, not a cause.
- **Orchestrator cost.** Three measured orchestrator sessions cost at least $90.80 against $129.85 for the 66 loop sessions, at 1,863 to 3,196 messages each. A lower bound, since a session's recorded cost restarts when it is resumed.
- **Answers.** Of 30 answers given by an orchestrator, 18 had an option marked Recommended: 10 chose it, 3 chose it with added conditions, 5 differed.

## Tested and not adopted

- **A per-iteration wall-clock cap.** Replaying caps on 115 iterations (156 h, 152 commits): a 120-minute cap would save 36% of the time and lose 25% of the commits; 240 minutes saves 19% and loses 12%. Commit yield after 90 minutes is about half the early rate, not zero. Gaps between commits have a median of 30 minutes and a 95th percentile of 212.
- **A no-progress cutoff.** Ending an iteration 60 minutes after its last commit would have saved 17.4 h and lost 10 commits.
- **A quota threshold.** The weekly window moved about 1.03 points per reported dollar (R² 0.30, 47 sessions) on an account shared with other work. No threshold is justified by it; the probe uses only the account's own rule, not exhausted.
- **Tool-call loop detection.** In 115 sessions and 11,669 shell calls, no window of 10 consecutive calls repeated with a period of 1 to 3. The count is a lower bound: command text was truncated and a non-shell call breaks a run.
- **Resuming an interrupted session instead of planning again.** The iteration after an interruption had a plan phase of 1.6 minutes against 2.3 for the others, and a shorter wall time (26 against 39 minutes). Its Claude cost was higher ($1.70 against $1.27) on only 6 sessions. There is no measured cost to remove.
- **Retrying only transient failures.** An authentication error that a harness reported was retried three times and then succeeded, because an account switch had completed in between. Classifying it as permanent would have halted a working loop.

## How it is validated

No check below spends a model token. Unit tests use fake clocks and fake ports, and the recorded frames of each harness in `testdata/`. The loop itself is exercised by `src/integration.test.ts`, which runs the real `autopilot run` in a throwaway git repository against `testdata/fake-claude-acp.mjs`, a scripted agent built from frames recorded from `claude-agent-acp 0.91.0`. Its scenarios: two rows from start to `backlog_exhausted`; the prompt, rules and plan follow-up an agent receives; a question answered by rule; a reply given by rule; a command run on the last event before exit; a workflow edited mid-run reaching the next session; an invalid edit rejected with the previous workflow kept; a limit ended by a handler's `yield`; a repository with no backlog file taking its rows from a command; `autopilot report` over the result. The generated systemd unit was run on a real user manager: `kill -9` of the loop was followed by a restart, and `systemctl --user stop` ended inactive with result `success` and no restart.

One real run followed: a throwaway repository with one row, `autopilot run` on the cheapest Claude model. An unknown model halted the loop before any token was spent, listing the models the harness offers. With a valid one the loop planned, approved, committed, journaled `iteration_done` and `backlog_exhausted`, and exited 0 in under a minute for $0.07, as `autopilot report` read from the session's usage frames.

## Not measured

Devin end to end (its dialect is tested on recorded frames, its loop core is the same as the Claude one); the dollar cost of a Devin session (its database records none); Claude LLM calls per commit; the cause of 4 loop deaths; why about 8.5% of Devin input tokens were cache-cold (12 of 1,594 cold calls followed an idle gap over 5 minutes, so idle time does not explain them).
