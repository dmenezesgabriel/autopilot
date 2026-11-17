import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hostBusyReason,
  leftoversIn,
  memoryStallOf,
  readHostReadings,
  readProcEntries,
  waitUntilReady,
  type HostReadings,
  type LeftoverPolicy,
  type PreflightDeps,
  type ProcEntry,
} from "./preflight.ts";
import { nextBacklogRow } from "./backlog-source.ts";
import type { LoopEvent } from "./mailbox.ts";
import { FakeClock } from "./testing/fake-mailbox.ts";
import { assertContains, assertPartial } from "./testing/assertions.ts";

const REPO = "/home/user/app";
const CALM: HostReadings = { load1: 2, cores: 8, memoryStallAvg60: 0 };
const MARKER = "← next";
const EMULATOR_POLICY: LeftoverPolicy = {
  rules: [{ match: /\b(qemu-system-\S+|emulator|uitest)\b/, alsoMatch: null }],
  wrappers: [],
};
const BACKLOG_WITH_NEXT =
  "| Milestone | Status |\n| `T-85` | big text | open ← next | [PRD](prd/x.md) | — |\n";

describe("hostBusyReason", () => {
  it("passes a host whose load fits the cores and whose memory is not stalling", () => {
    assert.equal(hostBusyReason(CALM), null);
    assert.equal(hostBusyReason({ ...CALM, load1: 8 }), null);
  });

  it("blocks on load above the core count and on any memory stall", () => {
    assertContains(
      hostBusyReason({ ...CALM, load1: 18.7 }),
      "18.7 exceeds 8 cores",
    );
    assertContains(
      hostBusyReason({ ...CALM, memoryStallAvg60: 1.5 }),
      "memory",
    );
  });
});

describe("host readings", () => {
  it("reads the memory stall from Linux's pressure text, and as none when there is no such file", () => {
    const text = "some avg10=0.00 avg60=2.50 avg300=1.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";

    assert.equal(memoryStallOf(text), 2.5);
    assert.equal(memoryStallOf(null), 0);
    assert.equal(memoryStallOf("unexpected"), 0);
  });

  it("reads this host without throwing, on a kernel with or without pressure files", async () => {
    const readings = await readHostReadings();

    assert.ok(Number.isFinite(readings.load1) && readings.cores >= 1 && readings.memoryStallAvg60 >= 0);
    assert.ok(Array.isArray(await readProcEntries()));
  });
});

describe("leftoversIn", () => {
  const entry = (cwd: string, cmdline: string): ProcEntry => ({
    pid: 10,
    cwd,
    cmdline,
  });

  it("finds an emulator or a UI-test run the repo's session left behind", () => {
    const left = leftoversIn(
      [
        entry(`${REPO}`, "qemu-system-x86_64 -avd test"),
        entry(`${REPO}/scripts`, "java -jar uitest.jar run flow.yaml"),
      ],
      REPO,
      EMULATOR_POLICY,
    );

    assert.equal(left.length, 2);
  });

  it("leaves a Gradle daemon alone, because an IDE the user has open owns one in this tree", () => {
    const left = leftoversIn([entry(REPO, "java GradleDaemon 9.0")], REPO, EMULATOR_POLICY);

    assert.deepEqual(left, []);
  });

  it("ignores other repos, sibling directories with the same prefix, and unrelated commands", () => {
    const left = leftoversIn(
      [
        entry("/home/user/other", "qemu-system-x86_64"),
        entry(`${REPO}-copy`, "qemu-system-x86_64"),
        entry(REPO, "zsh"),
      ],
      REPO,
      EMULATOR_POLICY,
    );

    assert.deepEqual(left, []);
  });
});

