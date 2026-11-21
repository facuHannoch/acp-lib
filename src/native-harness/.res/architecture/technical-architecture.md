# Technical architecture

## Runtime composition

| Component | Code | Role |
| --- | --- | --- |
| Public client and protocol endpoint | [Client](../../src/interfaces/client.ts), [endpoint](../../src/interfaces/protocol/server.ts) | Validate wire requests, call session operations, and publish responses and events |
| Session assembly | [createSession](../../src/index.ts) | Wire storage, turn services, context, approvals, and observation |
| Channel scheduler | [channels.ts](../../src/kernel/channels.ts) | Schedule channels, own cancellation signals, and commit lifecycle transitions through storage |
| Turn loop | [loop.ts](../../src/kernel/loop.ts) | Coordinate repeated inference, paired tool results, completion, and checkpoint boundaries |
| Context builder | [build.ts](../../src/capabilities/context/build.ts) | Create model messages from a fresh timeline snapshot |
| Model runner | [runner.ts](../../src/capabilities/model/runner.ts) | Run attempts, enforce deadlines and retries, commit responses, and record usage |
| Policy and approval | [resolve.ts](../../src/governance/policy/resolve.ts), [gate.ts](../../src/governance/permissions/gate.ts) | Resolve policy and authorize each tool dispatch |
| Storage | [contract](../../src/contracts/storage.ts), [engine](../../src/state/storage/engine.ts) | Own transactional state changes over the memory and SQLite adapters |

The kernel uses contracts for I/O. The entry point composes the implementations.
The protocol adapts session operations to the wire and owns delivery concerns
such as framing and buffering. It delegates lifecycle and admission to the
session. The host uses public exports.

## One message through stdio

1. The client initializes, negotiates delivery, and creates or loads the
   session. A durable load returns a revisioned view before recovered work
   starts publishing live events.
2. `channel/push` commits the input to the inbox. Its reply acknowledges
   receipt. The same input ID and payload can be retried without accepting
   it twice.
3. The scheduler starts the channel's next turn or takes the input into the
   running turn at the next inference boundary. Taking creates the attributed
   timeline entry and associates the input with the turn.
4. The context builder renders the current snapshot. The model runner executes
   the request, optionally emits draft text, and commits the completed model
   response. A committed assistant message has a stable message ID.
5. Each requested tool passes through the same permission gate. The harness
   records dispatch evidence before execution and pairs any usable result
   with the request. The next iteration builds context again.
6. The turn finishes, fails, is interrupted, or reaches a suspension checkpoint.
   Conversation output and turn outcome are separate events. After a missed
   reply, the client can load its committed message and turn state.

## acp-client integration

On the integration branch, [NativeHarnessHost](../../../../src/native/host.ts)
owns the stdio child for an agent. [NativeController](../../../../src/native/controller.ts)
maps one conversation to one channel and adapts harness events to the existing
conversation supervisor. The host reconciles the load view with live events
and keeps submission IDs for safe retry. It can pass pending channel changes
with startup. The [integration log](../docs/acp-client-integration/0001-DESIGN/11-20-LOG.md)
records the implemented checkpoint, review status, and recovery gaps.
