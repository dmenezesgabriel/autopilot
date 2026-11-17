import { execFile } from "node:child_process";
import type { LimitProbeKind } from "./workflow.ts";

/**
 * Whether the account the agent runs on can take a request again, asked without spending a token.
 * `null` means the probe cannot tell (the tool is missing, failed or printed something unexpected),
 * and the loop then waits for the agent's own reset time as it did before there was a probe.
 */
export interface LimitProbe {
  usable(): Promise<boolean | null>;
}

type Window = { pct?: unknown };
type CamStatus = {
  active?: {
    usageStatus?: unknown;
    usage?: { fiveHour?: Window; sevenDay?: Window; scoped?: unknown };
  };
};

/**
 * Reads `cam status --json` (the live account's usage). The account can take a request when it is
 * not exhausted: every window it reports is under 100%. The API itself rejects at 100%, so no other
 * threshold is invented; a request that is still rejected only sends the loop back to waiting.
 *
 * @example
 * usableFromCamStatus('{"active":{"usageStatus":"ok","usage":{"fiveHour":{"pct":13},"sevenDay":{"pct":2},"scoped":[]}}}');
 * // => true
 */
export function usableFromCamStatus(json: string): boolean | null {
  let parsed: CamStatus;
  try {
    parsed = JSON.parse(json) as CamStatus;
  } catch {
    return null;
  }
  const active = parsed.active;
  if (active?.usageStatus !== "ok" || !active.usage) return null;
  const { fiveHour, sevenDay, scoped } = active.usage;
  const windows = [fiveHour, sevenDay, ...(Array.isArray(scoped) ? scoped : [])];
  const readings = windows.map((window) => (window as Window | undefined)?.pct);
  if (!readings.slice(0, 2).every((pct) => typeof pct === "number")) return null;
  return readings.every((pct) => typeof pct !== "number" || pct < 100);
}

export type RunText = (command: string, args: string[]) => Promise<string>;

/** `cam` is the account manager that moves the live Claude login to the account with the most headroom. */
export class CamLimitProbe implements LimitProbe {
  constructor(private readonly run: RunText) {}

  async usable(): Promise<boolean | null> {
    try {
      return usableFromCamStatus(await this.run("cam", ["status", "--json"]));
    } catch {
      return null;
    }
  }
}

export const runText: RunText = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** The probe the config names; `none` leaves the loop waiting for the agent's own reset time. */
export function limitProbeFor(kind: LimitProbeKind): LimitProbe | null {
  return kind === "cam" ? new CamLimitProbe(runText) : null;
}
