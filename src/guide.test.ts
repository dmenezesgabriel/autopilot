import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { cli } from "./cli.ts";
import { runCtl } from "./ctl.ts";
import { EVENTS, defaultWakeEvents, type EventName } from "./event-registry.ts";
import { describeGuide, type GuideFacts } from "./guide.ts";
import { guide, init } from "./workflow-commands.ts";

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({
  repoRoot: "/work/app",
  version: "9.9.9",
  runDir: "/work/app/.autopilot-run",
  runDirIgnored: true,
  backlog: "docs/backlog.md (marker \"← next\")",
  nextSession: ["next session: devin, model swe-2-flash-high, effort default"],
  wake: ["needs_answer", "needs_reply", "loop_halted"] as EventName[],
  packagedDoc: "/usr/lib/node_modules/autopilot/docs/ORCHESTRATOR.md",
  ...over,
});

describe("the event registry says what an orchestrator does, so no prose table can drift from it", () => {
  it("every event that wakes an orchestrator by default carries an `act`, in a sentence", () => {
    for (const name of defaultWakeEvents()) {
      const act = (EVENTS[name] as { act?: string }).act;
      assert.ok(typeof act === "string" && act.length > 20, `${name} wakes an orchestrator but has no \`act\` saying what to do`);
    }
  });
});

describe("autopilot guide: the orchestrator's brief, for this repository", () => {
  it("names the repository and the commands with its path filled in, so each can be run as printed", () => {
    const text = describeGuide(facts());

    for (const command of ["status", "pending", "wait", "watch", "stop"]) assert.match(text, new RegExp(`autopilot ${command} --repo /work/app`));
    assert.match(text, /autopilot answer <id> --repo \/work\/app --why "<evidence>" "<label>"/);
    assert.match(text, /autopilot reply <id> --repo \/work\/app --why "<reason>" "<text>"/);
  });

  it("states this loop's facts: run directory, backlog, next session, version", () => {
    const text = describeGuide(facts());

    assert.match(text, /autopilot 9\.9\.9/);
    assert.match(text, /run dir: {2}\/work\/app\/\.autopilot-run \(ignored by git\)/);
    assert.match(text, /backlog: {2}docs\/backlog\.md/);
    assert.match(text, /next session: devin, model swe-2-flash-high/);
  });

  it("lists the events of this repository's wake list with what to do, and no others", () => {
    const text = describeGuide(facts());

    assert.match(text, /needs_answer: .*\n\s+do: .*autopilot answer/);
    assert.match(text, /loop_halted: .*\n\s+do: Escalate/);
    assert.doesNotMatch(text, /possibly_hung/);
  });

  it("puts the decisions first, whatever order the wake list has, since they are most of the work", () => {
    const text = describeGuide(facts({ wake: ["loop_halted", "needs_reply", "needs_answer"] as EventName[] }));

    assert.ok(text.indexOf("needs_answer:") < text.indexOf("loop_halted:"));
    assert.ok(text.indexOf("needs_reply:") < text.indexOf("loop_halted:"));
  });

  it("does not say twice what an event means: the `do` line adds to the meaning, it does not restate it", () => {
    for (const name of defaultWakeEvents()) {
      const spec = EVENTS[name] as { means: string; act?: string };
      const first = spec.means.toLowerCase().split(" ").slice(0, 4).join(" ");
      assert.ok(!(spec.act ?? "").toLowerCase().includes(first), `${name}: its act restates "${first}"`);
    }
  });

  it("gives the orchestrator a place for its notes inside the run directory, and forbids files in the repository tree", () => {
    const text = describeGuide(facts());

    assert.match(text, /\/work\/app\/\.autopilot-run\/orchestrator-notes\.md/);
    assert.match(text, /Never write into the repository tree/);
    assert.match(text, /treats a stray file as earlier work/);
  });

  it("warns, as the first thing, when the run directory is not ignored, since notes kept there would dirty the tree", () => {
    const text = describeGuide(facts({ runDirIgnored: false }));

    assert.match(text.split("\n").slice(0, 4).join("\n"), /warning: .*\.autopilot-run is not ignored by git/);
  });

  it("says the cost rule with its measurement, and where the longer runbook is", () => {
    const text = describeGuide(facts());

    assert.match(text, /Never poll/);
    assert.match(text, /610 requests in 9 minutes/);
    assert.match(text, /\/usr\/lib\/node_modules\/autopilot\/docs\/ORCHESTRATOR\.md/);
  });

  it("only names commands the CLI has", async () => {
    const lines: string[] = [];
    const log = mock.method(console, "log", (line: string) => void lines.push(line));
    await cli(["help"]);
    log.mock.restore();
    const usage = lines.join("\n");

    const named = [...describeGuide(facts()).matchAll(/autopilot ([a-z]+)\b/g)].map((m) => m[1] ?? "");
    for (const command of new Set(named)) {
      if (["is", "says", "guide", "run"].includes(command)) continue;
      assert.match(usage, new RegExp(`\\n  ${command}\\b`), `the guide names \`autopilot ${command}\`, which the usage does not list`);
    }
  });
});

describe("autopilot guide: where an orchestrator finds it", () => {
  let repo = "";
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "guide-"));
    await mkdir(join(repo, ".autopilot-run"));
    await writeFile(join(repo, "autopilot.yaml"), "version: 1\nharness: devin\n");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reads the repository's workflow: its run directory, its next session, the real wake list", async () => {
    const text = await guide(["--repo", repo]);

    assert.ok(text.includes(`autopilot status --repo ${repo}`));
    assert.match(text, /next session: devin/);
    assert.match(text, /needs_answer/);
  });

  it("is in the usage, next to what an orchestrator uses", async () => {
    const lines: string[] = [];
    const log = mock.method(console, "log", (line: string) => void lines.push(line));
    await cli(["help"]);
    log.mock.restore();

    assert.match(lines.join("\n"), /\n  guide {2,}how to orchestrate this loop/);
  });

  it("is named by `status`, which an orchestrator runs first", async () => {
    const out = await runCtl(["status", "--repo", repo]);

    assert.ok(out.trimEnd().endsWith(`orchestrating this loop? \`autopilot guide --repo ${repo}\` says how`));
  });

  it("is named by `init`, which writes the workflow", async () => {
    await rm(join(repo, "autopilot.yaml"));

    assert.match(await init(["--repo", repo]), /Orchestrating the loop\? `autopilot guide` says how/);
  });
});
