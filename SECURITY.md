# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.

Please do not open a public issue or pull request for a vulnerability, and do not post a working exploit anywhere public before a fix is out. This project publishes no email address for reports; the advisory form is the only channel. Private vulnerability reporting is available once the repository is public on GitHub and the feature is enabled in its settings.

A report is easiest to act on when it names the autopilot version, the harness (Claude or Devin) and its version, the operating system, and the steps that reproduce it.

## What to expect

Autopilot has one maintainer. We aim to acknowledge a report within 7 days. We make no promise about how long a fix takes. The advisory credits the reporter unless they ask us not to.

## Supported versions

Only the latest release, and the `main` branch, are supported.

## What autopilot does that you should know before running it

Autopilot drives a coding agent with its permission prompts turned off, and it runs commands that a repository's own files name. Both are by design and both are the trust boundary.

- **The agent runs in bypass mode.** After a plan, the loop moves the session to the harness's bypass mode (`bypassPermissions` for Claude, `bypass` for Devin) so it can work unattended. From then on the agent runs shell commands and edits files in the repository with your permissions, with no prompt. Run autopilot only on repositories and with harness accounts you are prepared to let an agent change.
- **`autopilot.yaml` is executable configuration.** A `run` action, a `backlog.command`, and a `wrappers` or `leftover` rule's matching all come from that file. A command runs with your permissions, in the repository, each time it applies. A shell text (`run: "..."`) takes no `{{field}}` substitution, because fields such as `lastMessage` are written by the agent and would otherwise reach a shell; use the argument-list form, or read the event from `AUTOPILOT_EVENT`. Run autopilot only on a repository whose `autopilot.yaml` you trust, as you would run its build scripts.
- **A printed backlog id is validated.** The first line a `backlog.command` prints must be one line of printable characters, at most 200; anything else is refused before it reaches the journal.
- **The run directory is private.** It holds the agent's whole transcript (file contents and command output the agent saw) and the files that steer the loop: answers, the stop request and the harness choice. It is created with mode `0700`, and a directory an older version left more open is tightened when the loop next starts. Nothing is redacted from the transcript or the journal, so anything the agent printed, including a secret it read, is in them. Do not share or commit the run directory; the default `.autopilot-run/` belongs in `.gitignore`.
- **The limit probe runs `cam`.** With `limits.probe: cam` the loop runs `cam status --json` once a minute during a usage-limit wait, and reads only the usage figures it prints.

## What is in scope

- A way for text an agent or a harness produces to reach a shell, a file path or a command line of the loop without the operator having written it.
- A way for another local user to read the run directory or to write to it (answer a question, stop or redirect the loop).
- A way for a malformed `autopilot.yaml`, journal or choice file to make the loop run something other than what the file says.

## What is out of scope

- What an agent does in bypass mode in a repository you pointed it at. That is the documented trust boundary.
- A `command` or `run` in an `autopilot.yaml` you chose to run.
- Vulnerabilities in a harness (`claude-agent-acp`, `devin`) or in `cam` themselves; report those to their projects.
