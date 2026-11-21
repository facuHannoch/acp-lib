# Architecture documentation

Updated: 2026-11-20.

These pages describe the implemented harness. The reviewed foundation is on
`alpha`. The acp-client adapter and startup channel changes are implemented on
`acp-client-integration` and awaiting independent review. The
[work index](../docs/WORK.md) tracks proposed slices and review status.

| Document | Purpose |
| --- | --- |
| [Overview](overview.md) | Agent, channels, owners, and entry points |
| [Technical architecture](technical-architecture.md) | Runtime composition and the path from input to reply |
| [Execution](execution.md) | Scheduling, steering, model calls, permissions, and tool dispatch |
| [Context and data](context-and-data.md) | Shared timeline, derived requests, and inspection |
| [Persistence](persistence.md) | Storage adapters, recovery, and session files |
| [Suspend, stop, and resume](suspend-and-resume.md) | Session and channel lifecycle, interruption, and process replacement |

The root [ARCHITECTURE.md](../../ARCHITECTURE.md) defines dependency boundaries
and target layout. [Decision records](../decisions/) and the linked specs define
the exact contracts. Update these pages when implemented behavior changes.
