import type { LoopEvent } from "./mailbox.ts";
import { asObject, fail, onlyKeys, regex } from "./shape.ts";

export type Scalar = string | number | boolean | null;

/** How a field's value is tested. Every form but `exists: false` passes when any value at the path passes. */
export type Matcher =
  | { op: "equals"; value: Scalar }
  | { op: "matches"; pattern: RegExp }
  | { op: "in"; values: Scalar[] }
  | { op: "gte" | "lte"; limit: number }
  | { op: "contains"; text: string }
  | { op: "exists"; yes: boolean };

export type Condition = { path: string[]; matcher: Matcher };

const isScalar = (value: unknown): value is Scalar =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/**
 * One `when:` entry. A bare value means equals; a mapping names one test: `matches`, `in`, `gte`, `lte`,
 * `contains` or `exists`. The path is dotted and runs through lists, so `questions.question` reads the
 * question of every question the event carries.
 *
 * @example
 * parseCondition("why", "no_commit", "on.needs_reply[0].when"); // equals
 * parseCondition("lastMessage", { matches: "wait" }, "on.needs_reply[0].when");
 */
export function parseCondition(path: string, value: unknown, where: string): Condition {
  const here = `${where}.${path}`;
  return { path: path.split("."), matcher: isScalar(value) ? { op: "equals", value } : parseMatcher(value, here) };
}

function parseMatcher(value: unknown, where: string): Matcher {
  const obj = asObject(value, where);
  const [op, ...extra] = Object.keys(obj);
  if (op === undefined || extra.length > 0) return fail(where, "exactly one of matches, in, gte, lte, contains, exists", value);
  onlyKeys(obj, ["matches", "in", "gte", "lte", "contains", "exists"], where);
  const given = obj[op];
  if (op === "matches") return { op, pattern: regex(given, `${where}.matches`) };
  if (op === "in") return { op, values: scalars(given, `${where}.in`) };
  if (op === "contains") return { op, text: typeof given === "string" ? given : fail(`${where}.contains`, "a string", given) };
  if (op === "exists") return { op, yes: typeof given === "boolean" ? given : fail(`${where}.exists`, "true or false", given) };
  return { op: op as "gte" | "lte", limit: typeof given === "number" ? given : fail(`${where}.${op}`, "a number", given) };
}

function scalars(value: unknown, where: string): Scalar[] {
  if (Array.isArray(value) && value.every(isScalar)) return value;
  return fail(where, "a list of plain values", value);
}

/** Every value at `path`, walking into lists: `questions.question` is one value per question. */
export function valuesAt(source: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return [source];
  if (Array.isArray(source)) return source.flatMap((item) => valuesAt(item, path));
  if (typeof source !== "object" || source === null) return [];
  const [head, ...rest] = path;
  const next = (source as Record<string, unknown>)[head as string];
  return next === undefined ? [] : valuesAt(next, rest);
}

export function holds(event: LoopEvent, condition: Condition): boolean {
  const values = valuesAt(event, condition.path).filter((value) => value !== undefined);
  const { matcher } = condition;
  if (matcher.op === "exists") return matcher.yes === values.some((value) => value !== null);
  return values.some((value) => passes(matcher, value));
}

function passes(matcher: Matcher, value: unknown): boolean {
  switch (matcher.op) {
    case "equals": return value === matcher.value;
    case "in": return matcher.values.includes(value as Scalar);
    case "gte": return typeof value === "number" && value >= matcher.limit;
    case "lte": return typeof value === "number" && value <= matcher.limit;
    case "matches": return matcher.pattern.test(asText(value));
    case "contains": return asText(value).includes(matcher.text);
    case "exists": return true;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

export function allHold(event: LoopEvent, conditions: Condition[]): boolean {
  return conditions.every((condition) => holds(event, condition));
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** The field names a text reads with `{{field}}`, for checking them against the event's fields. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

/** Fills `{{field}}` from the event; a value that is not text is written as JSON, a missing one as empty. */
export function render(template: string, event: LoopEvent): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const [first] = valuesAt(event, name.split("."));
    return typeof first === "string" ? first : first === undefined ? "" : JSON.stringify(first);
  });
}
