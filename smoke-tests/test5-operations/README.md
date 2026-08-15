# test5 — consumer operations contract

This is the executable contract for the three levels an `acp-lib` consumer uses:

1. **Catalog management** — create, list, stop, and reopen logical `AgentSession`s using
   consumer-owned composition over the catalog primitives.
2. **Stable session control** — observe busy/finished state and hand off to a fresh
   internal thread without replacing the consumer's `AgentSession` identity.
3. **Harness commands** — inspect commands advertised over ACP and invoke one explicitly.

The test is deliberately non-interactive. A terminal UI may bind these operations to
slash commands, buttons, or a command palette, but none of those presentation choices
belong in the consumer API this test exercises.

It uses a deterministic fake ACP harness, so it needs no credentials, network, or model
tokens:

```bash
bun smoke-tests/test5-operations/operations-smoke.ts
SMOKE_TIMEOUT_MS=30000 bun smoke-tests/test5-operations/operations-smoke.ts
```

Exit codes:

- `0` — the complete consumer contract is implemented and every check passed.
- `1` — one or more operations are missing or violate the contract.
- `2` — the ACP fixture could not start, so the contract was not exercised.

## Stable identity contract

`agentSessionId` is the consumer's permanent handle. `internalSessionId` is the current
provider thread and is allowed to change:

```text
AgentSession "consumer-a"                 <- stable object and id
  internal session "consumer-a-thread-1"
                 |
              handoff
                 |
  internal session "consumer-a-thread-2"
```

The catalog must still contain one logical `consumer-a` record after the handoff, updated
to point at the second internal session. Its transcript remains one append-only logical
history with a typed handoff boundary between the two provider threads.

## Intended public shape

The smoke test pins this consumer-facing shape. Exact implementation details remain
internal.

```ts
const session = await AgentSession.create({
  ...,
  providerSession: { kind: "new" },
});

const unsubscribe = session.subscribe((notification) => {
  // state_changed, turn_started/completed/failed,
  // agent_commands_changed, handoff_started/completed/failed
});

session.state;
session.isBusy;
session.queuedOperationCount;

session.agentCommands;
await session.executeAgentCommand("status");

const before = session.internalSessionId;
const handoff = await session.handoff({ summary: "portable continuation context" });

// The logical identity survives; only the provider backing changes.
handoff.agentSessionId === session.agentSessionId;
handoff.fromInternalSessionId === before;
handoff.toInternalSessionId === session.internalSessionId;

await session.stop();

// Reopening is highest-layer consumer composition, not another core primitive.
const record = await sessions.get(session.agentSessionId);
if (!record) throw new Error("logical session missing from catalog");
const reopened = await AgentSession.create({
  adapter: await resolveAdapter(record.adapter),
  adapterId: record.adapter,
  agentSessionId: record.agentSessionId,
  providerSession: record.internalSessionId
    ? { kind: "load", internalSessionId: record.internalSessionId, onFailure: "error" }
    : { kind: "new" },
  mode: record.mode,
  cwd: record.cwd,
  title: record.title,
  sessions,
  transcriptDir,
});
```

Notifications use an envelope with monotonically increasing `seq`, `ts`, and the stable
`agentSessionId`. Listener exceptions must not affect the underlying operation.

## Why this starts red

This smoke test is being added before the implementation on purpose. Existing operations
continue to run, while missing planned methods are reported as explicit failed checks
instead of causing a compilation or startup failure. Each implementation part turns a
section green; committed library checkpoints still typecheck independently.

The fake harness is colocated as `operations-agent.ts`. It advertises `status` at session creation,
adds `usage` during the first turn, and gives every new provider thread a distinct id.
