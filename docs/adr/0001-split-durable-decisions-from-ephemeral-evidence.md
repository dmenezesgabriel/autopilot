# ADR-0001 — Split durable decisions from ephemeral build evidence

Status: accepted
Date: 2026-11-17

## Context

This project is built by measuring real loops and by studying how other tools solve the same problem. Evidence of the second kind is worth a great deal on the day it is used and little afterwards, because the tools it describes change. A design record that carries both rots: its citations go stale and nobody re-verifies them.

## Decision drivers

- A decision must stay readable long after the code that motivated it changed.
- Every session that works on the repository re-reads its documentation, so size is a running cost.
- A reader of a public repository cannot follow a reference to a private project or to a machine they do not have.

## Options considered

| Option                                                    | Pro                                         | Con                                                |
| --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| One growing design document                               | Nothing to route between                    | Decisions and evidence rot together                |
| Decisions beside code, evidence kept forever              | Specs stay true                             | The evidence still rots, and costs every session   |
| Split by lifetime: durable decisions, ephemeral evidence  | Each is kept or discarded on its own merits | Needs the discipline to actually delete            |

## Decision

Documents are split by lifetime, not by topic.

- **Durable:** `docs/adr/`, `docs/rationale.md`, the README and the workflow reference. They state decisions and measurements in terms a stranger can follow. They never cite a research checkout (`research_repos/`, which is gitignored and read-only), a private project, or a path on one machine.
- **Ephemeral:** a slice's own document, written when the slice is picked up and deleted when it ships. It may be as dense with citations and comparisons as it needs.

What survives a shipped slice is an ADR when a non-trivial decision was made, and code comments that state their reason without a link. Measurements that explain a feature live in `docs/rationale.md` with the method stated, anonymized.

## Consequences

- A slice's evidence is thrown away on purpose; the ADR and the rationale are what a later reader gets.
- Material specific to one owner's repositories lives outside the tracked tree (`local/` is gitignored).
