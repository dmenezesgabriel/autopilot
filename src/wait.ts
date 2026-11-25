import { readFile, writeFile } from "node:fs/promises";
import { readRange, sizeOf } from "./watch.ts";

export type WaitOptions = {
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
};

/** The first wanted line, or null when none came, and the byte offset the next call must start from. */
export type WaitOutcome = { line: string | null; offset: number };

/**
 * Waits for the first complete line from byte `offset` on that `wanted` accepts, up to `timeoutMs`.
 * The offset it returns is just after that line, or, with none found, just after the last complete
 * line it read: a call that resumes there delivers every wanted line exactly once, including ones
 * written while no call was running. A half-written last line is never passed, since it may be the
 * wanted one still being written. A file shorter than `offset` is a fresh journal, read from the top.
 *
 * @example
 * const { line, offset } = await nextWantedLine(path, 0, (l) => l.includes("needs_answer"), { timeoutMs: 270_000, pollMs: 1000 });
 */
export async function nextWantedLine(path: string, offset: number, wanted: (line: string) => boolean, options: WaitOptions): Promise<WaitOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  let at = offset;
  for (;;) {
    const size = await sizeOf(path);
    if (size < at) at = 0;
    const scan = scanComplete(await readRange(path, at, size), at, wanted);
    if (scan.line !== null) return scan;
    at = scan.offset;
    const remaining = deadline - Date.now();
    if (options.signal?.aborted || remaining <= 0) return { line: null, offset: at };
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs, remaining)));
  }
}

function scanComplete(text: string, from: number, wanted: (line: string) => boolean): WaitOutcome {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  let offset = from;
  for (const line of complete.split("\n").slice(0, -1)) {
    offset += Buffer.byteLength(line) + 1;
    if (line !== "" && wanted(line)) return { line, offset };
  }
  return { line: null, offset };
}

/** The offset saved by the last call, or null when there is none (or it is not a number). */
export async function readWaitCursor(path: string): Promise<number | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  const offset = text === null ? Number.NaN : Number(text.trim());
  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

export async function writeWaitCursor(path: string, offset: number): Promise<void> {
  await writeFile(path, String(offset));
}
