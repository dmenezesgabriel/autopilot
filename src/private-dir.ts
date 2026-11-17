import { chmod, mkdir, stat } from "node:fs/promises";

/** The mode of a directory only its owner may enter, and of a file only its owner may read. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Creates `path` (and its parents) so that only its owner can enter it, and tightens it when it already
 * exists with looser permissions. The run directory holds the agent's whole transcript and the files that
 * steer it (answers, stop, the harness choice), so another user of the machine must neither read it nor
 * write to it; with the default umask `mkdir` leaves it readable by others, and often writable by a group.
 * A directory with no access for others protects every file inside it, whatever mode the file has.
 *
 * @example
 * await ensurePrivateDir("/repo/.autopilot-run"); // mode 700 afterwards
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  const { mode } = await stat(path);
  if ((mode & 0o777) !== PRIVATE_DIR_MODE) await chmod(path, PRIVATE_DIR_MODE);
}
