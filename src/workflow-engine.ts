import { allHold, render } from "./conditions.ts";
import type { AgentChoice } from "./agent-choice.ts";
import type { Question } from "./agent-dialect.ts";
import type { Answer, LoopEvent } from "./mailbox.ts";
import type { Action, AnswerChoice, Handler } from "./workflow-handlers.ts";

/** What the engine does to the world; the loop supplies the real ones, a test supplies fakes. */
export interface EnginePorts {
  writeAnswer(id: string, answer: Answer, why: string): Promise<void>;
  writeChoice(choice: AgentChoice): Promise<void>;
  requestStop(): Promise<void>;
  /** Runs a command for an event; rejects when it fails or outlives its timeout. */
  run(command: string | string[], event: LoopEvent, timeoutMs: number): Promise<void>;
  emit(event: LoopEvent): Promise<void>;
}

/** The handler chosen for an event, and for a question the answer it will give. */
export type Plan = { handler: Handler; answer: string[] | null };

/**
 * Applies a repository's handlers to the loop's events. The first handler whose `when` holds for an
 * event runs its actions, in order; an action that fails is journaled as `workflow_error` and the next
 * one still runs. It works as an orchestrator does, through the same answer files, and never blocks the loop.
 */
export class WorkflowEngine {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private handlers: Handler[],
    private readonly ports: EnginePorts,
  ) {}

  /** Handlers from a reloaded workflow take over from the next event. */
  replace(handlers: Handler[]): void {
    this.handlers = handlers;
  }

  /** The handler for `event`, or null. A `needs_answer` handler whose rule finds no option for some question does not apply. */
  plan(event: LoopEvent): Plan | null {
    if (event.type.startsWith("workflow_")) return null;
    for (const handler of this.handlers) {
      if (handler.event !== event.type || !allHold(event, handler.when)) continue;
      const answer = answerFor(event, handler.actions);
      if (answer !== undefined) return { handler, answer };
    }
    return null;
  }

  /** Whether the plan answers a question or a reply, so a watching orchestrator need not. */
  static answers(plan: Plan): boolean {
    return plan.handler.actions.some((action) => action.kind === "answer" || action.kind === "reply");
  }

  /** The reason a handler gives for ending the iteration, for the one event whose handler may. */
  yieldReason(event: LoopEvent): string | null {
    const action = this.plan(event)?.handler.actions.find((candidate) => candidate.kind === "yield");
    return action?.kind === "yield" ? render(action.reason, event) : null;
  }

  /**
   * Starts the plan. The answer or reply a handler gives is written first, and the returned promise
   * resolves when it is: the loop is waiting for it, and a mailbox that polls would otherwise miss it by
   * a poll interval. Everything else (a command may take a minute) goes on in the background.
   */
  start(event: LoopEvent, plan: Plan): Promise<void> {
    const isAnswer = (action: Action): boolean => action.kind === "answer" || action.kind === "reply";
    const answers = plan.handler.actions.filter(isAnswer);
    const rest = plan.handler.actions.filter((action) => !isAnswer(action));
    const written = this.perform(answers, event, plan);
    const running = written.then(() => this.perform(rest, event, plan)).then(() => this.applied(event, plan)).finally(() => this.pending.delete(running));
    this.pending.add(running);
    return written;
  }

  /** Resolves when every started plan has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async perform(actions: Action[], event: LoopEvent, { handler, answer }: Plan): Promise<void> {
    for (const action of actions) {
      try {
        await this.apply(action, event, handler, answer);
      } catch (error) {
        await this.ports.emit({ type: "workflow_error", event: event.type, handler: handler.name, action: action.kind, error: String((error as Error).message ?? error) });
      }
    }
  }

  private applied(event: LoopEvent, { handler }: Plan): Promise<void> {
    return this.ports.emit({ type: "workflow_applied", event: event.type, handler: handler.name, actions: handler.actions.map((action) => action.kind) });
  }

  private async apply(action: Action, event: LoopEvent, handler: Handler, answer: string[] | null): Promise<void> {
    const id = String(event["id"]);
    const why = handler.why ?? `workflow ${handler.name}`;
    switch (action.kind) {
      case "answer": return answer === null ? undefined : this.ports.writeAnswer(id, answer, why);
      case "reply": return this.ports.writeAnswer(id, render(action.text, event), why);
      case "run": return this.ports.run(commandFor(action.command, event), event, action.timeoutMs);
      case "use": return this.ports.writeChoice({ agent: action.agent as string, model: action.model, effort: action.effort });
      case "stop": return this.ports.requestStop();
      case "yield": return undefined;
    }
  }
}

function commandFor(command: string | string[], event: LoopEvent): string | string[] {
  return typeof command === "string" ? command : command.map((word) => render(word, event));
}

/** `undefined`: the handler cannot answer this event; `null`: it has no answer action; else one label per question. */
function answerFor(event: LoopEvent, actions: Action[]): string[] | null | undefined {
  const action = actions.find((candidate) => candidate.kind === "answer");
  if (action === undefined || action.kind !== "answer") return null;
  const questions = Array.isArray(event["questions"]) ? (event["questions"] as Question[]) : [];
  const labels = questions.map((question) => pick(question, action.choice));
  return labels.length > 0 && labels.every((label) => label !== null) ? (labels as string[]) : undefined;
}

const RECOMMENDED = /\(recommended\)/i;

/** `recommended` applies only where the agent marked an option so; an unmarked question is left to the orchestrator. */
function pick(question: Question, choice: AnswerChoice): string | null {
  if (choice === "recommended") return question.options.find((option) => RECOMMENDED.test(option.label))?.label ?? null;
  if (choice === "first") return question.options[0]?.label ?? null;
  return question.options.find((option) => choice.choose.test(option.label))?.label ?? null;
}
