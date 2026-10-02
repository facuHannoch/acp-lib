# Adopting an existing provider session

Status: proposed. Builds on `9-24-SPEC-conversation-persistence-policy.md`.

A provider (ACP agent) may already hold sessions the library did not create: sessions made by
another client, by an earlier deployment, or before the library owned the conversation. The
protocol can list them (`session/list`) and load them (`session/load`). A consumer wants to bring
one of them into an `Agent`.

This is not just `session/list` plus `session/load`. A conversation owned by an `Agent` has an
identity: records, checkpoints, summaries, cursors, and a memory shared with the Agent's other
conversations. Loading a 500-message session into that model raises a consistency problem the
existing recovery design (periodic checkpoints) does not cover.

## The problem

When a session is brought in:

- **Inside the conversation**, the agent already knows its own history (the provider holds it).
  Nothing needs to be solved here beyond the normal checkpoint cursors going forward.
- **Outside the conversation**, every other conversation of the Agent has no recollection of it.
  Identity is built from stored messages and checkpoint summaries, so an adopted conversation
  with no summary is invisible to the others.

Options considered for the outside:

1. *Leave it out of memory.* This is not a "solve later" choice. The transcript only grows, so
   the problem never gets smaller, and the periodic summarizer would summarize only the first
   response after load, which is misleading.
2. *Summarize it ourselves.* Not viable: the transcript can exceed any context window, and models
   differ in how much they handle.
3. *Ask the model.* The provider session is reachable (otherwise there would be no load), and the
   model decides how to compress what it holds. The responsibility for large histories stays with
   the model. **Chosen.**

## Two modes

| | `adopt` | `attach` |
|---|---|---|
| Library owns the conversation | yes | no |
| Stores records | from now on, plus optional retroactive import | no |
| Joins identity (contributes and receives) | yes | no |
| Baseline summary | yes (recap) | no |
| Status | this spec | not specified, see TODO |

`attach` (drive a session through the Agent model without storing or joining memory) is blocked on
an `identity: false` mark that this spec does not add. See
`10-2-TODO-attach-and-identity-false.md`. Until then, a consumer that only wants to drive a
session uses `acp-client` directly.

## API

Adoption is declared when the conversation is created, because the persistence policy is resolved
once at conversation start and held for the conversation's life (see the persistence policy
spec). Binding a session after creation would be too late for the resolver to know about it.

```ts
export interface AdoptProviderSessionConfig {
  readonly providerSessionId: string;
  /**
   * Write replayed history through the normal capture path.
   * `{ last: n }` keeps only the final `n` turns. The tail starts at a turn boundary.
   * Default: `{ last: <small default> }` when `recap` is on, otherwise `false`.
   * The resolver's capture policy still decides what is stored.
   */
  readonly importHistory?: boolean | { readonly last: number };
  /** Ask the model for a baseline summary. Default: `true`. */
  readonly recap?: boolean;
}

export interface CreateAgentConversationConfig {
  // ...existing fields...
  readonly adopt?: AdoptProviderSessionConfig;
}

export interface ConversationPersistenceContext {
  // ...existing fields...
  /** True when the conversation was created by adopting a provider session. */
  readonly adopted: boolean;
}
```

`adopted` is stored on the conversation row so the resolver sees the same value for conversations
from earlier processes. It states how the conversation came to exist, not what it is for, so it
does not violate the persistence spec's rule against a `kind` or `purpose` field.

Listing sessions, for a picker UI:

```ts
interface ProviderSessionSummary {
  readonly providerSessionId: string;
  readonly title?: string;
  readonly updatedAt?: string;
  /** Conversation that already owns this session, if any. */
  readonly adoptedBy?: AgentConversationId;
}

agent.conversations.listProviderSessions(options?: { cwd?: string }): Promise<ProviderSessionSummary[]>;
```

It throws a structured error when the agent does not advertise `session/list`.

## Requirements and validation

Adoption follows the existing `create()` model: validate caller input before the durable row,
write the row, start the provider, and on a provider failure record an error and keep the row.

**Before the row** (inside `prepareStart`, so a mistake writes nothing and records nothing):

- the resolved policy does not capture message content (`message: "none"` or `"metadata"`). An
  adopted conversation joins identity, which requires stored content. A consumer that wants no
  storage should drive the session with `acp-client` instead. (`"metadata"` is already rejected
  while checkpointing is enabled; this rule extends it to adoption.)
- `recap` is on but checkpointing is not enabled;
- `providerSessionId` is already bound to a conversation of this Agent. The error names that
  conversation, so a UI can offer "open existing". This needs a lookup by provider session ID.
  The `provider_sessions` table has an index only per conversation, so adoption adds one.

**After the row** (through the existing provider-failure path):

- the agent does not advertise `loadSession`;
- `session/load` fails.

The binding always uses `session/load`, never `session/resume`. Load is the form that replays the
history, which the consumer can show to the user, and `resume` is not always supported.

A conversation can adopt only at creation, once. There is no `conversation.adopt()` on an
existing conversation.

## Flow

1. Validate before the row (above). Resolve the persistence policy with `adopted: true`, at the
   same point as the existing `prepareStart` checks and before any durable write.
2. Write the conversation row with `adopted = true`.
3. Start the provider with `providerSession: "load"` and `internalSessionId = providerSessionId`.
   This path already exists in `start()`. The `provider_sessions` record is written after the
   provider attaches, as it is today, so there is no preset session ID on the row. Report
   `providerSession: "loaded"`.
