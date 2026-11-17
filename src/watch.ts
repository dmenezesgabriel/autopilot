import { open, stat } from "node:fs/promises";
import type { EventName } from "./event-registry.ts";
import type { LoopEvent } from "./mailbox.ts";

/**
 * Whether a journal line is one a watching orchestrator should be woken for: its type is in the wake list
 * and no workflow handler has answered it. A `tail -F events.jsonl | grep -E ...` filter wakes the
 * orchestrator for every report such as `iteration_done`, and cannot know a handler already answered.
 */
export function shouldWake(event: LoopEvent, wake: readonly EventName[]): boolean {
  return (wake as readonly string[]).includes(event.type) && event["handledBy"] === undefined;
}

export type FollowOptions = {
  /** Read what is already in the file first; otherwise only what is appended from now on. */
  fromStart: boolean;
  pollMs: number;
  signal: AbortSignal;
};

/** Calls `onLine` for each complete line appended to `path`, until `signal` aborts. A file that does not exist yet is waited for. */
export async function followLines(path: string, onLine: (line: string) => void, options: FollowOptions): Promise<void> {
  let offset = options.fromStart ? 0 : await sizeOf(path);
  let carry = "";
  while (!options.signal.aborted) {
    const size = await sizeOf(path);
    if (size < offset) offset = 0;
    if (size > offset) {
      carry += await readRange(path, offset, size);
      offset = size;
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      parts.filter((line) => line !== "").forEach(onLine);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

async function sizeOf(path: string): Promise<number> {
  return stat(path).then((info) => info.size, () => 0);
}

async function readRange(path: string, from: number, to: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    await handle.read(buffer, 0, buffer.length, from);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
