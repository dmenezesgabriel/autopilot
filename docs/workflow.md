# Writing a workflow

A repository tells autopilot what to do in one file, `autopilot.yaml` at its root (`--workflow <file>` names another). `autopilot init` writes a starter; `autopilot validate` reads yours and says what it will do; `autopilot events` lists every event a handler can name with the fields it can read; `autopilot simulate` replays the repository's own journal through the workflow, running nothing, before you trust it.

The file is read again at the start of every iteration, so an edit takes effect on the next session with no restart. A file that no longer reads keeps the previous workflow and is journaled as `workflow_invalid`: a typo must not stop a loop that is working. Only `run_dir` is read once, because a running loop cannot move its journal.

Why these parts exist is in [rationale.md](rationale.md), with the measurements. In short: a session's standing text changed often and each change needed a deploy, so `rules:` is re-read every iteration. Most of what woke an orchestrator was a report, not a decision, so a report can be a command and a routine answer a rule. And a rule that answers by option was right only some of the time, so answering by rule is opt-in, per question, and anything a rule does not cover goes to the orchestrator.

## Keys

Every key but `version` is optional. An unknown key, a value of the wrong shape, or an event the loop never emits is an error that names its path.

### Schema version

`version` is the schema the file is written for, and it is required: put `version: 1` first. This autopilot reads version 1. A file with no `version` is refused (it could as easily be written for a later schema that omits the key), and so is a `version` that is not the integer 1. A file declaring a newer version is refused with an instruction to upgrade autopilot, never read on a guess.

The version changes only when a key is renamed or removed, or when what a key means changes. Adding an optional key does not change it, so a file written today keeps reading as new optional keys arrive. When a version 2 exists, this autopilot's release notes will say what moved, and `autopilot validate` prints the version a file declares: `ok (schema version 1)`.

```yaml
version: 1
prompt: prompt-execution.md      # instructions attached to each session's opening prompt
run_dir: .autopilot-run          # journal and agent transcripts (read at start only); add it to .gitignore
backlog:
  source: markdown               # markdown | command: where the next row comes from
  file: docs/backlog.md          # markdown only
  marker: "← next"               # markdown only: the table row (a line starting with |) carrying this text is next
  # source: command              # instead: a command prints the next row's id
  # command: "ls todo | head -1" # command only: a shell text or an argument list
  # timeout_seconds: 30          # command only: default 30
harness: claude                  # which harness drives sessions; see "Harness, model, effort and command"
harnesses:
  claude: { model: sonnet, effort: high, command: claude-agent-acp }
plan: { follow_up: "/engineering-mode" }             # the approved plan is sent under this command
rules:                           # lines stated to every session after the prompt
  - "..."
preflight:
  host_check: true               # a busy host (load above the cores, tasks stalled for memory) holds a session back
  wrappers:                      # a program that wraps a job that is queued or running (a job queue)
    - program: jobq              # file name, run directly or as the script a shell runs
      ignore_args: [--status]    # first arguments that print and exit and queue nothing
      hint: "`jobq cancel {{dir}}-{{pid}}` ends it"   # optional; {{pid}} and {{dir}} (the working directory's name) are filled in
  leftover:                      # processes a finished session leaves; a new session waits, never kills
    - match: '\b(vite|vitest)\b'
    - { match: '\bchrome\b', also_match: '--headless' }   # both must match
limits:
  probe: cam                     # none | cam, see below
wake: [needs_answer, needs_reply, loop_halted]   # what `watch` wakes an orchestrator for
on: { ... }                      # handlers, below
```

### Where the next row comes from

`backlog.source` says which of two sources is read, and exactly one is. A key that belongs to the other source is an error that names it, never an override that silently wins.

- **`markdown`** (the default): the first table row (a line starting with `|`) that carries `marker` in `file`. The id is the first column, backticks removed. Prose that mentions the marker is not a row. The marker follows the row's state, whichever it is, so a part-done item is still the one to continue.
- **`command`**: the first line the command prints, trimmed, is the id, and nothing printed means none is left. The command is a shell text (run under `sh -c`) or an argument list (run without a shell), in the repository, killed after `timeout_seconds`. The id must be one line of printable characters, at most 200: it goes into the journal, so what a command prints is not trusted.

Both obey the same rules, which are what keep the loop safe:

