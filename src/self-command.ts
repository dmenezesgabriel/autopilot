import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How to start this autopilot again: node, its flags, and the CLI file next to this one. Run from the
 * TypeScript source (development) node needs its type-transform flags; the built `dist/` is plain
 * JavaScript. A service unit and anything that re-launches the CLI use this, so they run the code they came from.
 */
export function selfCommand(moduleUrl: string = import.meta.url): string[] {
  const here = fileURLToPath(moduleUrl);
  const cli = join(dirname(here), `cli${extname(here)}`);
  if (extname(here) !== ".ts") return [process.execPath, cli];
  return [process.execPath, "--experimental-transform-types", "--no-warnings", cli];
}
