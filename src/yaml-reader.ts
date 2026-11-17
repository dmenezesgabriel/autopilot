import { parse } from "yaml";

/**
 * The one place the YAML library is used. A repository's workflow is read here into plain values and
 * nowhere else, so replacing the parser touches this file only. JSON is YAML, so a JSON file reads too.
 *
 * @example
 * readYaml("a: 1", "autopilot.yaml"); // => { a: 1 }
 */
export function readYaml(text: string, source: string): unknown {
  try {
    return parse(text, { strict: true, uniqueKeys: true });
  } catch (error) {
    throw new Error(`${source}: not valid YAML (${(error as Error).message.split("\n")[0]})`);
  }
}
