# Native harness

One agent entity, with a stable identity, talking on many channels and delegating
environment work to existing harnesses. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

The architecture is agreed; implementation has not started. There is no runnable
harness CLI or public API yet. Experiments live in [.res/sandbox/](.res/sandbox/).

We are starting with a small, hands-on learning milestone before delegating the
broader implementation:

1. Send a message to a model and keep one conversation's history in memory.
2. Add one harmless tool and run the inner loop: model call, tool execution,
   matching tool result, next model call, until the model answers without tools.
3. Show requests, tool calls, results and stop reasons; enforce a call limit.
4. Reproduce the behavior offline with a scripted model before expanding it.

This milestone is a slice of the design, not completion of v1 part 1. Sessions,
multiple channels, policies, persistence, MCP, delegation and server mode follow
the existing specs as implementation progresses. Keep the loop, model client and
tool execution separate from the beginning.

## Development

The repository uses TypeScript and Bun (currently Bun >= 1.3.5). No additional
harness dependencies have been introduced. Record new runtime and development
dependencies here until the harness has its own package manifest.

Once implemented, the standalone CLI entry point will be `cli/main.ts`, and
harness tests will live in `test/`. Add verified run and test commands here when
those entry points exist.

## Documents

- [Architecture](ARCHITECTURE.md): boundaries, extension points and intended layout.
- [Contribution rules](AGENTS.md): instructions for implementing and reviewing changes.
- Decision records belong in `.res/decisions/` within this directory; create them
  as decisions are made. Other working notes and experiments also belong in `.res/`.

The detailed design references remain in the repository's research directory:

- [Design and rationale](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-design.md)
- [Project organization](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-project.md)
- [V1 scope and acceptance](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-v1.md)
- [Host protocol](../../.res/somelogs.md/11-11+/11-12-SPEC-harness-protocol.md)
- [Library integration](../../.res/somelogs.md/11-11+/library/11-11-SPEC-native-harness-integration.md)

These references describe the intended system, not implemented behavior. The
owner's later instruction places decision records in `.res/decisions/` rather
than the top-level `decisions/` shown in the original project spec.
