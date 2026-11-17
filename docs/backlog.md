# Backlog

The ledger of what to build, edited in place and never appended to. The first row marked `open ← next` is the next slice, so autopilot can drive its own backlog. Each row is one capability that crosses the layers and ends in a demo; a row that is only a layer is cut wrongly.

| Need                                | Read                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| What to work on next                | this file, the first open row marked next in the State column                           |
| Why the system is shaped this way   | [`adr/`](adr/) and [`rationale.md`](rationale.md)                                       |
| What a workflow file can say        | [`workflow.md`](workflow.md)                                                            |

Ids: `ADR-NNNN` decision, `SL-NNN` slice. A row's evidence is what justifies building it; a row with none says so and waits for an experiment.

## Foundations

| Slice  | Capability                                                                                                                   | Evidence                                                                                                  | State                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- |
| SL-001 | The toolchain of the maintainer's other backend: Vitest, ESLint (no `any`, depth 2, 20-line functions), Prettier, knip, dependency-cruiser, jscpd, with quiet-on-pass gates and the tests converted | [ADR-0002](adr/0002-adopt-effect-and-its-module-shape-incrementally.md) §7: the rules are enforced by gates, not review | **open ← next**      |
| SL-002 | Tracer bullet on Effect: a limit wait ends early, through the workflow handler, iteration, the probe's child process under a scope, the journal line and the report; cold start measured before and after | ADR-0002 §2; the wait is the path whose resource and timeout handling is most hand-written | open                 |

## Measured next steps

| Slice  | Capability                                                                                                               | Evidence                                                                                                                                                  | State |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| SL-003 | `autopilot preflight`: start the harness, read what it offers and check the workflow's harness, model, effort and command, with no prompt sent | A real run's first attempt named a model the harness does not offer and halted only after an iteration had started; the check costs no tokens            | open  |
| SL-004 | A configurable answer policy: how long a question waits, and whether it is then answered with a default or left to wait ("fail closed") | One question in 115 iterations was answered with its default after an hour and the run went on with an option nobody reviewed                              | open  |
| SL-005 | Loop-side verification: a command the loop runs after the agent's commit, whose failure goes back to the agent as a reply, bounded      | One documented run shipped with a failing test tier because the loop checks only git state. Running a repository's checks again doubles host load: measure the cost first | open (measure first) |

## Before the repository is published

| Slice  | Capability                                                                                                                                                              | Evidence                                                                                                                                        | State |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| SL-006 | The rest of a public repository's standard set: CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG, issue and pull-request templates, CI on every push, dependency updates, a security scan, a supply-chain scorecard, a release workflow with provenance | The maintainer's newest public repository ships every one of these; this repository ships LICENSE, NOTICE and SECURITY only. Each needs the repository's real URL, which does not exist yet | open  |

## Needs evidence before any work

| Idea                                                                                  | Why it waits                                                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Stages inside an iteration, each on its own harness and model (plan on one, implement on another) | No measurement of quality or cost per stage exists. The plan phase is 3% of an iteration for one harness and 21% for the other, which is a reason to measure, not to build |
| Parallel work within one repository                                                   | Queue wait already reached half an hour per hour of job time with three loops; more parallelism on one host would add to it       |

## Tested and rejected

Recorded in [`rationale.md`](rationale.md): a per-iteration cap, a no-progress cutoff, a quota threshold, tool-call loop detection, resuming an interrupted session, and retrying only transient failures.