4. Capture the replay (`session/update` notifications). Write it through the normal capture path
   according to `importHistory` and the resolved policy. The replay already contains the whole
   history; the library only chooses which part to store.
5. If `recap` is on, run the recap (below).
6. Place the checkpoint cursor after the adopted history, so the periodic summarizer sees only
   later turns.
7. The conversation is usable. Normal capture, checkpointing and identity apply from here.

Providers differ in how much they replay. If a provider replays nothing or partially, the stored
history is whatever was replayed, and the recap still comes from the model's own context.

### Failure

If step 3 fails (including a missing `loadSession` capability), the library records a
provider-session load-failure error against the conversation, as the existing load-failure
records do, and throws. **The row stays**, as it does for `create()`.

A bare `open()` of a conversation with no provider session would create a *new* session, silently
not the adopted one. So a row with `adopted = true` and no active provider session is a failed
adoption, and `open()` on it must retry the load of the original `providerSessionId` or refuse
with a structured error. It must never create a new session. The `providerSessionId` therefore
has to be kept somewhere (see "Storage changes").

## Recap

The recap is a request made to the model on the adopted session, using the existing internal
inference and checkpoint machinery. The model chooses how to compress its history. The library
does not chunk or summarize anything itself.

- Where the agent supports session forking, the request runs on a fork, leaving the adopted session
  untouched. Fork is unstable in the protocol and not universal, so it is an optimization.
- Otherwise the request is a hidden turn on the adopted session itself. The library consumes the
  response and does not write it as a chat message or show it. The provider's own session history
  now contains that exchange, which is a known and accepted side effect.
- The first real user message queues behind the recap.
- The result is stored as the first checkpoint record, followed by the imported tail
  (`importHistory`), so identity delivers a summary plus recent turns.

Failure: if the recap fails or times out, the conversation exists but is not in memory. It is
marked as awaiting its recap and retried; the failure is written as an error record under the
conversation's resolved policy. The conversation remains usable. Whether other conversations may
receive anything from it before the recap succeeds is an open question.

## Storage changes

- `adopted` on the conversation row. A migration defaults existing rows to `false`.
- A lookup by provider session ID across conversations (an index on `provider_sessions`).
- A place for the `providerSessionId` of a failed adoption, so `open()` can retry it.

## Other decisions

- **Reuse the existing session catalog.** `listProviderSessions` builds on `client.listSessions()`
  and the catalog in `session-manager.ts` / `session-store.ts`, which already merges our records
  with the agent's live `session/list`. It does not add a parallel path.
- **Identity belongs to the Agent.** The adopted session may have been created under a different
  system prompt. Going forward, the library delivers the current identity and does not try to
  rewrite the past.
- **Failed load.** A load that fails partway keeps the conversation row and records the failure,
  as in "Failure" above. A partially captured replay is not rolled back; the failed adoption is
  retried through `open()`.
- **Working directory.** `session/list` is scoped by cwd. `listProviderSessions` takes it as an
  option and does not widen it.
- **Fork as a user action** (`session/fork` exposed to consumers) is out of scope.

## Removal methods

Related, separable from adoption. Both are explicit calls and never a side effect of a policy
change; the persistence spec's rule that a narrower policy never deletes rows is unchanged.

- `conversation.clearTranscript()`: deletes the stored messages and keeps the conversation. What
  happens to checkpoints already derived from the cleared rows is deferred.
- `conversation.delete({ providerSession: "best-effort" | "no", checkpoints?: boolean })`: removes
  the conversation, optionally also its checkpoints, and tries `session/delete` on the provider
  where supported. It reports `{ providerDeleted: true | false | "unsupported" }`.

Both are local deletions, not forgetting. Audit entries already written and checkpoints already
delivered into sibling conversations survive, and the provider agent's own memory is untouched.

## Non-goals

- `attach`, and the `identity: false` mark it needs (see the TODO file).
- Adopting into an existing conversation, or merging two histories.
- Rewriting or redacting what the adopted session already contains.
- Stored-but-excluded conversations (an archive that contributes nothing to identity). Stored
  content currently makes a conversation an identity source.
- Exposing `session/fork` to consumers.
- Making the provider forget anything.

## Open questions

- Final name for the recap (`recap`, `baseline`, `catch-up`).
- Whether other conversations may receive from an adopted one while its recap is pending.
- Default size of the imported tail when `recap` is on.
- Whether `session/list` pagination needs surfacing in `listProviderSessions`.
- The recap needs a distinct checkpoint record origin, so recovery and identity can tell a seeded
  baseline from a checkpoint the library computed itself.
- Whether the hidden recap turn can be consumed without being recorded, given how
  `src/out-of-band-messages.ts` and the internal-inference path run turns. Not yet checked.
- Whether `create({ adopt })` waits for the recap or returns immediately with a "recap pending"
  state, since the first user message queues behind it.
- Whether replay notifications carry enough information to find turn boundaries for
  `importHistory: { last: n }` on every provider.
- Where the `providerSessionId` of a failed adoption is kept (see "Failure").
- What `clearTranscript()` does to derived checkpoints.
- Requirement from the steering spec: the recap must run as an operation of its own kind in the conversation's operations queue, so a steered user message never cancels it (see `10-2-SPEC-steer-pending-messages.md`).