describe("leftoversIn with a second condition", () => {
  const BROWSER_POLICY: LeftoverPolicy = {
    rules: [{ match: /\b(chrome|chromium)\b/, alsoMatch: /--headless|ms-playwright/ }],
    wrappers: [],
  };
  const entry = (cmdline: string): ProcEntry => ({ pid: 7, cwd: REPO, cmdline });

  it("takes a headless or Playwright browser for a leftover", () => {
    const left = leftoversIn(
      [entry("chrome --headless=new about:blank"), entry("/cache/ms-playwright/chromium-1/chrome")],
      REPO,
      BROWSER_POLICY,
    );

    assert.equal(left.length, 2);
  });

  it("leaves the owner's desktop browser alone even when it shares the repo as its directory", () => {
    const left = leftoversIn(
      [entry("/opt/google/chrome/chrome https://example.com/oauth")],
      REPO,
      BROWSER_POLICY,
    );

    assert.deepEqual(left, []);
  });
});

const QUEUE_RULE = { program: "jobq", ignoreArgs: ["--status", "--lane"], hint: "`jobq cancel {{dir}}-{{pid}}` ends it" };

describe("leftoversIn with a wrapper rule", () => {
  const QUEUE_POLICY: LeftoverPolicy = { rules: [], wrappers: [QUEUE_RULE] };
  const entry = (cmdline: string): ProcEntry => ({ pid: 99873, cwd: REPO, cmdline });

  it("takes a queued or running job of the wrapper for a leftover", () => {
    const left = leftoversIn(
      [entry("bash /home/u/.local/bin/jobq ./gate.sh")],
      REPO,
      QUEUE_POLICY,
    );

    assert.equal(left.length, 1);
  });

  it("ignores a read-only wrapper command, and every wrapper when the workflow names none", () => {
    assert.deepEqual(
      leftoversIn([entry("bash /home/u/.local/bin/jobq --status")], REPO, QUEUE_POLICY),
      [],
    );
    assert.deepEqual(
      leftoversIn([entry("bash /home/u/.local/bin/jobq ./gate.sh")], REPO, EMULATOR_POLICY),
      [],
    );
  });
});

class FakeHost {
  readings: HostReadings = CALM;
  procs: ProcEntry[] = [];
  backlog = BACKLOG_WITH_NEXT;
  /** What reading the backlog does: a failure, until `unreadableFor` reads have failed. */
  unreadableFor = 0;
  reads = 0;
  leftover: LeftoverPolicy = EMULATOR_POLICY;
  checkHost = true;
  stop = false;
  readonly events: LoopEvent[] = [];

  deps(clock: FakeClock): PreflightDeps {
    return {
      repoRoot: REPO,
      leftover: this.leftover,
      nextRow: async () => {
        this.reads += 1;
        if (this.reads <= this.unreadableFor) throw new Error("backlog command ended with exit 4: boom");
        return nextBacklogRow(this.backlog, MARKER);
      },
      checkHost: this.checkHost,
      readHost: async () => this.readings,
      readProcs: async () => this.procs,
      stopRequested: async () => this.stop,
      clock,
      emit: async (event) => {
        this.events.push(event);
      },
      recheckMs: 60_000,
      repeatReportMs: 10 * 60_000,
    };
  }
}

