import { EVENTS, type EventName } from "./event-registry.ts";

/** What the brief says of one repository: all read from the installed build and the repository's own files. */
export type GuideFacts = {
  repoRoot: string;
  version: string;
  runDir: string;
  /** False only when git is known not to ignore the run directory. */
  runDirIgnored: boolean;
  backlog: string;
  /** The `next session: ...` lines `validate` and `status` print. */
  nextSession: string[];
  /** The workflow's wake list: the events that need an orchestrator. */
  wake: readonly EventName[];
  packagedDoc: string;
};

const POLLING_COST =
  "A model that re-read the journal every second sent 610 requests in 9 minutes and tripped the shared free-model limit, which stopped the worker too (hits came at 651 to 929 requests an hour; the highest hour without one was 494).";

/**
 * The orchestrator's brief for one repository: who does what, the commands with the repository's path
 * filled in, what each event that wakes the orchestrator needs, and the rules. Generated, so it matches
 * the installed build, and a new session finds it with `autopilot guide` instead of being told a path.
 *
 * @example
 * describeGuide(facts); // "autopilot guide: how to orchestrate this loop (autopilot 0.1.0)\n..."
 */
export function describeGuide(facts: GuideFacts): string {
  return [
    `autopilot guide: how to orchestrate this loop (autopilot ${facts.version})`,
    ...notIgnoredWarning(facts),
    "",
    ...section("YOU ARE THE ORCHESTRATOR", [
      "The loop is a process that opens one worker session per backlog row. The worker is the coding agent: it",
      "works the row and commits. You answer what only judgement can answer. You never touch the worker's tree.",
    ]),
    ...section("THIS LOOP", thisLoop(facts)),
    ...section("YOUR WORK, STEP BY STEP (one model request per step)", steps(facts.repoRoot)),
    ...section("EVENTS THAT WAKE YOU (this workflow's wake list)", events(facts.wake)),
    ...section("RULES", rules(facts)),
    ...section("MORE", [
      `Rationale, measurements and the facts the loop relies on: ${facts.packagedDoc}`,
      "Every command takes --repo <dir>; leave it out when your shell is in the repository.",
    ]),
  ].join("\n").trimEnd();
}

function section(title: string, lines: string[]): string[] {
  return [title, ...lines.map((line) => (line === "" ? "" : `  ${line}`)), ""];
}

function notIgnoredWarning(facts: GuideFacts): string[] {
  if (facts.runDirIgnored) return [];
  return [`warning: run dir ${facts.runDir} is not ignored by git, so the journal and any notes kept there dirty the worker's tree; add it to .gitignore first`];
}

function thisLoop(facts: GuideFacts): string[] {
  const ignored = facts.runDirIgnored ? "ignored by git" : "NOT ignored by git";
  return [
    `repo:     ${facts.repoRoot}`,
    `run dir:  ${facts.runDir} (${ignored})`,
    `backlog:  ${facts.backlog}`,
    ...facts.nextSession,
  ];
}

function steps(repo: string): string[] {
  return [
    "1. When you start or resume, once:",
    `     autopilot status --repo ${repo}     what runs, what waits, what finished`,
    `     autopilot pending --repo ${repo}    the questions and replies still waiting, as JSON`,
    "2. Wait for the next event that needs you:",
    `     autopilot wait --repo ${repo}`,
    "   Exit 0: stdout is one JSON event; go to step 3. Exit 124 with no stdout: 270 s passed and nothing needs",
    "   you; call it again at once and say nothing. Consecutive calls lose no event.",
    `   (An agent with a Monitor tool can arm \`autopilot watch --repo ${repo}\` once instead.)`,
    "3. Act on the event as the list below says, then go back to step 2.",
    "",
    "Also, when needed:",
    `     autopilot answer <id> --repo ${repo} --why "<evidence>" "<label>"   one label per question`,
    `     autopilot reply <id> --repo ${repo} --why "<reason>" "<text>"`,
    `     autopilot stop --repo ${repo}      the loop exits after the current iteration; never kill it`,
    `     autopilot use <harness> [--model <id>] [--effort <value>]   the next session's agent; \`use --reset\` undoes`,
    `     autopilot report --repo ${repo}    what the run cost and shipped`,
  ];
}

/** The decisions first, since they are most of an orchestrator's work, then the escalations in registry order. */
function events(wake: readonly EventName[]): string[] {
  const decisions = wake.filter((name) => EVENTS[name].kind === "decision");
  const rest = wake.filter((name) => EVENTS[name].kind !== "decision");
  return [...decisions, ...rest].flatMap((name) => {
    const spec = EVENTS[name] as { means: string; act?: string };
    return [`${name}: ${spec.means}.`, ...(spec.act === undefined ? [] : [`    do: ${spec.act}`])];
  });
}

function rules(facts: GuideFacts): string[] {
  return [
    `Never poll: no re-reading events.jsonl, the acp logs or git refs, no sleep loops; wait with \`autopilot wait\`. ${POLLING_COST}`,
    "Never write into the repository tree. The worker commits there and treats a stray file as earlier work.",
    `Keep your notes in ${facts.runDir}/orchestrator-notes.md: that directory is the loop's own and not part of the tree.`,
    "Never kill a process you did not start, and never edit a file in the run directory by hand: the journal is the only state.",
    "Answer with --why: it is journaled, and the next orchestrator session reads it.",
    "A fresh orchestrator session needs only this guide, then status and pending. Start one every few iterations.",
  ];
}
