# Bounded context implementation plan

Date: 2026-11-23

Status: Gate 1 contracts drafted. Review the decision before Gate 2.

## Scope and base

Implement [SPEC.md](SPEC.md) inside the native harness. Record the exact `alpha`
revision at handoff and verify the code paths below against it. Follow the
[architecture](../../../../ARCHITECTURE.md) and [contribution rules](../../../../AGENTS.md).
The first end-to-end checkpoint uses existing text and notice inputs. Timeline
retrieval and image input extend it through their own specs.

## Modules and ownership

Paths in this table are relative to the native harness package.

| Area | Existing code | Work |
| --- | --- | --- |
| Contracts | `src/contracts/context.ts`, `storage.ts`, `model-execution.ts` | Define the call-scoped context, the revisioned inference read, and the typed context-limit outcome. Reuse neutral messages and tool definitions. Pin the relationship between rendered input and the IDs used by model receipts and scripted playback. |
| Storage | `src/state/storage/engine.ts`, `sqlite.ts`, `memory.ts` | Implement one bounded inference read. Reuse turn and channel range indexes where they fit. Read active input, turn policy metadata, and local and shared history from one revision. Keep queries and index choices in storage. |
| Context | `src/capabilities/context/build.ts` | Evolve the current renderer into pure selection and assembly. Keep harness instructions here. Add the small session-scoped builder alongside it, with injected read and tool-selection dependencies. |
| Session assembly | `src/index.ts`, `src/kernel/loop.ts` | Create the builder at session open. Call it after taking eligible input. Replace the separate full snapshots used for prompt building, tool policy, and input IDs. Keep the kernel concerned with sequencing through contracts. |
| Model and tools | `src/capabilities/model/runner.ts`, `src/capabilities/tools/`, `src/governance/permissions/` | Pass a single assembled request to the existing runner. Reuse its retry snapshot and the registry's tool ordering. Recheck availability at dispatch through the existing gate. Provider encoding stays with the model adapter. |
| Input admission | `src/kernel/channels.ts`, `src/interfaces/protocol/`, `src/interfaces/cli/chat.ts`, development web chat | Enforce the text byte limit before durable acceptance. Surface the same limit for client preflight. Route all sends through the authoritative check. |
| Development observation | `src/interfaces/cli/development.ts`, `src/interfaces/inspector/` | Capture actual inference input in Gate 3. Use focused status, bounded session-wide preview, and paged timeline reads. Remove per-event full snapshots from both preview and status paths. |

## Implementation gates

### 1. Contract and budget rules

Review [decision 0026](../../../decisions/0026-bounded-context.md). It defines the
five logical parts, one-revision storage read, frozen request inputs, and
context-limit error. Pin what material must fit and where the builder can omit
an entire completed tool exchange. Capture the tool offer once for the request.
Keep dispatch authorization tied to all applicable taken input policies, even
when some material is trimmed from the prompt. Specify how the represented
input IDs feed delivery and Seen receipts, and preserve the scripted model's
boundary-scoped input IDs. A build rejected for size starts no model attempt.
It pins the published byte limit and rejection outcome at admission, how multiple
eligible inputs fit at a boundary, and how already-taken inputs settle on a
context-limit failure. Provider output enforcement remains open.

Review the initial defaults in [Business rules](../../BUSINESS_RULES.md), including
the input estimate, output reserve, record and byte read bounds, and allocation
between local and shared history. Review the decision and typecheck the contracts
before starting the storage implementation.

### 2. Bounded storage read

Implement the inference read on SQLite and memory under shared conformance.
Read detached data at one committed revision and release the read before
rendering or provider work. Return enough information to detect when required
material exceeded its read budget. Inspect payload sizes before loading bodies.
Check row and byte bounds separately, including unusually large records and a
recent range dominated by one channel. Use query plans to check index use and
add indexes where the existing ones leave a gap.

Exercise a long timeline with a busy second channel. Verify adapter parity,
stable ordering, the correct active inputs and policy metadata, and bounded
results. Instrument the read path to detect calls to full snapshots and verify
the SQLite path avoids materializing the history to apply its limits.

### 3. Inference integration

Create `SessionContext` in session assembly and wire one build into each
inference boundary. Pass selected inputs and the exact tool offer to the existing
model runner. Use focused reads for dispatch-time policy when a fresh check is
needed. Preserve provider reasoning state with the exchanges that require it.
Wire the input limit through harness admission and client preflight. Add a
minimal inference capture to the existing Channels tab for the first web-chat
exercise, with the revision, selected messages, tools, and trims.

Extend `test/context.test.ts` and the existing scripted request and model runner
tests. Check the five parts, provenance, local and shared allocation, trimming,
and whole call–result pairing. Exercise an over-budget required input, concurrent
channel notices, and a provider retry that receives the same request after
another channel commits. Verify newly taken input is represented before it can
be marked seen and that the captured context excludes later commits.

### 4. Inspector and end-to-end checkpoint

Complete the inspector with lightweight pushed status, focused historical call
reads, and an on-demand paged Timeline. Build the bounded session-wide Live
Context preview on open or refresh. Coalesce change notifications and only
refresh while visible. On reconnect, reread status and the visible view. Respect
diagnostic capture controls and use image metadata in inspection. Instrument
both observer paths to check that events trigger no full-session snapshots.

Run a scripted two-channel scenario through real stdio with a long durable
timeline. Hold one inference while another channel sends a correction and makes
progress. Verify bounded assembly reads, the held request's revision, the next
build's view, explicit notice steering and wake, and continuity after reopen.
Exercise the same behavior in the development web chat and inspect the captured
requests. Record the initial allocation and any changes made from that exercise.
Run package typecheck and the harness suite, plus native integration regression
checks for the shared entry points. Update the architecture and usage docs with
the accepted behavior.

## Scale evidence

Measure context storage reads, assembly, inspector work, and model-call bookkeeping separately
from provider wait time. The current model-call store reads and rewrites an
accumulated model-state record. This plan's scale gate proves bounded context
assembly. If bookkeeping still grows with session length, record that separately
with the measurements so it can be addressed in its owning design.
