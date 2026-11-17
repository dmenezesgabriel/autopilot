import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderUnit, unitNameFor, type UnitInput } from "./service-unit.ts";

const INPUT: UnitInput = {
  repoRoot: "/home/u/repos/app",
  command: ["/home/u/.nvm/versions/node/v24/bin/node", "/home/u/repos/autopilot/dist/cli.js"],
  home: "/home/u",
  runArguments: ["--agent", "devin"],
};

describe("renderUnit", () => {
  it("runs this autopilot's `run` against the repository, with the node that holds the agents on PATH", () => {
    const unit = renderUnit(INPUT);

    assert.match(
      unit,
      /^ExecStart=\/home\/u\/\.nvm\/versions\/node\/v24\/bin\/node \/home\/u\/repos\/autopilot\/dist\/cli\.js run --repo \/home\/u\/repos\/app --agent devin$/m,
    );
    assert.match(unit, /^Environment=PATH=\/home\/u\/\.nvm\/versions\/node\/v24\/bin:\/home\/u\/\.local\/bin:/m);
  });

  it("restarts a crash or a kill but never the loop's own circuit-breaker halt", () => {
    const unit = renderUnit(INPUT);

    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^RestartPreventExitStatus=1$/m);
  });

  it("limits restarts, so a loop that cannot start does not retry forever", () => {
    const unit = renderUnit(INPUT);

    assert.match(unit, /^StartLimitIntervalSec=3600$/m);
    assert.match(unit, /^StartLimitBurst=5$/m);
  });

  it("starts with the user's session", () => {
    assert.match(renderUnit(INPUT), /^WantedBy=default\.target$/m);
  });

  it("quotes an argument that holds a space", () => {
    const unit = renderUnit({ ...INPUT, runArguments: ["--plan-follow-up", "/engineering-mode tackle this plan:"] });

    assert.match(unit, /--plan-follow-up "\/engineering-mode tackle this plan:"$/m);
  });
});

describe("unitNameFor", () => {
  it("names the unit after the repository's directory", () => {
    assert.equal(unitNameFor("/home/u/repos/app"), "autopilot-app.service");
  });
});
