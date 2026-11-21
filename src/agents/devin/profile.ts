import type { AgentProfile } from "../../agent-profile.ts";
import { DevinDialect } from "./dialect.ts";
import { classifyDevinError } from "./limit-text.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * `devin acp`, as measured on 3000.12.57. Devin polls a running command every
 * 10 to 15 seconds, so an hour of total silence is not a test suite, and three
 * hours is not a working agent. Declining the plan exit is a cancelled
 * request: it carries a reject option too, but cancelling is what was
 * measured to end the turn without work.
 */
export const DEVIN_PROFILE: AgentProfile = {
  name: "devin",
  defaultCommand: "devin",
  launchArgs: ["acp"],
  bypassMode: "bypass",
  exitPlan: { bypassOptionId: "plan_bypass", declineOptionId: null },
  timing: {
    possiblyHungAfterMs: 45 * MINUTE,
    cancelAfterSilenceMs: 3 * HOUR,
    backgroundCeilingMs: 3 * HOUR,
    limitPollMs: 30 * MINUTE,
    // cam polls the accounts every 60 s (its autoswitch.intervalSeconds), so a probe faster than that cannot see a switch sooner.
    limitProbeMs: MINUTE,
    limitMarginMs: MINUTE,
    watchEveryMs: MINUTE,
    // Devin's own shell poll is 10-15s; a probe faster than that cannot see an exit sooner.
    backgroundLivenessProbeMs: 15_000,
  },
  usesClaudeAccounts: false,
  probesShellLiveness: true,
  createDialect: () => new DevinDialect(),
  classifyError: classifyDevinError,
};
