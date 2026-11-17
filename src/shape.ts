/** Small checks for reading untyped YAML into typed values; every failure names the path it came from. */
export type Obj = Record<string, unknown>;

export function fail(path: string, expected: string, got: unknown): never {
  const shown = JSON.stringify(got) ?? String(got);
  throw new Error(`${path}: expected ${expected}, got ${shown.slice(0, 80)}`);
}

export function asObject(value: unknown, path: string): Obj {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Obj;
  }
  return fail(path, "a mapping", value);
}

/** Refuses a key the schema does not know, naming the ones it does, so a typo never runs a default. */
export function onlyKeys(obj: Obj, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path}: unknown key "${key}"; expected one of ${allowed.join(", ")}`);
    }
  }
}

export function text(obj: Obj, key: string, path: string, fallback: string): string {
  const value = obj[key] ?? fallback;
  if (typeof value === "string" && value !== "") return value;
  return fail(`${path}.${key}`, "a non-empty string", value);
}

export function optionalText(obj: Obj, key: string, path: string): string | null {
  const value = obj[key] ?? null;
  if (value === null || (typeof value === "string" && value !== "")) return value;
  return fail(`${path}.${key}`, "a non-empty string or null", value);
}

export function bool(obj: Obj, key: string, path: string, fallback: boolean): boolean {
  const value = obj[key] ?? fallback;
  return typeof value === "boolean" ? value : fail(`${path}.${key}`, "true or false", value);
}

export function number(obj: Obj, key: string, path: string, fallback: number): number {
  const value = obj[key] ?? fallback;
  return typeof value === "number" && Number.isFinite(value) ? value : fail(`${path}.${key}`, "a number", value);
}

/** A list of strings; a single string is one line of it. */
export function lines(obj: Obj, key: string, path: string): string[] {
  const value = obj[key] ?? [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  return fail(`${path}.${key}`, "a list of strings", value);
}

export function list(obj: Obj, key: string, path: string): unknown[] {
  const value = obj[key] ?? [];
  return Array.isArray(value) ? value : fail(`${path}.${key}`, "a list", value);
}

export function oneOf<T extends string>(obj: Obj, key: string, path: string, allowed: readonly T[], fallback: T): T {
  const value = obj[key] ?? fallback;
  const found = allowed.find((option) => option === value);
  return found ?? fail(`${path}.${key}`, `one of ${allowed.join(", ")}`, value);
}

export function regex(value: unknown, path: string): RegExp {
  if (typeof value !== "string") return fail(path, "a regular expression string", value);
  try {
    return new RegExp(value);
  } catch (error) {
    throw new Error(`${path}: not a valid regular expression (${String(error)})`);
  }
}
