/** What `autopilot init` writes: every key at its default, and the handler forms as comments to uncomment. */
export const STARTER_WORKFLOW = `# autopilot.yaml: how autopilot drives this repository.
# Read again at the start of every iteration, so an edit takes effect without a restart.
# \`autopilot validate\` checks it; \`autopilot events\` lists the events a handler can name;
# \`autopilot simulate\` replays the journal through it before you trust it.
version: 1                         # the schema this file is written for; required

prompt: prompt-execution.md        # the instructions every session is given
run_dir: .autopilot-run            # journal and transcripts (read at start only); git must ignore it

backlog:
  source: markdown                 # markdown | command: where the next row comes from
  file: docs/backlog.md
  marker: "← next"                 # the table row carrying this text is the next one

# harness: claude                  # claude | devin: the program that drives sessions
# harnesses:                       # each harness's own settings; a flag or "autopilot use" overrides one field
#   claude: { model: sonnet, effort: high }
#   devin: { model: swe-2-high, command: devin }

# plan:
#   follow_up: "/engineering-mode" # command the approved plan is sent under

# Lines stated to every session after the prompt file.
rules: []
#  - "Never end your turn to wait for the host; start the job as a background command."

preflight:
  host_check: true                 # a busy host holds a new session back
  wrappers: []                     # programs that wrap a queued or running job, which a new session waits for
  #  - program: my-job-queue       # its file name, run directly or as a script by a shell
  #    ignore_args: [--status]     # first arguments that print and exit
  #    hint: "my-job-queue cancel {{pid}} ends it"
  leftover: []                     # processes a finished session leaves, which a new one waits for
  #  - match: '\\b(vite|vitest)\\b'
  #  - { match: '\\bchrome\\b', also_match: '--headless' }

limits:
  probe: none                      # cam: end a Claude limit wait as soon as an account is usable

# wake:                            # events a watching orchestrator is woken for
#   - needs_answer
#   - needs_reply

# What happens at each event. The first handler of an event whose \`when\` holds runs its \`do\` list.
# Fields of an event: \`autopilot events\`. Actions: answer, reply, run, use, stop, yield.
on: {}
#  needs_reply:
#    - name: dont-wait
#      when: { why: no_commit, lastMessage: { matches: "[Ww]ait" } }
#      do:
#        - reply: "Continue the task. Do not end your turn to wait; run the wait as a background command."
#  needs_answer:
#    - name: take-the-recommended
#      when: { questions.header: { matches: "^Device$" } }
#      do: { answer: recommended }
#  iteration_done:
#    - do: { run: ["./scripts/notify.sh", "committed {{head}}"] }
#  loop_halted:
#    - do: { run: ./scripts/page-me.sh }        # the event is in AUTOPILOT_EVENT and on stdin as JSON
#  rate_limited:
#    - name: fail-over
#      when: { wakeAt: { exists: true } }
#      do:
#        - use: { harness: devin }
#        - yield: "claude is limited; the next session runs on devin"
`;
