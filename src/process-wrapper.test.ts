import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hintFor, isWrapper, type WrapperRule } from "./process-wrapper.ts";

const QUEUE: WrapperRule = { program: "jobq", ignoreArgs: ["--status", "--lane"], hint: null };

describe("isWrapper", () => {
  it("recognises the wrapper by the shell that runs it, whether it waits or runs", () => {
    assert.equal(isWrapper("bash /home/user/.local/bin/jobq /home/user/gate.sh", QUEUE), true);
    assert.equal(isWrapper("/usr/bin/bash /home/user/.local/bin/jobq pnpm -s typecheck", QUEUE), true);
  });

  it("recognises a wrapper started by its own name", () => {
    assert.equal(isWrapper("jobq pnpm test", QUEUE), true);
    assert.equal(isWrapper("/home/user/.local/bin/jobq ./gate.sh", QUEUE), true);
  });

  it("ignores the first arguments the rule lists, which end at once and queue nothing", () => {
    assert.equal(isWrapper("bash /home/user/.local/bin/jobq --status", QUEUE), false);
    assert.equal(isWrapper("bash /home/user/.local/bin/jobq --lane pnpm lint", QUEUE), false);
  });

  it("ignores a process that only mentions the program in its text", () => {
    assert.equal(isWrapper("/usr/bin/zsh -c jobq --status && echo done", QUEUE), false);
    assert.equal(isWrapper("systemd-run --user --wait --unit=jobq-app-9 --same-dir gate.sh", QUEUE), false);
    assert.equal(isWrapper("grep jobq notes.md", QUEUE), false);
    assert.equal(isWrapper("", QUEUE), false);
  });

  it("works for any wrapper program, with no ignored arguments", () => {
    const make: WrapperRule = { program: "taskq", ignoreArgs: [], hint: null };

    assert.equal(isWrapper("python3 /opt/bin/taskq run gate", make), false, "python is not a shell the rule looks through");
    assert.equal(isWrapper("sh /opt/bin/taskq run gate", make), true);
    assert.equal(isWrapper("taskq --status", make), true, "nothing is ignored unless the rule says so");
  });
});

describe("hintFor", () => {
  it("fills the process id and its directory's name into the rule's hint", () => {
    const rule: WrapperRule = { ...QUEUE, hint: "`jobq cancel {{dir}}-{{pid}}` ends it" };

    assert.equal(hintFor(rule, { pid: 99873, cwd: "/home/u/repos/app" }), "`jobq cancel app-99873` ends it");
  });

  it("gives nothing for a rule with no hint", () => {
    assert.equal(hintFor(QUEUE, { pid: 1, cwd: "/x" }), null);
  });
});
