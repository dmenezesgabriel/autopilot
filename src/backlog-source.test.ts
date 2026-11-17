import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkedRowId, MAX_ROW_ID_CHARS, nextBacklogRow, readNextRow, type BacklogPorts } from "./backlog-source.ts";
import type { Backlog } from "./workflow.ts";

const MARKER = "← next";
const MARKDOWN: Backlog = { source: "markdown", file: "docs/backlog.md", marker: MARKER };
const COMMAND: Backlog = { source: "command", command: "ls todo | head -1", timeoutMs: 5_000 };

class FakePorts implements BacklogPorts {
  files = new Map<string, string>();
  printed: string | null = null;
  failure: Error | null = null;
  readonly commands: Array<{ command: string | string[]; cwd: string; timeoutMs: number }> = [];

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async firstLine(command: string | string[], cwd: string, timeoutMs: number): Promise<string | null> {
    this.commands.push({ command, cwd, timeoutMs });
    if (this.failure !== null) throw this.failure;
    return this.printed;
  }
}

describe("nextBacklogRow", () => {
  it("returns the id in the first column of the row carrying the marker", () => {
    assert.equal(nextBacklogRow("| Milestone | Status |\n| `T-85` | big text | open ← next |\n", MARKER), "T-85");
  });

  it("finds the marker behind any state, because a partly done item is still the one to continue", () => {
    assert.equal(nextBacklogRow("| `T-14` | audit | partial ← next |\n", MARKER), "T-14");
  });

  it("does not take the prose that explains the marker for a row", () => {
    const prose = "`← next` **after** its state, whichever that is.\n";

    assert.equal(nextBacklogRow(`${prose}| \`T-1\` | done | shipped |\n`, MARKER), null);
  });

  it("takes the first row when several carry the marker", () => {
    assert.equal(nextBacklogRow("| `T-1` | open ← next |\n| `T-2` | open ← next |\n", MARKER), "T-1");
  });

  it("returns null once no row carries the marker", () => {
    assert.equal(nextBacklogRow("| `T-1` | shipped |\n", MARKER), null);
  });
});

describe("checkedRowId", () => {
  it("trims a printed id", () => {
    assert.equal(checkedRowId("  TASK-7 \t"), "TASK-7");
  });

  it("refuses an id with a control character, naming the value and the shape expected", () => {
    assert.throws(() => checkedRowId("a\u001b[31mb"), /invalid row id "a\\u001b\[31mb": expected one line of at most 200 printable characters/);
  });

  it("refuses an id longer than the bound, and shows only its start", () => {
    const long = "x".repeat(MAX_ROW_ID_CHARS + 1);

    assert.throws(() => checkedRowId(long), (error: Error) => error.message.includes("…") && !error.message.includes(long));
  });

  it("accepts an id exactly at the bound", () => {
    assert.equal(checkedRowId("x".repeat(MAX_ROW_ID_CHARS)).length, MAX_ROW_ID_CHARS);
  });
});

describe("readNextRow from a markdown file", () => {
  it("reads the marked row of the repository's own file", async () => {
    const ports = new FakePorts();
    ports.files.set("/repo/docs/backlog.md", "| `T-1` | open ← next |\n");

    assert.equal(await readNextRow(MARKDOWN, "/repo", ports), "T-1");
  });

  it("returns null for a file with no marked row, which is how an exhausted backlog reads", async () => {
    const ports = new FakePorts();
    ports.files.set("/repo/docs/backlog.md", "| `T-1` | shipped |\n");

    assert.equal(await readNextRow(MARKDOWN, "/repo", ports), null);
  });

  it("fails when the file is missing, saying how to name another source, rather than reading it as empty", async () => {
    await assert.rejects(
      () => readNextRow(MARKDOWN, "/repo", new FakePorts()),
      /backlog file \/repo\/docs\/backlog\.md not found; set backlog\.file, or use backlog\.source: command/,
    );
  });
});

describe("readNextRow from a command", () => {
  it("runs the command in the repository with its own timeout and returns the id it printed", async () => {
    const ports = new FakePorts();
    ports.printed = "  TASK-7";

    assert.equal(await readNextRow(COMMAND, "/repo", ports), "TASK-7");
    assert.deepEqual(ports.commands, [{ command: "ls todo | head -1", cwd: "/repo", timeoutMs: 5_000 }]);
  });

  it("returns null when it printed nothing, which means no row is left", async () => {
    assert.equal(await readNextRow(COMMAND, "/repo", new FakePorts()), null);
  });

  it("fails when the command fails, and never reads a failure as an empty backlog", async () => {
    const ports = new FakePorts();
    ports.failure = new Error("sh ended with exit 4: boom");

    await assert.rejects(() => readNextRow(COMMAND, "/repo", ports), /exit 4: boom/);
  });

  it("refuses an id it printed that is not a single printable line", async () => {
    const ports = new FakePorts();
    ports.printed = "bad\u0000id";

    await assert.rejects(() => readNextRow(COMMAND, "/repo", ports), /invalid row id/);
  });

  it("reads the source once per call, however it is used", async () => {
    const ports = new FakePorts();
    ports.printed = "T-1";

    await readNextRow(COMMAND, "/repo", ports);

    assert.equal(ports.commands.length, 1);
  });
});
