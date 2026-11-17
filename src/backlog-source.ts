import { join } from "node:path";
import type { Backlog } from "./workflow.ts";

/** How long an id may be, and what it may hold, when a command prints it: one line of printable text. */
export const MAX_ROW_ID_CHARS = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** What reading the next row touches outside this module, so a test can stand in for it with a named fake. */
export interface BacklogPorts {
  /** The text of a file, or null when it does not exist; any other failure is thrown. */
  readText(path: string): Promise<string | null>;
  /** The first line a command printed, or null when it printed nothing; a failing command throws. */
  firstLine(command: string | string[], cwd: string, timeoutMs: number): Promise<string | null>;
}

/**
 * The id in the first column of the backlog row carrying `marker`, or null when no row does. A table row
 * is the only line that counts: the backlog's prose also names the marker. The marker follows the row's
 * state, whichever that is (`open ← next`, `partial ← next`), because an item part-way through is still the
 * one to continue. Where several rows carry it, the first is the next.
 *
 * @example
 * nextBacklogRow("| `ID-1` | A title | open ← next |", "← next"); // => "ID-1"
 */
export function nextBacklogRow(backlog: string, marker: string): string | null {
  const line = backlog.split("\n").find((candidate) => candidate.startsWith("|") && candidate.includes(marker));
  if (!line) return null;
  const firstColumn = line.split("|")[1]?.trim().replaceAll("`", "");
  return firstColumn || line.trim();
}

/**
 * The id a command printed, checked. The loop writes it into the journal and uses it to say which row a
 * session worked on, so what a command prints is not trusted: it must be a single line of printable
 * characters of bounded length. A refusal names the offending value and the shape expected.
 *
 * @example
 * checkedRowId("  TASK-7 "); // => "TASK-7"
 */
export function checkedRowId(line: string): string {
  const id = line.trim();
  if (id.length <= MAX_ROW_ID_CHARS && !CONTROL_CHARACTERS.test(id)) return id;
  const shown = JSON.stringify(id.length > 60 ? `${id.slice(0, 60)}…` : id);
  throw new Error(`backlog command printed an invalid row id ${shown}: expected one line of at most ${MAX_ROW_ID_CHARS} printable characters`);
}

/**
 * The id of the next row from the workflow's backlog source, or null when none is left. It is read once
 * per iteration and the answer is used as it is; a source that cannot be read is an error, never an empty
 * answer, because reading a broken source as "no work left" would end the loop quietly.
 */
export async function readNextRow(backlog: Backlog, repoRoot: string, ports: BacklogPorts): Promise<string | null> {
  if (backlog.source === "command") {
    const line = await ports.firstLine(backlog.command, repoRoot, backlog.timeoutMs);
    return line === null ? null : checkedRowId(line);
  }
  const path = join(repoRoot, backlog.file);
  const text = await ports.readText(path);
  if (text === null) {
    throw new Error(`backlog file ${path} not found; set backlog.file, or use backlog.source: command to name the next row by a command`);
  }
  return nextBacklogRow(text, backlog.marker);
}
