import type { AskedQuestion, JournalSummary, PendingAsk } from "./journal-summary.ts";

/** Whether the process that holds the run directory's lock is there to read what an operator writes. */
export type LoopLiveness = { pid: number | null; alive: boolean };

export type AnswerRequest = { id: string; kind: PendingAsk["kind"]; values: string[] };

const NOUN: Record<PendingAsk["kind"], string> = { question: "an answer", reply: "a reply" };
const VERB: Record<PendingAsk["kind"], string> = { question: "answer", reply: "reply" };

function waitingLine(pending: readonly PendingAsk[]): string {
  if (pending.length === 0) return "nothing is waiting for an answer or a reply";
  return `waiting: ${pending.map((ask) => `${ask.id} (${ask.kind})`).join(", ")}`;
}

function askedLine(questions: readonly AskedQuestion[]): string {
  return questions.map((asked, at) => `${at + 1}. ${asked.question} [${asked.options.join(" | ")}]`).join("; ");
}

/**
 * Refuses an answer or a reply that no loop would read as one, and says what would work. The mailbox is a
 * file named by the ask's id, and the loop reads exactly the file of the ask it is waiting on: a file for
 * any other id is never read, a free-text reply to a question, or labels for a reply, the loop takes as a
 * non-answer and replaces with its default. The journal knows what waits, so the check is made here,
 * where the operator can still correct it, instead of after the default has gone to the agent.
 *
 * Returns notes worth showing with the confirmation: a label that is not one of the offered options goes
 * to the agent as free text, which both agents accept, so it is allowed and named.
 *
 * @example
 * checkAnswer(summary, { pid: 42, alive: true }, { id: "q1", kind: "question", values: ["Yes"] });
 * // => [] when q1 waits on one question; throws with what waits otherwise
 */
export function checkAnswer(summary: JournalSummary, loop: LoopLiveness, request: AnswerRequest): string[] {
  const { id, kind, values } = request;
  if (!loop.alive) {
    throw new Error(`no loop runs here, so nothing would read ${JSON.stringify(id)}: start it with \`autopilot run\``);
  }
  const pending = summary.open?.pending ?? [];
  const ask = pending.find((entry) => entry.id === id);
  if (ask === undefined) {
    throw new Error(`${JSON.stringify(id)} is not waiting for ${NOUN[kind]}; ${waitingLine(pending)}`);
  }
  if (ask.kind !== kind) {
    const how = ask.kind === "question" ? "one label per question" : "free text";
    throw new Error(`${id} is a ${ask.kind}: use \`autopilot ${VERB[ask.kind]} ${id}\` with ${how}`);
  }
  return kind === "question" ? checkLabels(ask, values) : [];
}

function checkLabels(ask: PendingAsk, labels: readonly string[]): string[] {
  const { questions } = ask;
  if (questions.length > 0 && labels.length !== questions.length) {
    throw new Error(
      `${ask.id} asks ${questions.length} question${questions.length === 1 ? "" : "s"} and takes one label for each, got ${labels.length}: ${askedLine(questions)}`,
    );
  }
  return labels.flatMap((label, at) => {
    const options = questions[at]?.options ?? [];
    if (options.length === 0 || options.includes(label)) return [];
    return [`note: ${JSON.stringify(label)} is not one of question ${at + 1}'s options (${options.join(", ")}); it goes to the agent as free text`];
  });
}

/** What `autopilot stop` does, said from the lock: a stop file with no loop to read it is never read, and the next start spends it. */
export function checkStop(loop: LoopLiveness): string | null {
  if (loop.alive) return null;
  const was = loop.pid === null ? "" : ` (pid ${loop.pid} is not running)`;
  return `no loop runs here${was}, so there is nothing to stop`;
}