describe("waitUntilReady", () => {
  it("is ready at once on a calm host with a next row", async () => {
    const host = new FakeHost();

    assert.deepEqual(await waitUntilReady(host.deps(new FakeClock())), { kind: "ready", row: "T-85" });
    assert.deepEqual(host.events, []);
  });

  it("waits while the host is busy, says why once, and goes when it calms", async () => {
    const host = new FakeHost();
    host.readings = { ...CALM, load1: 18 };
    const clock = new FakeClock((now) => {
      if (now >= 180_000) host.readings = CALM;
    });

    const result = await waitUntilReady(host.deps(clock));

    assert.equal(result.kind, "ready");
    assert.equal(host.events.length, 1);
    assertPartial(host.events[0], { type: "preflight_wait" });
  });

  it("waits for a leftover dev server to exit instead of killing it", async () => {
    const host = new FakeHost();
    host.procs = [
      { pid: 42, cwd: REPO, cmdline: "qemu-system-x86_64 -avd test" },
    ];
    const clock = new FakeClock((now) => {
      if (now >= 120_000) host.procs = [];
    });

    assert.equal((await waitUntilReady(host.deps(clock))).kind, "ready");
    assertContains(String(host.events[0]?.["reason"]), "42 qemu-system-x86_64");
  });

  it("repeats its report every so often while still blocked", async () => {
    const host = new FakeHost();
    host.readings = { ...CALM, load1: 18 };
    const clock = new FakeClock((now) => {
      if (now >= 25 * 60_000) host.readings = CALM;
    });

    await waitUntilReady(host.deps(clock));

    assert.ok(
      host.events.length >= 3,
      `expected 3 or more events, saw ${host.events.length}`,
    );
  });

  it("reports an empty backlog instead of starting a session", async () => {
    const host = new FakeHost();
    host.backlog = "| Items | shipped |\n";

    assert.deepEqual(await waitUntilReady(host.deps(new FakeClock())), { kind: "backlog_exhausted" });
  });

  it("stops when asked, even while blocked", async () => {
    const host = new FakeHost();
    host.readings = { ...CALM, load1: 18 };
    const clock = new FakeClock((now) => {
      if (now >= 120_000) host.stop = true;
    });

    assert.deepEqual(await waitUntilReady(host.deps(clock)), { kind: "stop" });
  });

  it("adds the wrapper rule's hint to the line naming the process", async () => {
    const host = new FakeHost();
    host.leftover = { rules: [], wrappers: [QUEUE_RULE] };
    host.procs = [{ pid: 99873, cwd: REPO, cmdline: "bash /home/u/.local/bin/jobq ./gate.sh" }];
    const clock = new FakeClock((now) => {
      if (now >= 60_000) host.procs = [];
    });

    await waitUntilReady(host.deps(clock));

    assertContains(String(host.events[0]?.["reason"]), "jobq cancel app-99873");
  });

  it("ignores a busy host when the repository turns the check off", async () => {
    const host = new FakeHost();
    host.readings = { ...CALM, load1: 99 };
    host.checkHost = false;

    assert.deepEqual(await waitUntilReady(host.deps(new FakeClock())), { kind: "ready", row: "T-85" });
    assert.deepEqual(host.events, []);
  });

  it("says a busy host once while its load moves, not once a minute", async () => {
    const host = new FakeHost();
    host.readings = { ...CALM, load1: 18 };
    const clock = new FakeClock((now) => {
      host.readings = { ...CALM, load1: 18 + (now / 60_000) * 0.1 };
      if (now >= 8 * 60_000) host.readings = CALM;
    });

    await waitUntilReady(host.deps(clock));

    assert.equal(host.events.length, 1);
  });

  it("reads the backlog once per check and hands the row it read to the caller, who does not read it again", async () => {
    const host = new FakeHost();

    const result = await waitUntilReady(host.deps(new FakeClock()));

    assert.deepEqual(result, { kind: "ready", row: "T-85" });
    assert.equal(host.reads, 1);
  });

  it("waits and says why once when the backlog cannot be read, and goes on when it can, never ending the loop", async () => {
    const host = new FakeHost();
    host.unreadableFor = 3;

    const result = await waitUntilReady(host.deps(new FakeClock()));

    assert.deepEqual(result, { kind: "ready", row: "T-85" });
    assert.equal(host.reads, 4);
    assert.equal(host.events.length, 1);
    assertContains(String(host.events[0]?.["reason"]), "the backlog could not be read: backlog command ended with exit 4: boom");
  });

  it("does not read an unreadable backlog as an exhausted one", async () => {
    const host = new FakeHost();
    host.unreadableFor = 1;

    const result = await waitUntilReady(host.deps(new FakeClock()));

    assert.notEqual(result.kind, "backlog_exhausted");
  });
});