- **Read once.** The loop reads the source once per check and uses that answer: the row journaled on `iteration_started` is the row preflight saw, and a command that is slow, costly or not idempotent runs once, not twice.
- **Never an empty answer by accident.** A missing file, a failing or timed-out command and an invalid id are errors. They are never read as "no work left", which would end the loop quietly.
- **A failing source waits, it does not stop the loop.** The loop journals a `preflight_wait` saying the backlog could not be read and why, once per cause (again after ten minutes), rechecks every minute, and goes on when the source answers. Only `autopilot stop` or a source that says nothing is left ends it.
- **Exhaustion is visible.** When nothing is left the loop journals `backlog_exhausted` and exits 0; that event is in the default `wake` list, and `on: backlog_exhausted` can run a command. A markdown backlog whose marker was renamed also reads as exhausted, which is why the event is not silent.

The workflow file is executable configuration: a `command` here, like a `run` action, runs with your permissions every iteration. Run autopilot only on repositories whose `autopilot.yaml` you trust.

A wrapper rule exists because a session's job can outlive the session: a gate whose first steps are `tsc` and `eslint` has no name a `leftover` pattern could match, but the queue's wrapper around it stays alive until it ends. The rule checks the program being run, not the text of the command line, so `grep jobq notes.md` is not a wrapper, and a shell running the program's script is looked through (`bash /path/jobq gate.sh`). Nothing about any particular queue is built in: the program is named only in the workflow that uses it. A rule for a program that is not run directly or by `bash`, `sh`, `zsh` or `dash` (an interpreter such as `python3 taskq`) cannot see it; use a `leftover` pattern there.

Leftover detection reads `/proc`, so it sees nothing off Linux; the busy-host check reads the load from the OS and the memory stall from Linux's pressure file when the kernel has one, and a host it cannot read is not busy. Neither can stop the loop.

`limits.probe: cam` makes a Claude usage-limit wait end the first minute `cam status --json` shows the live account usable, instead of sleeping to the agent's reset time. It applies to Claude sessions only and, with it, a weekly limit is waited out instead of halting the loop.

`wake` defaults to the decisions (`needs_answer`, `needs_reply`) and the events that need a person (`loop_halted`, `iteration_stalled`, `iteration_halted`, `iteration_crashed`, `possibly_hung`, `hung_cancelled`, `needs_answer_overdue`, `exit_plan_*_missing`, `background_watch_error`, `backlog_exhausted`) and the alerts that only a person's edit can cure (`agent_choice_invalid`, `workflow_invalid`, `workflow_error`). It leaves out reports such as `iteration_done` and the alerts the loop already handled itself (`answer_defaulted`, `permission_requested`, `rate_limited`). `autopilot events` lists every event with its kind; each alert declares in the registry whether it wakes.

## Harness, model, effort and command

The workflow says which harness (the agent program) drives sessions and what each one runs on:

```yaml
harness: claude                 # claude | devin; default claude
harnesses:                      # each harness's own settings
  claude: { model: sonnet, effort: high, command: claude-agent-acp }
  devin:  { model: swe-2-high, command: devin }
```

