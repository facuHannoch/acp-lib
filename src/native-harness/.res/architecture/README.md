# Architecture documentation

Updated: 2026-11-16.

These documents describe the harness as it exists and distinguish proposals from
implemented behavior. The root [ARCHITECTURE.md](../../ARCHITECTURE.md) remains
the target layout and dependency guide. [Decision records](../decisions/) explain
accepted changes; a proposal here does not replace a contract decision.

| Document | Purpose | Status |
| --- | --- | --- |
| [Overview](overview.md) | Entity model, ownership, entry points and boundaries | Current implementation |
| [Technical architecture](technical-architecture.md) | Runtime objects, code locations, composition and message flow | Current implementation |
| [Execution](execution.md) | Channels, turns, concurrency, notices and output | Current implementation |
| [Context and data](context-and-data.md) | Stored information, queries and inference context | Current implementation and intended separation |
| [Persistence](persistence.md) | SQLite design, restart behavior and incremental delivery | Proposal; no persistence implemented |
| [Suspend and resume](suspend-and-resume.md) | Lifecycle, safe checkpoints, updates and relocation | Agreed direction; not implemented |

Maintain these documents when the corresponding behavior changes. Describe the
resulting architecture rather than keeping a chronological work log. Move an
implemented proposal into the current-behavior sections and keep unresolved
decisions explicit.
