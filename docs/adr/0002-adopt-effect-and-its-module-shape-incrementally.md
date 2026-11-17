# ADR-0002 — Adopt Effect and its module shape incrementally

Status: accepted
Date: 2026-11-17

## Context

The loop was written as plain TypeScript: classes, promises, hand-rolled fakes for the clock and the agent. Measured on the code, not supposed:

- 335 functions in 58 source files; 5% are longer than 20 lines, 3 nest control flow deeper than two levels, none uses `any`, none of the files exceeds 500 lines. On the size and depth rules this repository already meets what the maintainer's other backend keeps (10% of its functions over 20 lines, 14 nested deeper than two, 14 files over 500).
- What it does not have is the rest of that backend's stack: Effect services and layers, typed errors on an error channel, resources owned by a scope, and its toolchain (Vitest, ESLint, Prettier, knip, dependency-cruiser, jscpd).
- The code has the shape Effect addresses. A spawned agent process and a command runner are released by hand in `finally` blocks. A background-exit watcher is a hand-managed timer. Timeouts and the clock are injected by hand and tested with a hand-written fake clock. Workflow validation is a hand-written schema reader whose every error names its path. Failures are classes that callers match with `instanceof`.
- `effect` is at `4.0.0-rc.118` (published 2026-09-28, 50 days before this ADR), the newest release candidate; there is no stable 4.x, and the 3.x line stops at 3.22. The maintainer's other backend pins the same release.

## Decision drivers

- One stack across the maintainer's repositories means one set of idioms to read and review.
- Resource release and interruption are hand-managed today in `finally` blocks; scopes make release the runtime's guarantee. No leaked agent process or watcher appears in the measured history, so this is a maintainability driver, not the fix for an observed failure.
- Nothing may be rewritten for a framework's sake: a migration that stalls half done leaves two styles and no benefit.
- A command-line tool pays for its start-up on every invocation; `autopilot --version`, `events` and `validate` must not load a runtime they do not use.
- The package is meant to be installed by others, so a pre-release dependency has to be exact-pinned and gated like any other.

## Options considered

| Option                                                         | Pro                                                        | Con                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Stay on promises and classes                                   | Nothing to learn or migrate; zero runtime dependency       | The release and interruption defects stay hand-managed; two stacks |
| Rewrite everything on Effect at once                           | One style immediately                                      | A large change with no oracle but the tests; a stall leaves a mess |
| **Incremental: a tracer bullet first, then code in scope**     | Proves the stack on one real path before committing to it  | A period with both styles, bridged at one boundary                 |
| Effect 3 (stable)                                              | Mature API                                                 | A different API and error model from the maintainer's other repos  |

## Decision

1. **`effect` `4.0.0-rc.118`, exact-pinned**, with the release-age gate in `.npmrc` unchanged. It is the version the maintainer's other backend uses; Effect 3 is not chosen.
2. **Incremental migration.** Code moves when it is already in scope; nothing is rewritten for Effect's sake. The first slice is a tracer bullet through every layer (the limit wait: workflow handler, iteration, the probe's child process, the journal line, the report), which also measures cold start. Every Promise-to-Effect boundary goes through one shared runtime bridge.
3. **Module shape.** A service is a `Context.Service` whose tag lives in its component's `types.ts` when it is a port (a boundary an adapter implements) and in its own module when it is not. Its layers live in `layers.ts` and are named for what they provide (`<noun>Layer`). Methods are `Effect.fn("Domain.method")`. Expected failures are `Schema.TaggedError`s on the error channel, with the component's error union exported.
4. **Resources are scope-owned.** A spawned agent, a command runner's child, and the background-exit watcher live under `Scope`, `acquireRelease` and `forkScoped`, so interruption releases them.
5. **Tests keep named fakes**, supplied as layers; Effect's `TestClock` replaces the hand-written fake clock as each module moves.
6. **Start-up stays cheap.** CLI verbs that need no loop (`--version`, `events`, `init`, `validate`) import nothing from the runtime; the loop's graph is imported lazily by `run`.
7. **Standards before code.** The toolchain parity slice lands first, so the rules (no `any`, depth, function length) are enforced by gates, not by review.

## Consequences

- For a while two styles coexist, and the runtime bridge is the only place they meet; a module on either side of it is never half converted.
- Effect becomes the package's one runtime dependency beside `yaml`.
- The decision is revisited if the tracer bullet measures a cold-start or size cost the verbs above cannot avoid, or if a stable 4.x changes the pin.
