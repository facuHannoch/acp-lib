# Native harness

One agent entity, with a stable identity, talking on many channels and delegating
environment work to existing harnesses. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

An initial in-memory REPL and tool loop are implemented. It uses OpenRouter native
tool calls, retains messages between prompts and includes one harmless
`current_time` tool. There is no public session API or stdio protocol yet.
Experiments live in [.res/sandbox/](.res/sandbox/).

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

This directory is an independent TypeScript and Bun project (Bun >= 1.3.5), with
its own package manifest, lockfile and TypeScript configuration. It does not
depend on the parent acp-client package. Development dependencies are TypeScript
and Bun types; there are no runtime dependencies.

From this directory:

```sh
bun install
bun run typecheck
bun run test
OPENROUTER_API_KEY=your-key bun run start
```

The REPL entry point is `cli/main.ts`. Its `systemPrompt` variable and `messages`
array are the initial configuration and history. Type `/exit` to quit. Ask for
the current time to exercise tool use. The default model is
`deepseek/deepseek-v4.1-flash`; override it with `OPENROUTER_MODEL`.

`kernel/loop.ts` coordinates turns; `model/openrouter.ts` translates provider
messages. Tool definitions and execution are configured in the REPL. Only
`current_time` is permitted. Offline tests cover loop continuation, history and
provider request mapping. No runtime dependencies were added.

This first slice has no call limit, streaming, persistence, cancellation or
timeout. API failures stop the REPL; tool errors are returned to the model.
Terminal output here is for interactive use, not a stdio server protocol.

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