`command` is the executable (default: the harness's own, found on `PATH`). A model or effort left out is the harness's own default. They are per harness because a model one harness offers is not one another does: switching harness uses that harness's settings, and never carries a model across.

Each of the four resolves on its own, highest first:

| Source | How it is given | Lifetime |
| --- | --- | --- |
| `autopilot use <harness> [--model <id>] [--effort <value>]` | an operator, while the loop runs | until `autopilot use --reset` |
| flags of `autopilot run`: `--harness` (or `--agent`), `--model`, `--effort`, `--agent-command` | an operator, at start | `run` writes the first three into the same override, changing only the fields named and keeping the rest of what `use` set (so restarting with `--harness devin` keeps the model; naming a different harness drops the old model and effort), so they last until `use --reset`; `--agent-command` lasts for that process |
| the workflow's `harnesses.<harness>` and `harness` | the file, re-read every iteration | until edited |
| the harness's own default | | |

An override says only what it names: `--model haiku` changes the model and leaves the harness and effort to the workflow, and a later edit to the workflow's harness still takes effect. `autopilot use --reset` removes the override, so the workflow decides again. A model or effort the harness does not offer halts the iteration before any token is spent, listing what it offers.

## Handlers

```yaml
on:
  <event>:
    - name: optional-name          # shown in the journal; default <event>#<position>
      when: { <field>: <test>, ... }   # all must hold; omitted means always
      why: text recorded with an answer or reply this handler gives
      do:                              # an answer or reply is written first, then the rest in order;
                                       # a failed action is journaled and the next still runs
        - <action>
```

For an event, the **first handler whose `when` holds** runs. A `needs_answer` handler whose rule finds no option for some question does not apply, and the next handler is tried.

### `when`

A field is any field `autopilot events` lists for that event, plus `type` and `at`. A path is dotted and runs through lists: `questions.header` is the header of every question the event carries, and the test passes if any does.

| Form | Meaning |
| --- | --- |
| `why: no_commit` | equals |
| `lastMessage: { matches: "[Ww]ait" }` | JavaScript regular expression, anywhere in the text (a list or mapping is tested as its JSON) |
| `why: { in: [no_commit, dirty_tree] }` | one of |
| `waitedMs: { gte: 600000 }`, `{ lte: n }` | number comparison |
| `reason: { contains: "limit" }` | substring |
| `wakeAt: { exists: true }` | present and not null (`false`: absent) |

### Actions

| Action | On | Does |
| --- | --- | --- |
| `answer: recommended` | `needs_answer` | answers each question with its option marked `(Recommended)`; a question with no marked option is left to the orchestrator |
| `answer: first` | `needs_answer` | answers each question with its first option |
| `answer: { choose: "^arm64" }` | `needs_answer` | answers each question with the first option whose label matches |
| `reply: "text {{why}}"` | `needs_reply` | sends the text as the reply |
| `run: ["cmd", "arg {{field}}"]` | any | runs the command without a shell; `{{field}}` is filled from the event |
| `run: "shell text"` | any | runs under `sh -c`; no `{{field}}` allowed, see below |
| `run: { command: [...], timeout_seconds: 5 }` | any | the same, with its own timeout (default 60) |
| `use: { harness: devin, model: ..., effort: ... }` | any | the next session runs on that harness (what `autopilot use` does); a model or effort left out comes from the workflow's `harnesses` |
| `stop: true` | any | finish after the current iteration and exit (what `autopilot stop` does) |
| `yield: "reason {{wakeAt}}"` | `rate_limited` | end the iteration now instead of waiting out the limit; its work stays in the tree, and the next session starts on the agent `use` chose |

A command runs in the repository with the event as JSON on stdin and in `AUTOPILOT_EVENT`, and `AUTOPILOT_EVENT_TYPE`, `AUTOPILOT_REPO`, `AUTOPILOT_RUN_DIR` beside it. It never blocks the loop and is killed at its timeout. A shell text takes no `{{field}}` because fields such as `lastMessage` and `command` are written by the agent: filling them into a shell would run what the agent wrote. Use the argument-list form, or read `AUTOPILOT_EVENT`.

An answer or reply goes through the same answer files `autopilot answer` writes, so the loop cannot tell a handler from an orchestrator. The event is journaled with `handledBy: <name>`, and `watch` skips it.

### Examples

A reply an orchestrator gave by hand again and again:

```yaml
on:
  needs_reply:
    - name: dont-end-the-turn-to-wait
      when: { why: no_commit, lastMessage: { matches: "[Ww]ait" } }
      why: the wait rule
      do:
        - reply: "Continue the task. Do not end your turn to wait: start the job as a background command and carry on from its result."
```

A report as a command, and a person paged when the loop halts:

```yaml
on:
  iteration_done:
    - do: { run: ["./scripts/notify.sh", "committed {{head}}"] }
  loop_halted:
    - do: { run: ./scripts/page-me.sh }     # reads AUTOPILOT_EVENT
```

Fail over to another harness when Claude is limited, the switch that was otherwise made by hand after repeated five-hour limits:

```yaml
on:
  rate_limited:
    - name: fail-over-to-devin
      do:
        - use: { harness: devin }
        - yield: "claude is limited until {{wakeAt}}; the next session runs on devin"
```

A `yield` ends the iteration without a commit, so it counts toward the loop's no-progress breaker (two in a row halt the loop): do not yield when both agents are limited.

## Trying a workflow on history first

```sh
autopilot simulate --repo path/to/your-repo
```

prints how many events the journal holds, how many are in the wake list, how many of those the workflow's handlers would have answered, and for each handler how many events it matched, how many answers it gave, and for the questions it answers, how many equal the answer that was actually given. It runs no action.

## For an orchestrating agent

An orchestrator session needs only the CLI:

```sh
autopilot guide --repo <repo>        # start here: this repository's brief, the commands and the events, generated
autopilot watch --repo <repo>        # one JSON line per event that needs you; use it as the Monitor command
autopilot wait --repo <repo>         # the next such event, then return (exit 124 after --timeout s, default 270): one call per wake-up, for an agent with no Monitor
autopilot pending --repo <repo>      # the same, as the questions still unanswered, with their full events
autopilot answer <id> --why "..." "<label>"   # per question
autopilot reply <id> --why "..." "<text>"
autopilot status --repo <repo>       # what runs, what waits, what finished
```
