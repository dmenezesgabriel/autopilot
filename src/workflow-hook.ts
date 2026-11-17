import type { AnswerFile, LoopEvent, MailboxFiles } from "./mailbox.ts";
import { WorkflowEngine } from "./workflow-engine.ts";

/**
 * Puts the workflow in front of the journal. Every event the loop writes passes here: the engine picks its
 * handler, the event is journaled (with `handledBy` when the handler answers it, so a watching
 * orchestrator skips it), and only then are the actions started, so the journal order is the order things happened.
 * An answer or reply is written before `appendEvent` returns, so the loop that is about to wait for it finds it.
 */
export class WorkflowMailboxFiles implements MailboxFiles {
  constructor(
    private readonly inner: MailboxFiles,
    private readonly engine: WorkflowEngine,
  ) {}

  async appendEvent(event: LoopEvent): Promise<void> {
    const plan = this.engine.plan(event);
    const answered = plan !== null && WorkflowEngine.answers(plan);
    await this.inner.appendEvent(answered ? { ...event, handledBy: plan.handler.name } : event);
    if (plan === null) return;
    const written = this.engine.start(event, plan);
    if (answered) await written;
  }

  readAnswer(id: string): Promise<AnswerFile | null> {
    return this.inner.readAnswer(id);
  }

  clearAnswer(id: string): Promise<void> {
    return this.inner.clearAnswer(id);
  }
}
