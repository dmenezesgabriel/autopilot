import type { LoopEvent } from "./mailbox.ts";
import type { Workflow } from "./workflow.ts";
import { WorkflowEngine } from "./workflow-engine.ts";

export type HandlerTally = {
  handler: string;
  event: string;
  matched: number;
  /** For a handler that answers: how many of its answers a real orchestrator gave, and how many of those it equals. */
  answered: number;
  compared: number;
  agreed: number;
};

export type Simulation = {
  events: number;
  /** Events in the wake list: what a watcher would have woken an orchestrator for with no workflow. */
  wakeUps: number;
  /** Of those, the ones a handler would have answered, so that no orchestrator is needed. */
  answeredByWorkflow: number;
  handlers: HandlerTally[];
};

const NO_PORTS = {
  writeAnswer: async () => undefined,
  writeChoice: async () => undefined,
  requestStop: async () => undefined,
  run: async () => undefined,
  emit: async () => undefined,
};

/**
 * Replays a recorded journal through a workflow without running any action. It reports what each handler
 * would have matched, how many wake-ups it would have taken off an orchestrator, and for the questions it
 * answers, whether its choice equals the one that was actually given. A workflow is tested against history
 * before it is trusted with the future.
 */
export function simulate(events: LoopEvent[], workflow: Workflow): Simulation {
  const engine = new WorkflowEngine(workflow.handlers, NO_PORTS);
  const tallies = new Map<string, HandlerTally>();
  const asks = new Map<string, { plan: string[] | null; handler: string }>();
  let wakeUps = 0;
  let answeredByWorkflow = 0;
  for (const event of events) {
    const plan = engine.plan(event);
    const wakes = (workflow.wake as readonly string[]).includes(event.type);
    if (wakes) wakeUps += 1;
    if (plan !== null) tally(tallies, plan.handler.name, plan.handler.event).matched += 1;
    if (plan !== null && WorkflowEngine.answers(plan)) {
      if (wakes) answeredByWorkflow += 1;
      tally(tallies, plan.handler.name, plan.handler.event).answered += 1;
      asks.set(String(event["id"]), { plan: plan.answer, handler: plan.handler.name });
    }
    compareWithActual(event, asks, tallies);
  }
  return { events: events.length, wakeUps, answeredByWorkflow, handlers: [...tallies.values()] };
}

function compareWithActual(event: LoopEvent, asks: Map<string, { plan: string[] | null; handler: string }>, tallies: Map<string, HandlerTally>): void {
  if (event.type !== "answer_received") return;
  const ask = asks.get(String(event["id"]));
  if (ask === undefined || ask.plan === null) return;
  asks.delete(String(event["id"]));
  const row = tallies.get(ask.handler);
  if (row === undefined) return;
  row.compared += 1;
  if (JSON.stringify(event["answer"]) === JSON.stringify(ask.plan)) row.agreed += 1;
}

function tally(tallies: Map<string, HandlerTally>, handler: string, event: string): HandlerTally {
  const existing = tallies.get(handler);
  if (existing !== undefined) return existing;
  const created = { handler, event, matched: 0, answered: 0, compared: 0, agreed: 0 };
  tallies.set(handler, created);
  return created;
}

export function formatSimulation(result: Simulation): string {
  const lines = [`replayed ${result.events} events; ${result.wakeUps} are in the wake list, ${result.answeredByWorkflow} of those would be answered by a handler`];
  lines.push("handler".padEnd(34) + "event".padEnd(22) + "matched answers compared agreed");
  for (const row of result.handlers) {
    lines.push(`${row.handler.padEnd(34)}${row.event.padEnd(22)}${String(row.matched).padStart(7)}${String(row.answered).padStart(8)}${String(row.compared).padStart(9)}${String(row.agreed).padStart(7)}`);
  }
  return lines.join("\n");
}
