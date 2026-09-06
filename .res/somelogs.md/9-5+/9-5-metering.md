

# 


Yes—these are the right areas to address before spending more time on the CLI. They expose some important gaps between “ACP data exists” and “an orchestration consumer can depend on it.”

## 1. Metering and context usage

We currently receive two different kinds of usage information, but we do not turn them into persistent `AgentSession` state.

### Turn token usage

Every completed prompt may return:

```ts
result.usage = {
  inputTokens,
  outputTokens,
  cacheReadTokens?,
  cacheWriteTokens?,
  thoughtTokens?,
}
```

This is per-turn accounting supplied by the harness.

### Context-window usage

A harness may emit an ACP `usage_update`, which becomes:

```ts
{
  kind: "usage",
  used: 120_000,
  size: 200_000,
  cost?: unknown,
}
```

This is the information needed for a context meter: 120k of a 200k window, for example.

Today, it is only available through:

```ts
onActivity(event)
onRecord(result)
```

It is not retained as:

```ts
session.contextUsage
session.totalUsage
session.estimatedCost
```

Once the turn finishes, `activitySnapshot()` is cleared. A consumer that did not capture the event has lost the context information.

That explains why the orchestration library currently cannot reliably tell you whether the agent is at 30k or 300k.

### What I think we should expose

We should separate three concepts:

```ts
interface SessionMetering {
  context: {
    usedTokens: number;
    sizeTokens: number;
    percentage: number;
  } | null;

  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    thoughtTokens: number;
  };

  providerCost: Money | null;
  estimatedCost: Money | null;
}
```

Then:

```ts
session.metering
session.subscribe(...)
```

A usage update should produce a session notification, rather than requiring every consumer to recognize and retain an activity event.

We should preserve immutable per-turn records and derive totals from them. A mutable number that is incremented blindly becomes difficult to recover after crashes, retries, handoffs, and reopen operations.

### Pricing

A fixed `pricePerToken` is useful as a minimum, but insufficient as the main abstraction because pricing can vary by:

- Input versus output.
- Cache reads versus cache writes.
- Thinking tokens.
- Model.
- Provider.
- Effective date.
- Subscription versus API billing.
- Model changes during one `AgentSession`.

I would use an injectable pricing resolver:

```ts
metering: {
  pricing: ({ adapterId, model, usage }) => ({
    currency: "USD",
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.25,
    cacheWritePerMillion: 1.25,
  }),
}
```

A simple fixed-pricing object can be shorthand for this.

We must also distinguish:

```ts
providerCost  // explicitly reported by the provider
estimatedCost // calculated by us
```

We should never present an estimate as actual billing.

And this should not depend on `/usage`. `/usage` is harness-specific prose delivered as a prompt response. Metering should use structured ACP usage information whenever the harness supplies it.

### Persistence

Metering should not depend on transcripts. A security-conscious consumer may disable all conversational persistence while still requiring billing information.

A better structure is an optional sink:

```ts
interface UsageSink {
  record(record: UsageRecord): Promise<void>;
}
```

The library can provide in-memory aggregation, while the agents library can persist records in its own database. We could later provide a file-backed implementation.

## 2. Transcript capture and security

I would call this “transcript capture policy,” rather than transcription level.

Current behavior is fragmented:

- No `transcriptPath` or `transcriptDir`: no logical transcript.
- A transcript path: full user and assistant messages are written.
- `transcriptActivity` defaults off.
- `transcriptActivity: true` adds tools, thinking, plans, usage, mode, and unknown events.
- `kinds` can exclude whole activity kinds.
- `rawOutput: false` excludes `rawOutput`, but tool output can still remain in `content`.
- `maxBytes` truncates information; it does not redact it.
- A wire log independently records every raw protocol line.

There are several less-obvious leaks:

- Tool `rawInput` can contain full commands and paths.
- Tool `content` can contain command output and file contents.
- Tool `locations` contain paths.
- `unknown` activity stores arbitrary raw provider payloads.
- Handoff boundaries store the generated summary.
- The catalog stores `cwd`.
- The catalog derives `title` from the first prompt.
- The catalog stores `transcriptPath`.
- Debug logging may receive full prompt requests.
- Wire capture contains essentially everything, including initialization and repeated streaming updates.

So this cannot be solved only by changing `transcriptActivity`.

### Suggested presets

I would avoid names like `normal`, because they do not say what is retained.

Possible presets:

```ts
"none"
"metadata"
"messages"
"operations"
"full"
```

Meaning approximately:

- `none`: store no conversation or operation content.
- `metadata`: timestamps, statuses, usage, IDs; no prompts, responses, commands, paths, or tool output.
- `messages`: user and assistant messages, no tool/thinking details.
- `operations`: messages plus tool names/statuses, but no tool input, output, or locations.
- `full`: messages, thinking, full tool input/output, paths, plans, and usage.

These should be presets over an explicit policy, not hardcoded indivisible modes:

```ts
transcript: {
  capture: {
    messages: true,
    usage: true,
    thinking: false,
    tools: {
      metadata: true,
      input: false,
      output: false,
      locations: false,
    },
    handoffSummary: false,
  },
}
```

### Live exposure and disk persistence are different

This is important for your agents library.

You may want the trusted orchestration backend to see a command, while preventing the browser or end user from seeing it. Or you may want the UI to show an operation live but never write it to disk.

Therefore we need two policies:

```ts
activity: {
  expose: ActivityPolicy;
  persist: ActivityPolicy;
}
```

“Expose” here means what goes through `onActivity`, `onRecord`, and potentially session notifications. “Persist” controls the transcript.

We should also consider a redaction hook:

```ts
redactActivity(event, destination)
redactMessage(message, destination)
```

But redaction is supplementary. Regex replacement cannot guarantee that arbitrary model/tool output is safe. Omitting sensitive fields is the strong guarantee.

### Raw protocol capture should remain separate

I would not make raw wire data another transcript level.

Wire capture has different properties:

- It is for diagnostics.
- It contains initialization and capability negotiation.
- It can contain secrets, prompts, file content, and command output.
- It may be extremely large due to repeated streaming updates.
- It should be explicitly dangerous and opt-in.

We could add a structured diagnostic mode that stores initialization and settled/coalesced protocol events, but `wire: raw` should remain genuinely raw.

## 3. Handoff

Handoff exists and has integration tests against a fake ACP harness.

Current flow:

```text
old provider thread
  → generate summary
  → session/new
  → update internalSessionId and catalog
  → introduce summary in new thread
```

The `AgentSession` object and `agentSessionId` remain unchanged.

It should work with different ACP-compatible harnesses, provided they can create a new session and answer prompts. But “other AI models” has two possible meanings.

### Another model produces the summary

This is possible today, externally:

```ts
const summary = await summarizer.prompt(...);
await session.handoff({ summary: summary.text });
```

So summary production is already bypassable.

What is not configurable is how the summary is introduced into the new thread.

### Move the logical session to another model/harness

This is not supported today.

The adapter and controller are fixed on an `AgentSession`. Cross-adapter handoff would require replacing the controller while preserving:

```ts
agentSessionId
listeners
queue
transcript
catalog association
metering totals
```

That is a real feature and probably valuable for your orchestration use case. I would call it migration or cross-adapter handoff.

A more complete API might eventually be:

```ts
session.handoff({
  target: {
    adapterId: "pi",
    adapter: ADAPTERS.pi,
  },
  summary: {
    prompt: "...",
    generate: async context => "...",
  },
  introduction: {
    buildPrompt: summary => "...",
  },
});
```

ACP does not provide a portable system-prompt field for `session/new`, so a true system-prompt introduction would require adapter-specific support or launch configuration. We should expose that limitation rather than pretend an ordinary first user prompt is equivalent.

## 4. “Switch” is too ambiguous

I would not make `switch()` a simple alias for `handoff()`, because there are at least four different operations:

| Intended action | Better name |
|---|---|
| Route UI/input to another logical `AgentSession` | `selectAgentSession` — consumer operation |
| Change model within the current harness | `setConfig("model", ...)` |
| Start a new thread while preserving logical identity | `handoff` |
| Move the logical identity to another adapter/harness | `migrate` or cross-adapter `handoff` |
| Point at an existing provider thread | `loadInternalSession` / `resumeInternalSession` |

A generic `switch()` would conceal which identity changes and whether context is transferred.

If the agents library wants a user-facing `/switch`, that is perfectly reasonable, but it should translate to an explicit underlying operation.

## 5. Tool output in the screenshot

The ACP library does expose tool output.

A tool commonly arrives in stages:

```text
tool announcement
  → input update
  → output/status update
```

The initial event often has no real input or output. Later `tool_update` events can contain:

```ts
event.rawOutput
event.content
event.locations
```

For terminal tools, the library also resolves the terminal ID and supplies:

```ts
{
  type: "terminal",
  output,
  truncated,
  exitStatus,
}
```

The end-to-end tests confirm that final command output reaches both `onActivity` and folded `onRecord` state.

The screenshot looks like the agents library is rendering the input checkpoint—the JSON containing `command`—but not subsequently applying or displaying the completed update. Likely causes are:

- It renders only the initial `tool` event.
- It ignores `tool_update`.
- It forwards `current` but misses `emitted`.
- It does not fold records by `recordId`.
- It receives `wireFrames()` but does not apply `foldFrame()`.
- The particular harness never supplied output.

The intended integration is:

```ts
session.prompt(text, {
  onRecord(result) {
    for (const frame of wireFrames(result)) {
      sendToBrowser(frame);
    }
  },
});
```

Then the browser applies each frame by `recordId`. A completed record should replace the earlier announcement/input record.

We should verify the agents-library path before concluding it is a UI problem, because some harnesses may omit output. A short raw-wire capture from this exact command would tell us whether:

1. The harness sent the output.
2. `acp-lib` normalized it.
3. The agents backend forwarded it.
4. The browser folded and rendered it.

## Suggested priority

Before the CLI, I would approach this in this order:

1. Define the metering record, context snapshot, aggregation, notifications, and pricing injection.
2. Define transcript/catalog/activity exposure policies as one security model.
3. Verify the tool-output path jointly with the agents library.
4. Make handoff summary generation and introduction configurable.
5. Design cross-adapter migration while preserving `agentSessionId`.
6. Make provider-thread operations safe at the `AgentSession` level.
7. Only then expose these decisions through CLI commands.

No repository changes were made here.


















# Usage / metering


Yes—these are the right areas to address before spending more time on the CLI. They expose some important gaps between “ACP data exists” and “an orchestration consumer can depend on it.”

## 1. Metering and context usage

We currently receive two different kinds of usage information, but we do not turn them into persistent `AgentSession` state.

### Turn token usage

Every completed prompt may return:

```ts
result.usage = {
  inputTokens,
  outputTokens,
  cacheReadTokens?,
  cacheWriteTokens?,
  thoughtTokens?,
}
```

This is per-turn accounting supplied by the harness.

### Context-window usage

A harness may emit an ACP `usage_update`, which becomes:

```ts
{
  kind: "usage",
  used: 120_000,
  size: 200_000,
  cost?: unknown,
}
```

This is the information needed for a context meter: 120k of a 200k window, for example.

Today, it is only available through:

```ts
onActivity(event)
onRecord(result)
```

It is not retained as:

```ts
session.contextUsage
session.totalUsage
session.estimatedCost
```

Once the turn finishes, `activitySnapshot()` is cleared. A consumer that did not capture the event has lost the context information.

That explains why the orchestration library currently cannot reliably tell you whether the agent is at 30k or 300k.

### What I think we should expose

We should separate three concepts:

```ts
interface SessionMetering {
  context: {
    usedTokens: number;
    sizeTokens: number;
    percentage: number;
  } | null;

  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    thoughtTokens: number;
  };

  providerCost: Money | null;
  estimatedCost: Money | null;
}
```

Then:

```ts
session.metering
session.subscribe(...)
```

A usage update should produce a session notification, rather than requiring every consumer to recognize and retain an activity event.

We should preserve immutable per-turn records and derive totals from them. A mutable number that is incremented blindly becomes difficult to recover after crashes, retries, handoffs, and reopen operations.

### Pricing

A fixed `pricePerToken` is useful as a minimum, but insufficient as the main abstraction because pricing can vary by:

- Input versus output.
- Cache reads versus cache writes.
- Thinking tokens.
- Model.
- Provider.
- Effective date.
- Subscription versus API billing.
- Model changes during one `AgentSession`.

I would use an injectable pricing resolver:

```ts
metering: {
  pricing: ({ adapterId, model, usage }) => ({
    currency: "USD",
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.25,
    cacheWritePerMillion: 1.25,
  }),
}
```

A simple fixed-pricing object can be shorthand for this.

We must also distinguish:

```ts
providerCost  // explicitly reported by the provider
estimatedCost // calculated by us
```

We should never present an estimate as actual billing.

And this should not depend on `/usage`. `/usage` is harness-specific prose delivered as a prompt response. Metering should use structured ACP usage information whenever the harness supplies it.

### Persistence

Metering should not depend on transcripts. A security-conscious consumer may disable all conversational persistence while still requiring billing information.

A better structure is an optional sink:

```ts
interface UsageSink {
  record(record: UsageRecord): Promise<void>;
}
```

The library can provide in-memory aggregation, while the agents library can persist records in its own database. We could later provide a file-backed implementation.

## 2. Transcript capture and security

I would call this “transcript capture policy,” rather than transcription level.

Current behavior is fragmented:

- No `transcriptPath` or `transcriptDir`: no logical transcript.
- A transcript path: full user and assistant messages are written.
- `transcriptActivity` defaults off.
- `transcriptActivity: true` adds tools, thinking, plans, usage, mode, and unknown events.
- `kinds` can exclude whole activity kinds.
- `rawOutput: false` excludes `rawOutput`, but tool output can still remain in `content`.
- `maxBytes` truncates information; it does not redact it.
- A wire log independently records every raw protocol line.

There are several less-obvious leaks:

- Tool `rawInput` can contain full commands and paths.
- Tool `content` can contain command output and file contents.
- Tool `locations` contain paths.
- `unknown` activity stores arbitrary raw provider payloads.
- Handoff boundaries store the generated summary.
- The catalog stores `cwd`.
- The catalog derives `title` from the first prompt.
- The catalog stores `transcriptPath`.
- Debug logging may receive full prompt requests.
- Wire capture contains essentially everything, including initialization and repeated streaming updates.

So this cannot be solved only by changing `transcriptActivity`.

### Suggested presets

I would avoid names like `normal`, because they do not say what is retained.

Possible presets:

```ts
"none"
"metadata"
"messages"
"operations"
"full"
```

Meaning approximately:

- `none`: store no conversation or operation content.
- `metadata`: timestamps, statuses, usage, IDs; no prompts, responses, commands, paths, or tool output.
- `messages`: user and assistant messages, no tool/thinking details.
- `operations`: messages plus tool names/statuses, but no tool input, output, or locations.
- `full`: messages, thinking, full tool input/output, paths, plans, and usage.

These should be presets over an explicit policy, not hardcoded indivisible modes:

```ts
transcript: {
  capture: {
    messages: true,
    usage: true,
    thinking: false,
    tools: {
      metadata: true,
      input: false,
      output: false,
      locations: false,
    },
    handoffSummary: false,
  },
}
```

### Live exposure and disk persistence are different

This is important for your agents library.

You may want the trusted orchestration backend to see a command, while preventing the browser or end user from seeing it. Or you may want the UI to show an operation live but never write it to disk.

Therefore we need two policies:

```ts
activity: {
  expose: ActivityPolicy;
  persist: ActivityPolicy;
}
```

“Expose” here means what goes through `onActivity`, `onRecord`, and potentially session notifications. “Persist” controls the transcript.

We should also consider a redaction hook:

```ts
redactActivity(event, destination)
redactMessage(message, destination)
```

But redaction is supplementary. Regex replacement cannot guarantee that arbitrary model/tool output is safe. Omitting sensitive fields is the strong guarantee.

### Raw protocol capture should remain separate

I would not make raw wire data another transcript level.

Wire capture has different properties:

- It is for diagnostics.
- It contains initialization and capability negotiation.
- It can contain secrets, prompts, file content, and command output.
- It may be extremely large due to repeated streaming updates.
- It should be explicitly dangerous and opt-in.

We could add a structured diagnostic mode that stores initialization and settled/coalesced protocol events, but `wire: raw` should remain genuinely raw.

## 3. Handoff

Handoff exists and has integration tests against a fake ACP harness.

Current flow:

```text
old provider thread
  → generate summary
  → session/new
  → update internalSessionId and catalog
  → introduce summary in new thread
```

The `AgentSession` object and `agentSessionId` remain unchanged.

It should work with different ACP-compatible harnesses, provided they can create a new session and answer prompts. But “other AI models” has two possible meanings.

### Another model produces the summary

This is possible today, externally:

```ts
const summary = await summarizer.prompt(...);
await session.handoff({ summary: summary.text });
```

So summary production is already bypassable.

What is not configurable is how the summary is introduced into the new thread.

### Move the logical session to another model/harness

This is not supported today.

The adapter and controller are fixed on an `AgentSession`. Cross-adapter handoff would require replacing the controller while preserving:

```ts
agentSessionId
listeners
queue
transcript
catalog association
metering totals
```

That is a real feature and probably valuable for your orchestration use case. I would call it migration or cross-adapter handoff.

A more complete API might eventually be:

```ts
session.handoff({
  target: {
    adapterId: "pi",
    adapter: ADAPTERS.pi,
  },
  summary: {
    prompt: "...",
    generate: async context => "...",
  },
  introduction: {
    buildPrompt: summary => "...",
  },
});
```

ACP does not provide a portable system-prompt field for `session/new`, so a true system-prompt introduction would require adapter-specific support or launch configuration. We should expose that limitation rather than pretend an ordinary first user prompt is equivalent.

## 4. “Switch” is too ambiguous

I would not make `switch()` a simple alias for `handoff()`, because there are at least four different operations:

| Intended action | Better name |
|---|---|
| Route UI/input to another logical `AgentSession` | `selectAgentSession` — consumer operation |
| Change model within the current harness | `setConfig("model", ...)` |
| Start a new thread while preserving logical identity | `handoff` |
| Move the logical identity to another adapter/harness | `migrate` or cross-adapter `handoff` |
| Point at an existing provider thread | `loadInternalSession` / `resumeInternalSession` |

A generic `switch()` would conceal which identity changes and whether context is transferred.

If the agents library wants a user-facing `/switch`, that is perfectly reasonable, but it should translate to an explicit underlying operation.

## 5. Tool output in the screenshot

The ACP library does expose tool output.

A tool commonly arrives in stages:

```text
tool announcement
  → input update
  → output/status update
```

The initial event often has no real input or output. Later `tool_update` events can contain:

```ts
event.rawOutput
event.content
event.locations
```

For terminal tools, the library also resolves the terminal ID and supplies:

```ts
{
  type: "terminal",
  output,
  truncated,
  exitStatus,
}
```

The end-to-end tests confirm that final command output reaches both `onActivity` and folded `onRecord` state.

The screenshot looks like the agents library is rendering the input checkpoint—the JSON containing `command`—but not subsequently applying or displaying the completed update. Likely causes are:

- It renders only the initial `tool` event.
- It ignores `tool_update`.
- It forwards `current` but misses `emitted`.
- It does not fold records by `recordId`.
- It receives `wireFrames()` but does not apply `foldFrame()`.
- The particular harness never supplied output.

The intended integration is:

```ts
session.prompt(text, {
  onRecord(result) {
    for (const frame of wireFrames(result)) {
      sendToBrowser(frame);
    }
  },
});
```

Then the browser applies each frame by `recordId`. A completed record should replace the earlier announcement/input record.

We should verify the agents-library path before concluding it is a UI problem, because some harnesses may omit output. A short raw-wire capture from this exact command would tell us whether:

1. The harness sent the output.
2. `acp-lib` normalized it.
3. The agents backend forwarded it.
4. The browser folded and rendered it.

## Suggested priority

Before the CLI, I would approach this in this order:

1. Define the metering record, context snapshot, aggregation, notifications, and pricing injection.
2. Define transcript/catalog/activity exposure policies as one security model.
3. Verify the tool-output path jointly with the agents library.
4. Make handoff summary generation and introduction configurable.
5. Design cross-adapter migration while preserving `agentSessionId`.
6. Make provider-thread operations safe at the `AgentSession` level.
7. Only then expose these decisions through CLI commands.

No repository changes were made here.











--

You’re right—I flattened your pricing proposal too much. You proposed separate prices for each token category, captured at the moment of the operation. That historical “engraving” is exactly what we need.

A global pricing configuration may determine today’s price, but it must not be the historical record.

## The operation usage record

After every potentially token-consuming operation, the library should produce something like:

```ts
interface OperationUsageRecord {
  operationId: string;
  operationKind:
    | "prompt"
    | "internal_command"
    | "handoff_summary"
    | "handoff_seed";

  agentSessionId: string;
  internalSessionId: string;
  adapterId: string;
  model?: string;

  startedAt: number;
  completedAt: number;

  usage: {
    reportedCumulative?: TokenUsage;
    attributableDelta?: TokenUsage;
    attribution: "exact" | "derived" | "unknown";
  };

  pricing?: AppliedPricing;
  estimatedCharge?: Money;
  providerReportedCost?: ProviderCostObservation;
}
```

The pricing record should contain line items:

```ts
interface AppliedPricing {
  source: "consumer";
  currency: string;
  capturedAt: number;
  version?: string;

  lineItems: Array<{
    kind:
      | "input"
      | "output"
      | "cached_read"
      | "cached_write"
      | "thought";

    tokens: number;

    unitPrice: {
      amount: string;
      perTokens: number; // normally 1_000_000
    };

    subtotal: string;
  }>;

  total: string;
}
```

For example:

```ts
{
  kind: "input",
  tokens: 30_000,
  unitPrice: {
    amount: "1.25",
    perTokens: 1_000_000,
  },
  subtotal: "0.0375",
}
```

Tomorrow’s operation might contain:

```ts
unitPrice: {
  amount: "1.50",
  perTokens: 1_000_000,
}
```

Nothing about the old record changes.

This records:

- The token count used for the calculation.
- The exact price applied.
- The resulting subtotal.
- The currency.
- When the price was captured.
- Optionally, the pricing-table version.

The consumer can later reproduce why an operation was displayed as `$0.48`.

## Configuration versus historical record

We still need a source for current prices:

```ts
pricing: ({ adapterId, model, at }) => currentPricing
```

But that resolver is only consulted when the operation finishes. Its result is copied into the operation record.

So:

```text
pricing resolver = how we find the current price
operation record = immutable historical evidence of the applied price
```

Changing the resolver tomorrow affects new records only.

## This is a usage record, not necessarily an inference record

We should avoid promising “one row per inference.”

A single ACP prompt might cause the harness to:

- Call the model multiple times.
- Retry.
- Perform automatic compaction.
- Invoke a cheaper model internally.
- Use another model for summarization.

ACP generally gives us a turn/session usage result, not visibility into every underlying provider inference.

Therefore the dashboard record means:

> One operation observed by `acp-lib`.

If a harness provides individual inference metadata in the future, those could become child records.

## Returning it to the consumer

Yes: the most important API is returning the record, not having the library own a global usage database.

For a normal prompt:

```ts
const result = await session.prompt("Do something");

result.usageRecord;
```

Potentially:

```ts
interface PromptResult {
  // Existing fields
  text: string;
  messages: readonly ResponseMessage[];
  usage: TokenUsage | null;

  // New normalized record
  usageRecord: OperationUsageRecord;
}
```

Even when the harness reports no tokens, we should probably return a record:

```ts
{
  operationId: "...",
  usage: {
    attribution: "unknown"
  }
}
```

That lets a consumer’s dashboard show that an operation occurred but its cost was unavailable. Silently omitting it would make usage coverage look better than it is.

Harness commands already return `PromptResult`, so this works automatically:

```ts
await session.executeInternalSessionCommand("usage");
```

For handoff, there may be multiple token-consuming operations:

```ts
interface HandoffResult {
  // Existing fields
  usageRecords: readonly OperationUsageRecord[];
}
```

Usually:

```text
handoff_summary
handoff_seed
```

If the caller supplies a summary, only the seed operation is performed by this session.

## Events as well as return values

The same record should be emitted:

```ts
{
  kind: "usage_recorded",
  record: OperationUsageRecord
}
```

That serves consumers which monitor many agents reactively:

```ts
session.subscribe(notification => {
  if (notification.event.kind === "usage_recorded") {
    billingDb.insert(notification.event.record);
  }
});
```

The return value is convenient for direct callers; the listener is convenient for orchestration systems. They contain the same immutable record.

## Does this belong inside `AgentSession`?

Yes, record production belongs inside `AgentSession`.

`AgentSession` knows:

- The stable `agentSessionId`.
- The active `internalSessionId`.
- Which adapter is active.
- What kind of operation is running.
- Whether the operation is a user prompt or an internal handoff step.
- The previous cumulative provider counters.
- The pricing resolver applicable at that moment.

Therefore it should:

1. Normalize the ACP usage.
2. Calculate a delta when possible.
3. Apply the current pricing.
4. Create the immutable operation record.
5. Update `session.usage`.
6. Return and emit the record.

What does not necessarily belong inside it is the consumer’s global table:

```text
all users × all AgentSessions × all operations
```

That remains consumer/orchestrator storage.

## Why I mentioned a sink

The sink was intended only as optional durability, not as a manager for multiple sessions.

There are three approaches:

### Return and emit only

```ts
const result = await session.prompt(...);
await db.insert(result.usageRecord);
```

Advantages:

- Simple.
- Consumer controls storage.
- Fits the current library boundary.
- No transcript dependency.

Disadvantage:

- If the process dies after the provider charges the operation but before the consumer stores the result, the record may be lost.

### Optional callback/recorder

```ts
AgentSession.create({
  onUsageRecord: record => db.insert(record),
});
```

This still leaves storage with the consumer, but centralizes delivery.

The name `onUsageRecord` may fit better than `UsageSink`.

### Store owned by the session

```ts
AgentSession.create({
  usageStore,
});
```

This could support automatic restoration of cumulative baselines after reopening, but it adds another persistence abstraction.

I would begin with:

```ts
result.usageRecord
session.subscribe(...)
session.usage
```

Then decide whether automatic durable recording is necessary. We do not need to introduce `UsageSink` immediately.

## Persistence across reopening

There is one piece that cannot be completely ignored: cumulative baselines.

Suppose we saw:

```text
internal session A: cumulative input = 100k
```

The process restarts, we load A, and the next result reports:

```text
internal session A: cumulative input = 120k
```

To calculate the correct 20k delta, the reopened `AgentSession` needs to know that the last observation was 100k.

Possible solutions:

1. The consumer passes a metering checkpoint when reopening.
2. `SessionManager` stores the last cumulative checkpoint.
3. A dedicated usage store restores it.
4. We mark the first post-reopen sample as unattributed and only calculate later deltas.

I lean toward storing a small checkpoint through the session catalog while leaving detailed operation records to the consumer:

```ts
interface MeteringCheckpoint {
  internalSessionId: string;
  lastReportedUsage: TokenUsage;
  lastProviderCost?: Money;
}
```

That is not the consumer’s complete billing database. It is just enough state for `AgentSession` to continue calculating deltas correctly.

## Transcript integrity

A hash can be useful, but we need to distinguish accidental corruption from adversarial tampering.

### Plain hash

A SHA-256 hash can detect accidental corruption if the expected hash is stored somewhere else:

```ts
const result = await verifyTranscript(path, expectedHash);
```

If the hash is stored inside the same editable transcript, someone can edit the data and recalculate the hash.

### Hash chain

Each record can include the previous record’s hash:

```ts
{
  seq: 42,
  previousHash: "...",
  payload: { ... },
  hash: "..."
}
```

This detects:

- Changed records.
- Reordering.
- Missing records in the middle.
- Accidental corruption.

But an attacker controlling the whole file can recalculate the entire chain. They can also truncate the end unless the expected final hash is anchored elsewhere.

### HMAC or digital signature

For tamper evidence, the consumer needs a secret or private key stored separately:

```ts
createTranscriptHmac(...)
verifyTranscriptHmac(...)
```

An HMAC chain prevents someone without the secret from rewriting valid records. To detect truncation, the consumer must also store the expected final sequence/hash somewhere trusted.

Therefore I would expose general utilities:

```ts
hashTranscript(path)
verifyTranscript(path, expectedDigest)

createHashChain(...)
verifyHashChain(...)

createHmacChain(key)
verifyHmacChain(key, ...)
```

But I would not present an embedded unkeyed hash as secure billing protection.

It provides corruption detection. Real billing integrity requires an external trust anchor.

Also, hashing does not hide transcript content. Encryption and transcript redaction are separate concerns.

## Transcript versus accounting record

I would treat the transcript and accounting records as two projections of the same operation:

```text
AgentSession operation
├── conversational projection → transcript
└── metering projection        → OperationUsageRecord
```

The transcript may be disabled, redacted, edited, or deleted. The metering record still exists and is returned to the consumer.

A consumer can store it as:

```text
timestamp    agent     provider    model      operation       tokens    cost
14:31:02     agent-7   claude      opus       prompt          42,100    $0.48
14:34:17     agent-7   claude      opus       handoff-summary 18,400    $0.21
14:35:09     agent-7   codex       gpt-x      handoff-seed     8,700    $0.07
14:40:52     agent-7   codex       gpt-x      prompt          91,300    $2.02
```

That table is the consumer’s responsibility. Producing complete, immutable, properly attributed rows is ours.









## Secret-based transcript integrity

Yes, allowing the consumer to provide a secret is reasonable. That gives us an HMAC rather than a plain hash:

```ts
const session = await AgentSession.create({
  // ...
  transcriptIntegrity: {
    key: process.env.TRANSCRIPT_INTEGRITY_KEY!,
  },
});
```

The library must never write the secret itself. Each transcript entry could carry:

```ts
{
  "seq": 42,
  "previousMac": "...",
  "payload": {
    "v": 1,
    "t": "msg",
    "role": "assistant",
    "text": "..."
  },
  "mac": "..."
}
```

Conceptually:

```text
mac = HMAC(secret, seq + previousMac + serializedPayload)
```

That detects:

- Modified entries.
- Inserted entries.
- Reordered entries.
- Missing entries in the middle.
- Accidental file corruption.

The library can then provide:

```ts
const result = await verifyTranscript(path, {
  key: integrityKey,
});

result.valid;
result.lastValidSequence;
result.firstInvalidSequence;
result.reason;
```

### Where the final hash goes

The chain alone cannot detect deletion from the end:

```text
1 → 2 → 3 → 4 → 5
```

If someone truncates it to:

```text
1 → 2 → 3
```

that is still a valid chain prefix.

For practical integrity checking, the library could automatically maintain an authenticated sidecar:

```text
conversation.jsonl
conversation.jsonl.integrity
```

Containing:

```ts
{
  agentSessionId: "...",
  sequence: 5,
  headMac: "...",
  mac: "HMAC over this checkpoint"
}
```

This imposes no database work on the consumer. The verifier compares the transcript’s last entry against the sidecar checkpoint.

This would detect ordinary transcript truncation unless someone has retained and restores an old matching transcript and sidecar together.

Preventing that rollback requires an external trusted location: database, remote service, OS keychain-backed counter, or similar. I do not think `acp-lib` needs to solve that. We can document the guarantee as:

> Detects corruption and modification without the secret; it is not rollback-proof when an attacker controls all local files.

### Is a hardcoded secret useful?

It depends on where the consumer runs.

If the consumer is a server and the end user only accesses it through the application:

- Yes, an environment/configuration secret is meaningful.
- The user can edit a transcript but cannot produce valid HMACs.

If the consumer is an open-source local application running on the user’s machine:

- A hardcoded secret can eventually be extracted.
- It protects against accidental corruption and casual editing.
- It does not protect against a determined machine owner.

That is still potentially useful, as long as we do not call it cryptographically secure against the local owner.

I would accept either:

```ts
transcriptIntegrity: {
  key: Uint8Array;
  keyId?: string;
}
```

or, for consumers using KMS/keychains:

```ts
transcriptIntegrity: {
  keyId: string;
  sign(data): Promise<Uint8Array>;
}
```

The first is the convenient implementation. The second can come later.

This authenticates the transcript; it does not encrypt it.

## What “persistence across reopening” means

This is unrelated to storing the operation’s historical price. It concerns calculating token deltas from ACP’s cumulative counters.

Imagine one live `AgentSession`:

```text
Provider cumulative usage after msg 1:  50k
Provider cumulative usage after msg 2: 100k
```

While the object remains alive, it remembers the previous report:

```text
msg 1 delta: 50k - 0k   = 50k
msg 2 delta: 100k - 50k = 50k
```

Then the application stops:

```ts
await session.stop();
```

Later, perhaps tomorrow, the consumer reopens the same logical session:

```ts
const session = await AgentSession.create({
  agentSessionId: "stable-123",
  providerSession: {
    kind: "load",
    internalSessionId: "claude-thread-456",
  },
});
```

This is a new JavaScript object. Its in-memory knowledge that Claude previously reported 100k has disappeared.

After the next prompt, Claude reports:

```text
Provider cumulative usage: 130k
```

Without restoring the previous 100k checkpoint, the new object cannot know whether this operation consumed:

```text
130k  // if the session started from zero
30k   // if the previous known value was 100k
?     // if some activity happened outside our application
```

If we charge all 130k again, we double-count historical usage. If we ignore the first report, we lose the new 30k.

That is the reopening problem.

### What needs to persist

We do not need to load the complete usage table into `AgentSession`. It only needs the latest cumulative observation per active internal session:

```ts
interface UsageCheckpoint {
  internalSessionId: string;

  reportedUsage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
  };

  providerCost?: {
    amount: string;
    currency: string;
  };

  observedAt: number;
}
```

Then, after reopening:

```text
restored checkpoint: 100k
new provider report: 130k
new attributable usage: 30k
```

The immutable operation record returned to the consumer would contain:

```ts
{
  usage: {
    reportedCumulative: { totalTokens: 130_000 },
    attributableDelta: { totalTokens: 30_000 },
    attribution: "derived",
  },
}
```

### Where to keep the checkpoint

There are three reasonable choices.

1. Extend the `SessionManager` record.

```ts
SessionRecord {
  // existing routing metadata
  meteringCheckpoint?: UsageCheckpoint;
}
```

`AgentSession` would restore and update it automatically whenever a `SessionManager` is attached.

2. Put the checkpoint in the transcript.

This fails when transcripts are disabled and couples accounting with conversation retention.

3. Make the consumer pass it back explicitly.

```ts
AgentSession.create({
  meteringCheckpoint: previousCheckpoint,
});
```

This is flexible but puts more reconstruction work on every consumer.

I think the first option is the most coherent. `SessionManager` would not become the complete usage database; it would only retain enough operational state to reopen the session correctly.

The division would be:

```text
SessionManager
└── latest metering checkpoint
    needed to continue calculating deltas

Consumer database
└── immutable OperationUsageRecord rows
    used for history, analytics, and billing
```

If no `SessionManager` or checkpoint is provided, the library remains usable but must be honest:

```ts
attribution: "unknown"
attributableDelta: null
reportedCumulative: { totalTokens: 130_000 }
```

After that first unknown sample, it has a new in-memory baseline and can calculate subsequent deltas normally.

So “persistence across reopening” only means remembering the last cumulative provider counters. It does not mean that `acp-lib` should own the consumer’s complete billing table.





I agree with the concern. After reconsidering it, I would not put the authoritative metering checkpoint inside `SessionManager`.

`AgentSession` is stateful while running, but persistence has remained optional and consumer-owned. Making its catalog secretly responsible for correct monetary accounting would change that boundary considerably.

## The better boundary

`AgentSession` should:

- Observe the provider’s usage.
- Remember counters while the live object exists.
- Calculate operation deltas.
- Apply the pricing valid at that moment.
- Return an immutable usage record.
- Include the new checkpoint in that record.

The consumer should:

- Store the operation record.
- Recover the latest checkpoint when reopening the session.
- Pass that checkpoint back to `AgentSession`.

For example:

```ts
const previous = await usageRepository.latestCheckpoint(agentSessionId);

const session = await AgentSession.create({
  // ...
  metering: {
    checkpoint: previous,
    pricing: resolveCurrentPricing,
  },
});
```

Then:

```ts
const result = await session.prompt("Do something");

await usageRepository.record(result.usageRecord);
```

The returned record contains everything needed for the next reopening:

```ts
interface OperationUsageRecord {
  operationId: string;
  agentSessionId: string;
  internalSessionId: string;

  usage: {
    reportedCumulative: TokenUsage;
    attributableDelta: TokenUsage;
  };

  appliedPricing: AppliedPricing;
  estimatedCharge: Money;

  checkpoint: MeteringCheckpoint;
}
```

The checkpoint could simply be extracted from the most recent record. It may not need its own database table.

This preserves the boundary:

```text
acp-lib
└── produces normalized, priced operation records

consumer
└── stores and queries those records
```

## Why a checkpoint is necessary

Assume a provider returns cumulative counters.

During the first application run:

```text
after msg 1: provider reports 50k
after msg 2: provider reports 100k
```

The second operation costs 50k attributable tokens:

```text
100k - 50k = 50k
```

The consumer stores that operation record, including the last reported value of 100k.

Tomorrow it reconstructs the session and passes the last checkpoint:

```ts
metering: {
  checkpoint: {
    internalSessionId: "claude-thread-1",
    reportedUsage: {
      totalTokens: 100_000,
      // ...
    },
  },
}
```

The next provider report is 130k:

```text
130k - restored 100k = 30k
```

The checkpoint is not a separate history managed by the library. It is just the relevant portion of the previous usage record being fed back into a new live `AgentSession`.

## What if the consumer does not provide it?

For a newly created internal session, zero is a legitimate baseline:

```text
new internal session
previous cumulative usage = 0
```

For a loaded or resumed internal session, zero is not legitimate unless the consumer explicitly certifies it.

You are right that monetary accounting cannot silently fall back to an unreliable answer. But reporting zero would be worse: zero means “we know nothing was consumed,” not “we could not calculate it.”

The API needs an explicit policy.

```ts
metering: {
  mode: "strict",
  checkpoint,
  pricing,
}
```

In strict mode:

- A new provider session starts from a trusted zero baseline.
- A loaded/resumed provider session requires a compatible checkpoint.
- A missing checkpoint prevents metered use.
- Missing required usage data is surfaced as a metering failure.
- Prices must resolve before we can claim an estimated charge.
- We never return a fabricated zero charge.

In best-effort mode:

```ts
metering: {
  mode: "best_effort",
  pricing,
}
```

the session remains usable with incomplete telemetry.

For a product that charges end users, the orchestrator should use strict mode or its own provider billing integration.

## A limitation of strict mode

Even strict mode cannot force an ACP harness to report usage. ACP usage is optional and currently unstable.

If a harness accepts a prompt, incurs provider cost, and then returns no usage, the library discovers that only after the operation. It cannot undo the expense.

Therefore there are two different guarantees:

### Operational metering

```text
Use ACP-reported usage when available.
Calculate and return immutable estimates.
```

This is appropriate for dashboards and observability.

### Financial billing

```text
Reconcile against a provider billing API or a harness with guaranteed accounting.
```

This is required if the consumer is actually charging money.

The library can make missing information loud, but it cannot manufacture authoritative billing information that the harness did not provide.

For subscription harnesses, this limitation is stronger. A `/usage` percentage is quota status, not an exact monetary charge. The operation might reasonably have:

```ts
estimatedApiEquivalent: {
  amount: "0.48",
  currency: "USD",
}

actualCharge: null,

subscriptionQuota: {
  remainingRatio: 0.42,
}
```

We should not call `$0.48` “spent” if the user pays a fixed subscription.

## Pricing remains engraved per operation

The passed pricing resolver is not the stored historical truth:

```ts
pricing: resolveCurrentPricing
```

It only answers:

> What pricing applies to this operation right now?

The library copies the returned pricing into the operation record:

```ts
{
  lineItems: [
    {
      kind: "input",
      tokens: 30_000,
      unitPrice: {
        amount: "1.25",
        perTokens: 1_000_000,
      },
      subtotal: "0.0375",
    },
    {
      kind: "output",
      tokens: 8_000,
      unitPrice: {
        amount: "10.00",
        perTokens: 1_000_000,
      },
      subtotal: "0.08",
    },
  ],
  total: "0.1175",
  currency: "USD",
}
```

Tomorrow the resolver returns 1.50 for input, and only tomorrow’s record contains 1.50.

## Crash behavior

There is another unavoidable boundary.

If the provider completes an operation and charges for it, but the consumer process crashes before storing `result.usageRecord`, a return-value-only API loses that record.

We can help by emitting:

```ts
{ kind: "operation_started", operationId }
{ kind: "usage_recorded", record }
```

The consumer can store a pending operation at start and complete it when the usage record arrives.

For truly billing-grade guarantees, the consumer still needs reconciliation with the provider. A local subprocess protocol cannot provide exactly-once financial transactions on its own.

An optional `onUsageRecord` callback could be offered for convenience, but it should not quietly turn the library into the accounting database.

## Revised responsibility model

```text
AgentSession
├── current context-window snapshot
├── in-memory cumulative baseline
├── usage normalization
├── operation delta calculation
├── current-price resolution
├── immutable applied-price record
└── return + emit OperationUsageRecord

Consumer
├── usage-record table
├── historical dashboard
├── per-user aggregation
├── budget/quota policy
├── latest-checkpoint recovery
└── provider billing reconciliation
```

Transcript HMAC remains useful for conversation integrity, but the transcript should not be the authoritative accounting source. The operation records stored by the consumer are the appropriate basis for the usage dashboard.






















# Shape


Yes, conceptually every prompt result would carry a small metering record alongside the response.

I would avoid naming it `billingMetadata`, though, because that implies an authoritative financial charge. With subscriptions or estimated API-equivalent pricing, it may not represent money actually billed.

I prefer:

```ts
result.metering
```

or:

```ts
result.usageRecord
```

## Proposed result shape

Something approximately like:

```ts
interface PromptResult {
  operationId: string;

  text: string;
  messages: readonly ResponseMessage[];
  stopReason: string;
  status: "completed" | "cancelled" | "error";

  metering: OperationMetering;
}
```

Where:

```ts
interface OperationMetering {
  status:
    | "metered"
    | "usage_unavailable"
    | "baseline_required"
    | "pricing_unavailable";

  operation: {
    kind: "prompt" | "internal_command";
    startedAt: number;
    completedAt: number;
  };

  session: {
    agentSessionId: string;
    internalSessionId: string;
  };

  provider: {
    adapterId: string;
    model?: string;
    harnessName?: string;
    harnessVersion?: string;
  };

  usage?: {
    reportedCumulative: TokenUsage;
    attributableDelta: TokenUsage;
  };

  pricing?: AppliedPricing;

  costs?: {
    estimated?: Money;
    providerReported?: Money;
  };

  contextAfter?: ContextWindowStatus;

  checkpoint?: MeteringCheckpoint;
}
```

The consumer receives:

```ts
const result = await session.prompt(prompt);

await database.operations.insert({
  operationId: result.operationId,
  agentSessionId: session.agentSessionId,
  prompt,
  response: result.messages,
  status: result.status,
  metering: result.metering,
});
```

That naturally produces the dashboard table:

```text
operation   conversation   provider   model   input   output   estimated
op-1        agent-7        claude     opus    30k     4k       $0.48
op-2        agent-7        codex      gpt-x   90k     12k      $2.02
```

## Should metering contain the prompt and response?

I would not put them inside `OperationMetering`.

They are related, but they serve different concerns:

```text
PromptResult
├── operation identity
├── response content
└── metering
```

The consumer already has the prompt because it supplied it. It can store the prompt, response, and metering together if desired.

Embedding prompt and response inside the metering object would:

- Duplicate potentially sensitive content.
- Make it impossible to retain accounting while deleting conversation text.
- Make usage records unnecessarily large.
- Couple billing retention to transcript retention.
- Complicate redaction policies.

The stable link should be `operationId`:

```ts
conversationMessage.operationId === usageRecord.operationId
```

A consumer can keep:

```text
operations table
messages table
usage records table
```

or store everything in one document. The library does not impose the database layout.

## Per-conversation provider metadata

Yes, each operation record should snapshot provider/model metadata.

It cannot only live on the current `AgentSession`, because this can happen:

```text
operation 1 → Claude Opus
operation 2 → Claude Opus
handoff
operation 3 → Codex model A
model change
operation 4 → Codex model B
```

Looking only at the current session would incorrectly make every historical operation appear to have used model B.

So every record engraves:

```ts
{
  adapterId: "claude",
  model: "opus-4.6",
  internalSessionId: "claude-thread-123",
}
```

along with the exact applied pricing.

The stable `agentSessionId` groups these records into one logical conversation.

## Performance

The metering object itself is not a meaningful performance concern.

A normal record would contain:

- A few IDs and timestamps.
- Around five token counters.
- Around five pricing line items.
- One context snapshot.
- Short provider/model strings.

That is likely hundreds of bytes or perhaps one or two kilobytes. A response, tool output, image, or transcript entry will normally be much larger.

For comparison, the library already exposes:

```ts
result.text
result.messages
```

These currently contain two representations of the assistant response:

- `text`: flattened compatibility projection.
- `messages`: boundary-aware representation.

That existing duplication is much larger than the proposed metering metadata.

## The actual performance trap

The problem would be keeping every operation record forever inside the live `AgentSession`:

```ts
session.usage.records.push(record);
```

A session used for months could grow without bounds.

The live session should retain only bounded aggregate state:

```ts
session.metering = {
  totals,
  latestCheckpoint,
  contextWindow,
  lastOperation,
};
```

For every completed operation it should:

1. Return the immutable operation record.
2. Emit it to subscribers.
3. Update cumulative totals and the latest checkpoint.
4. Not retain the complete historical list.

The consumer stores the unbounded list.

That gives us bounded library memory:

```text
AgentSession memory: O(1)
Consumer history:    O(number of operations)
```

## Handoff shape

A handoff can consume tokens more than once, so its result would contain multiple operation records:

```ts
interface HandoffResult {
  // Existing handoff information
  operations: readonly OperationMetering[];
}
```

For example:

```ts
[
  {
    operation: { kind: "handoff_summary" },
    provider: { adapterId: "claude", model: "opus-4.6" },
    // usage and pricing
  },
  {
    operation: { kind: "handoff_seed" },
    provider: { adapterId: "codex", model: "gpt-x" },
    // usage and pricing
  },
]
```

An internal harness command is simpler because it already returns `PromptResult`:

```ts
const result =
  await session.executeInternalSessionCommand("usage");

result.metering;
```

## Naming recommendation

I would settle on:

```ts
PromptResult.metering
```

with type:

```ts
OperationMetering
```

Then use precise nested names:

```ts
metering.usage
metering.pricing
metering.costs.estimated
metering.costs.providerReported
metering.contextAfter
```

That avoids presenting estimates as bills while still giving a billing consumer everything necessary to construct its own immutable usage ledger.






---


































We have enough to write a design spec, but a few decisions must be made before it becomes implementation-ready.

The conceptual model is settled:

```text
AgentSession
├── contextWindow          current internal-session context
├── metering               bounded logical-session totals/state
└── operations
    └── immutable metering record returned and emitted

Consumer
├── stores operation records
├── builds dashboards
└── passes restored metering state when reopening
```

The remaining decisions are these.

## 1. Public naming

My recommendation:

```ts
PromptResult.metering: OperationMeteringRecord
AgentSession.metering: AgentSessionMetering
AgentSession.contextWindow: ContextWindowStatus | null
```

Not `billingMetadata`, because estimated API-equivalent cost and subscription usage are not necessarily actual billing.

## 2. Fixing the existing `Usage` contract

Currently our type is wrong:

- It describes usage as per-turn.
- ACP fields are cumulative across the internal session.
- We omit `totalTokens`.
- We use `cacheReadTokens`, while ACP uses `cachedReadTokens`.

I recommend introducing the correct normalized type:

```ts
interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}
```

Because the package is still pre-1.0, I would correct the existing API rather than preserve misleading aliases indefinitely. The spec should mark this as a compatibility change.

## 3. What is restored when reopening

A single last counter is not quite enough if we want:

```ts
session.metering.totalUsage
```

to mean the whole stable `AgentSession`, including before a process restart.

The consumer should pass a versioned state:

```ts
interface MeteringState {
  version: 1;

  totals: TokenUsage;

  activeBaseline?: {
    adapterId: string;
    internalSessionId: string;
    reportedUsage: TokenUsage;
    providerCost?: Money;
  };
}
```

And every operation returns the next state:

```ts
result.metering.nextState
```

The consumer atomically stores:

```ts
{
  operationRecord,
  nextMeteringState,
}
```

We need to decide whether that state is a public transparent structure or an opaque library checkpoint. I recommend a public versioned structure: consumers will need to inspect, migrate, and troubleshoot it.

## 4. Strict versus best-effort behavior

We agreed that zero cannot mean unavailable.

My recommendation:

```ts
metering: {
  mode: "best_effort" | "strict";
}
```

In strict mode:

- Loading an internal session without a matching checkpoint fails before prompting.
- Unresolvable pricing prevents the operation if pricing is required.
- Missing post-operation usage produces an explicit metering failure.
- No zero or fabricated delta is returned.

There remains an unavoidable limitation: the harness may consume tokens and then fail to report usage. Strictness makes this loud but cannot undo the provider operation.

We should define whether `strict` is allowed to turn an otherwise successful prompt into a rejected promise. I recommend no: return the model response with:

```ts
metering.status = "failed"
```

Otherwise consumers may retry a successfully executed prompt and spend even more.

A separate preflight error should still reject before sending when the checkpoint or pricing is already known to be missing.

## 5. Pricing resolver shape

We still need to choose whether the resolver returns rates or final line items.

I recommend it returns a pricing schedule:

```ts
pricing: async ({
  adapterId,
  model,
  at,
}) => ({
  currency: "USD",
  version: "2026-09-06",
  input: { amount: "1.25", perTokens: 1_000_000 },
  output: { amount: "10.00", perTokens: 1_000_000 },
  cachedRead: { amount: "0.25", perTokens: 1_000_000 },
});
```

The library calculates and engraves the line items.

However, provider token categories are not always perfectly comparable. We may want an advanced alternative:

```ts
quote(operation): AppliedPricing
```

That lets the consumer perform provider-specific calculations.

The spec can support both, with `schedule` as the convenient form and `quote` as the escape hatch.

## 6. Numeric representation

We should not use floating-point numbers for historical money.

Recommendation:

```ts
interface Money {
  amount: string;   // decimal
  currency: string; // ISO 4217 or provider-defined unit
}
```

Token counts remain numbers, provided we validate them as safe non-negative integers.

The implementation either needs a small decimal utility or integer rational arithmetic. We should avoid adding a large decimal dependency solely for multiplying five line items.

## 7. Operation completion and delayed updates

`PromptResponse.usage` belongs to the completed ACP prompt. Context and provider cost arrive through separate `usage_update` notifications and may not align perfectly with the response boundary.

Recommendation:

- Calculate attributable token usage from `PromptResponse.usage`.
- Keep context and cumulative provider cost as session-level observations.
- Attach `contextAfter` only when it is the latest snapshot observed before prompt completion.
- Never claim that `contextAfter` is guaranteed to include the just-completed turn.
- A later `usage_update` updates `session.contextWindow` and emits another notification.
- Provider-reported cost adjustments can arrive independently of the operation record.

This prevents us from delaying every prompt while waiting for a notification that may never arrive.

## 8. Cancellation and errors

Cancelled and failed operations can still consume tokens.

The operation record should always exist:

```ts
metering.status =
  | "metered"
  | "usage_unavailable"
  | "baseline_required"
  | "pricing_unavailable";
```

And include the operation outcome separately:

```ts
operation.status =
  | "completed"
  | "cancelled"
  | "error";
```

A cancelled operation with reported usage can still be fully metered.

## 9. Handoff granularity

This is mostly settled:

```ts
HandoffResult.meteringRecords
```

may contain:

- `handoff_summary`
- `handoff_seed`

Both contribute to the stable `AgentSession` totals. Supplying a summary removes the summary-generation operation.

## 10. Provider identity and model detection

`adapterId` and `internalSessionId` are reliable because we own them.

`model` may not always be available. We can inspect ACP config options categorized as `model`, but that is still provider-advertised state.

Recommendation:

```ts
provider: {
  adapterId: string;
  internalSessionId: string;
  model?: {
    id: string;
    source: "session_config" | "consumer";
  };
}
```

The pricing resolver may reject when a model is required but unavailable.

## 11. Subscription quotas

Keep this out of the first metering implementation except for extensibility:

```ts
session.quotas
```

ACP does not currently standardize subscription limits, and parsing `/usage` is adapter-specific. The spec should state that provider-reported quota adapters can be added later.

## 12. Transcript integrity

This should be a separate spec or a clearly separate section. It does not affect the metering contract.

The agreed direction is:

- Optional HMAC chain using a consumer-provided secret.
- Optional authenticated sidecar checkpoint.
- Verification utilities.
- Corruption/tampering detection, but not rollback-proof when an attacker controls every local file.
- No claim that transcript integrity makes the transcript an authoritative billing ledger.

So yes: we can write the spec now. I would encode the recommendations above as the initial decisions, with only one particularly consequential choice still worth confirming: whether strict metering returns a successful response carrying `metering.status = "failed"`—my recommendation—or rejects the entire prompt after the model already completed it.





Yes, these decisions resolve most of the remaining ambiguity. The key refinement is that pricing should be engraved directly beside each attributable token category.

## 2. Tokens and their applied price

I prefer the nested shape you suggested:

```ts
interface PricedTokenAmount {
  tokens: number;

  pricing:
    | {
        unitPrice: {
          amount: string;
          currency: string;
          perTokens: number;
        };

        estimatedCost: {
          amount: string;
          currency: string;
        };
      }
    | null;
}
```

Then an operation contains:

```ts
interface AttributableUsage {
  totalTokens: number;

  input: PricedTokenAmount;
  output: PricedTokenAmount;
  cachedRead?: PricedTokenAmount;
  cachedWrite?: PricedTokenAmount;
  thought?: PricedTokenAmount;
}
```

Example:

```ts
{
  totalTokens: 38_000,

  input: {
    tokens: 30_000,
    pricing: {
      unitPrice: {
        amount: "1.25",
        currency: "USD",
        perTokens: 1_000_000,
      },
      estimatedCost: {
        amount: "0.0375",
        currency: "USD",
      },
    },
  },

  output: {
    tokens: 8_000,
    pricing: {
      unitPrice: {
        amount: "10.00",
        currency: "USD",
        perTokens: 1_000_000,
      },
      estimatedCost: {
        amount: "0.08",
        currency: "USD",
      },
    },
  },
}
```

This is better than keeping pricing in an unrelated object because every category becomes independently auditable:

```text
30k input tokens × $1.25 / 1m = $0.0375
8k output tokens × $10.00 / 1m = $0.08
```

The important distinction is that pricing attaches to attributable usage, not the raw cumulative provider report:

```ts
interface OperationMetering {
  reportedCumulative?: TokenUsage;
  attributableUsage?: AttributableUsage;
}
```

Otherwise we could accidentally engrave a price against 130k cumulative tokens when the operation only added 30k.

For best-effort/subscription use, tokens may exist without a configured price:

```ts
input: {
  tokens: 30_000,
  pricing: null,
}
```

That is valid and means “30k attributable input tokens were reported, but we did not calculate a monetary estimate.”

## 3. Reopening state

I take your `comm` as agreement with the consumer restoring the latest versioned metering state.

The session maintains it while alive, returns the next state after operations, and the consumer decides whether and where to persist it.

## 4 and 11. API billing versus subscriptions

Your division resolves the issue cleanly.

### Consumer/company supplies API credentials

```text
End user pays consumer
Consumer pays model provider
```

The consumer:

- Supplies its API key through `AgentSessionConfig.env`.
- Supplies the applicable pricing resolver.
- Uses required/strict metering.
- Stores each operation record.
- Can reconcile records against the provider’s billing API.

The library already supports passing environment variables to the ACP process. The precise variable name remains harness-specific.

### End user supplies their own login/subscription

```text
End user pays model provider directly
Consumer does not bill token consumption
```

The consumer:

- Allows interactive/provider login.
- Uses best-effort metering.
- Displays context, tokens, provider estimates, or quota information when available.
- Does not treat those numbers as invoiceable consumption.

No `subscription` mode is needed.

More importantly, we should not infer that missing usage means a subscription. Missing usage could mean:

- The harness does not implement ACP usage.
- An older harness version is installed.
- The provider omitted usage.
- The operation failed.
- An adapter has a bug.
- A usage notification arrived at an unexpected time.

So the policy should describe enforcement, not authentication:

```ts
metering: {
  enforcement: "required" | "best_effort";
}
```

I prefer `enforcement` over another `mode` because `AgentSession` already has normal/degraded mode.

### Required

Intended for company-funded API use:

- Pricing must resolve before sending the operation.
- Loaded sessions require a compatible baseline.
- Missing post-operation usage is reported as a metering failure.
- No fabricated zero values.
- The response is retained even if metering fails after execution.

### Best effort

Intended for user-owned authentication/subscriptions:

- Pricing is optional.
- Token usage is recorded when available.
- Context is recorded when available.
- Provider-reported cost is identified as provider-reported.
- Missing information does not prevent prompting.
- No billing guarantees are made.

A subscription harness may report an API-equivalent cost. We preserve it as:

```ts
providerReportedCost
```

but do not call it “actual charge.”

## 10. Model identity

Agreed. `source` is unnecessary complexity.

Use:

```ts
model: string | null
```

The `AgentSession` retains the currently advertised model and snapshots that string into every operation record:

```ts
provider: {
  adapterId: "codex",
  model: "gpt-5.4",
}
```

If a harness unexpectedly fails to announce a model:

- Required metering with model-dependent pricing cannot start the operation.
- Best-effort metering uses `model: null`.
- A consumer pricing resolver could still return adapter-wide pricing if appropriate.

We should test:

- Model advertised during session creation.
- Model updated through config.
- Operation after model change uses the new model and price.
- Historical records retain the previous model and price.

## 7. Timing of context and cost updates

Agreed that this needs deeper empirical testing.

For the first specification, we should define conservative behavior:

- Prompt token usage comes from `PromptResponse`.
- Context and provider cost come from `usage_update`.
- `contextAfter` means the latest observation received before operation completion.
- It does not claim that the provider included the completed operation.
- Later updates change `session.contextWindow`.
- Later provider-cost updates emit a separate notification.
- The library does not wait arbitrarily after a prompt for a possible update.

Then we test real harnesses to learn their ordering:

```text
Codex ACP
Claude ACP
Pi ACP
Kimi ACP
OpenCode
```

If the observed behavior supports a stronger correlation rule, we can add it later.

## Revised operation record

The resulting model is approximately:

```ts
interface OperationMeteringRecord {
  operationId: string;

  operation: {
    kind:
      | "prompt"
      | "internal_command"
      | "handoff_summary"
      | "handoff_seed";

    status: "completed" | "cancelled" | "error";
    startedAt: number;
    completedAt: number;
  };

  session: {
    agentSessionId: string;
    internalSessionId: string;
  };

  provider: {
    adapterId: string;
    model: string | null;
  };

  usage:
    | {
        status: "metered";
        reportedCumulative: TokenUsage;
        attributable: AttributableUsage;
      }
    | {
        status: "unavailable" | "baseline_required";
        reportedCumulative?: TokenUsage;
      };

  providerReportedCost?: {
    cumulative: Money;
    attributableDelta?: Money;
  };

  contextAfter: ContextWindowStatus | null;

  nextState: MeteringState;
}
```

Each priced token category contains the exact rate applied at that moment. There is no dependence on a later global pricing table.

## Transcript integrity

Agreed: defer it.

The transcript is not the accounting source of truth, so HMAC support is not required for this metering pass. We can revisit it as a separate transcript-integrity feature.

## Are we ready for the spec?

Yes. I think this is now sufficiently defined to write the metering specification.

The only deliberately open matter is the real-world ordering of ACP usage/context updates. The spec can document conservative semantics and require an empirical harness test matrix before we claim stronger guarantees.



# Limitation

Both, but the protocol is the primary cause — and I found something that sharpens the point.

## Protocol-level (the real blocker)

**1. There is no capability to negotiate on.** I checked `AgentCapabilities`, `PromptCapabilities`, and `SessionCapabilities` in `@agentclientprotocol/sdk@0.25.1` — nothing advertises usage or cost support. `usage` is just an optional field marked `**UNSTABLE** … not part of the spec yet, and may be removed or changed at any point` / `@experimental` (`types.gen.d.ts:3745-3754`), same for the `Usage` type itself. So a client cannot ask "will you report usage?" — it can only send a prompt and find out afterward. Required mode wants a preflight guarantee that the protocol structurally cannot give.

**2. Worse: the SDK's own docs contradict themselves on cumulative-vs-per-turn.**

- `PromptResponse.usage` (`:3750`): *"Token usage for this turn (optional)."*
- `Usage.inputTokens` (`:5342`): *"Total input tokens across all turns."*
- `Usage.totalTokens` (`:5356`): *"Sum of all token types across session."*

§4 of the spec asserts cumulative as settled fact. It's the better reading (the field-level docs are more specific and `totalTokens` only makes sense session-wide), but a harness implementer reading the property doc will emit per-turn — and both are defensible against this schema. That's a protocol defect, not a spec defect.

This matters more than the missing capability flag: subtracting a baseline from per-turn counters yields near-zero or negative deltas. Negative surfaces as `counter_reset`; a harness whose per-turn numbers happen to grow gives you *silently wrong small numbers*, which required mode will happily price and report as authoritative. Detecting cumulative-vs-per-turn empirically is possible (compare report 2 against report 1 across a big turn) but the spec has no such probe.

## Spec-level (amplification, and the part you control)

The spec's choices turn a flaky signal into a hard stop:

- Blocking is **permanent for the object's life** with no in-place recovery — one bad turn from one harness ends the session.
- The failure is discovered **at turn N, not turn 1**. Nothing forces the availability question early.
- **PTY degraded mode is a preflight rejection**, so the fallback path is also closed.

So the honest framing is: the protocol makes required mode *unverifiable in advance*, and the spec makes that unverifiability *fatal on first occurrence*.

## What I'd change

Nothing about required mode's strictness — the strictness is correct for its stated purpose. Two additions:

1. **A calibration turn.** Required mode's first operation is treated as a probe: it must return usage, and its numbers plus the next report establish cumulative-vs-per-turn empirically. Fail there, cheaply, rather than at turn 40. §20's harness matrix already plans to gather exactly this data — the spec just doesn't feed it back into runtime.
2. **An explicit reconciliation escape hatch** (`session.reconcileMetering(state)`), audited in the record stream. §12 rejects "assume zero" resets, which is right — but reconstructing the whole session to recover from a harness hiccup is a heavy price for something the protocol guarantees will happen.

And §4 should stop asserting cumulative as settled. Cite both doc strings, state the chosen interpretation, and say how the implementation detects the other one.



# Idea

The library spawns the harness itself and fully controls its environment (`src/transport/acp-transport.ts:80-82`). That changes what's possible, and I think it dissolves the problem.

## The reframe

Required mode's premise is that ACP `usage` can be made reliable. It can't — it's `@experimental`, unnegotiable, ambiguous between per-turn and cumulative, and *volunteered by the agent*. No amount of spec discipline fixes a signal the counterparty may simply not send.

But look at what defines this consumer: **they own the API keys.** That's not just a billing condition, it's a capability. If the keys are yours, the model traffic is yours, and you don't have to ask the harness what it spent — you can be the thing it spends through.

## Tier 1: metering egress proxy

The library starts a loopback HTTP server, then spawns the harness with its provider base URL pointed at it:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:PORT/anthropic
OPENAI_BASE_URL=http://127.0.0.1:PORT/openai
```

Every inference the harness makes transits the proxy. You read `usage` out of the provider's own response body — the exact block that generates the invoice line, including `cache_creation_input_tokens` / `cache_read_input_tokens` with unambiguous, documented inclusivity semantics, plus the real model id per call. For streaming, the final `message_delta` carries output tokens.

Why this is categorically better than what §4-§8 build:

- **Exact, not derived.** No cumulative deltas, no baselines, no `counter_reset`, no restored-state matching. Sections 8 and 11 of the spec largely evaporate for this tier.
- **Per-inference, not per-operation.** The spec's §1 disclaimer — "an ACP prompt may hide retries, compaction, or multiple model calls" — stops being a disclaimer. You see the retries and the compaction calls, because they're HTTP requests.
- **Correlation is free.** `AgentSession` already serializes operations through one queue (`src/agent-session.ts:493`). Every inference observed between operation start and operation end belongs to that operation. Handoff summary and seed prompts land in their own windows automatically.
- **Failure is unambiguous, and that's the whole ballgame.** If the harness ignores the base-URL override, the proxy sees zero requests while the prompt succeeds. That's a *positive, detectable* signal — unlike an absent ACP `usage` field, which could mean old harness, failed turn, or provider defect. Required mode finally has something it can actually verify at preflight: send one trivial prompt, assert traffic flowed through you, fail immediately and cheaply if not.
- **Key custody as a side effect.** Inject a placeholder token into the subprocess env and have the proxy attach the real `Authorization` header. The consumer's key never enters the harness process env or argv.

This is not interception — it's a configured egress path, plain HTTP to loopback, no TLS termination or certificate games, using credentials the consumer already owns.

## The tier model

Make provenance a first-class field rather than having one mode that pretends:

| Tier | Source       | Grade                                | For                                          |
| ---- | ------------ | ------------------------------------ | -------------------------------------------- |
| 1    | Egress proxy | exact, per-inference, verifiable     | consumer-owned API keys — production billing |
| 2    | ACP `usage`  | derived, per-operation, unverifiable | subscription logins, dashboards              |
| 3    | none         | operation occurred, cost unknown     | degraded PTY, opaque harnesses               |

```ts
readonly source: "proxy" | "acp_usage" | "none";
readonly grade: "exact" | "derived" | "unavailable";
```

`enforcement: "required"` then means **"tier 1 or refuse to start"** — a preflight the library can genuinely enforce, instead of §12's promise that it can't keep. Best-effort accepts any tier and labels it. The permanent-block machinery mostly goes away, because tier 1 doesn't have the failure mode it was defending against: if the proxy is up, usage is there.

## What survives from the current spec

Most of it, and it slots in cleanly. `Money`/`TokenUnitPrice`/`PricedTokenAmount`, the engraved-price rule, `PricingResolver`, `OperationMeteringRecord`, `operationId` as the join key, bounded live state, the notification contract, context-window tracking (still ACP-only — the proxy sees requests, not the harness's own context accounting), and provider cost as distinct telemetry. What changes is that the record's usage can arrive from a source that doesn't need §8's baseline arithmetic at all.

## Honest limits

- **Per-adapter verification required.** Base-URL env vars differ per harness and some may ignore them. This becomes an adapter-preset field (`proxy: { envVar, pathPrefix }`) with an empirically verified matrix — an extension of §20's harness investigation, and the same work you already planned.
- **Subscription/OAuth harnesses are out.** A Claude Pro login doesn't route through a consumer key, and routing it through a proxy would be both technically fragile and contrary to how those credentials are meant to be used. Those stay tier 2 — which is correct, since nobody bills against them anyway.
- **Non-HTTP or vendored-endpoint harnesses** fall back to tier 2.
- **Reconciliation is still the consumer's.** Tier 1 gets you provider-grade *counts*; the invoice is still the provider's, and §19's crash boundary is unchanged.

The tiering is what makes this production-stable: you stop asking every harness to be trustworthy and instead state, per session, exactly which grade of truth you have — and refuse to run in required mode without the grade that justifies the word.

Want me to write this up as §22 of the spec (plus the edits it forces in §12 and §8)?





---



Fair — let me do it concretely for `claude`.

## What happens today

`ADAPTERS.claude` spawns `claude-agent-acp` (`src/adapters.ts:32`). That bridge embeds the Claude Agent SDK, and the SDK ultimately makes **HTTPS requests to `api.anthropic.com/v1/messages`**. "SDK thing" is true one layer up, but at the bottom it is still HTTP to Anthropic — an SDK is a client library, not a private channel.

```
AgentSession
  └─ Bun.spawn(["claude-agent-acp"])        ← acp-transport.ts:80
       └─ Claude Agent SDK
            └─ POST https://api.anthropic.com/v1/messages   ← the truth lives here
```

Your only view of that bottom line is whatever the bridge chooses to put in `PromptResponse.usage` — optional, experimental, possibly absent.

## What changes

The Agent SDK honors `ANTHROPIC_BASE_URL` (that's the documented mechanism people use to route Claude Code through LiteLLM, Bedrock gateways, and corporate proxies). You already set the child env at `acp-transport.ts:82`. So:

```ts
const meter = await MeteringProxy.start();   // binds 127.0.0.1:0, gets a random port

Bun.spawn(["claude-agent-acp"], {
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: meter.url,        // http://127.0.0.1:53411
    ANTHROPIC_API_KEY: meter.placeholder, // real key stays in your process
  },
});
```

Now the same call goes:

```
Claude Agent SDK
  └─ POST http://127.0.0.1:53411/v1/messages
       └─ MeteringProxy  ── swaps in the real key, forwards ──►  api.anthropic.com
                          ◄── streams the response back verbatim ──
```

The proxy is a dumb pipe. It doesn't rewrite the prompt, doesn't change the model, doesn't buffer the stream. It forwards, and on the way back it reads two frames out of the SSE it's already relaying:

```
message_start  → usage: { input_tokens, cache_creation_input_tokens,
                          cache_read_input_tokens, output_tokens }, model
message_delta  → usage: { output_tokens }   ← final count
```

Those are Anthropic's own numbers — the ones the invoice is computed from — with documented cache semantics and the actual model id, not a bridge's optional re-report of them.

## A concrete turn

You call `session.prompt("refactor this file")`. The agent reads a file, edits it, runs tests. That's **one ACP operation** but four inferences:

| #   | proxy sees                     | input | cache_read | output |
| --- | ------------------------------ | ----- | ---------- | ------ |
| 1   | POST /v1/messages              | 4,200 | 0          | 180    |
| 2   | POST /v1/messages (after Read) | 900   | 4,100      | 340    |
| 3   | POST /v1/messages (after Edit) | 1,100 | 5,200      | 90     |
| 4   | POST /v1/messages (after Bash) | 1,400 | 6,300      | 210    |

Correlation needs no new machinery: `AgentSession` serializes everything through one queue (`src/agent-session.ts:493`), so every request the proxy observes between operation start and operation end belongs to that operation. You sum the four and attach them to that `operationId`.

Compare what §8 of the spec would have done: subtract a cumulative baseline from one optional `usage` object the bridge may or may not send, hope it's cumulative and not per-turn, and disclaim in §1 that you can't see the hidden inferences. Here you saw all four, exactly, and the retry the SDK did on a 529 would have been a fifth row.

## Where it doesn't apply

This is the important boundary, and for Claude it's sharp: **it works when there's an API key, and only then.** If the user authenticated `claude-agent-acp` with a Claude subscription login, the SDK sends an OAuth token to Anthropic's own endpoint — pointing that elsewhere is neither workable nor appropriate, and nobody's billing against it anyway.

Which is exactly the tier split I proposed: API key → tier 1 (proxy, exact, `required` mode allowed); subscription login → tier 2 (ACP `usage`, best-effort, labeled as such). Your `enforcement: "required"` consumer is *by definition* the one supplying keys, so it's the one that qualifies.

## The preflight that makes "required" real

Start the session, send one cheap prompt, assert the proxy saw ≥1 request. If `claude-agent-acp` ignored `ANTHROPIC_BASE_URL` — or a future version stops honoring it — you see zero requests alongside a successful response, and you fail immediately with a clear cause. That's the property ACP `usage` can never give you: its absence is ambiguous, this absence is proof.

Everything else in your spec stays — `Money`, `PricingResolver`, engraved prices, `OperationMeteringRecord`, `operationId` as join key, the notifications. What the proxy replaces is §8: no baselines, no cumulative deltas, no `counter_reset`, no restored-baseline matching, because you're reading absolute per-request numbers instead of inferring them from a counter someone else maintains.





# !

I think the gateway is the right direction for production metering—but the proposal currently overstates two properties: “exact” and “verifiable.”

Provider-native usage is far stronger than ACP usage. Anthropic explicitly defines total input as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, and streaming responses expose usage in `message_start` and `message_delta`. That removes the cumulative/per-turn ambiguity and exposes hidden model calls, retries, and compactions. [Messages API](https://platform.claude.com/docs/en/api/typescript/messages), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).

But I would call it provider-reported usage, not exact billing. The provider invoice can still include pricing changes, service tiers, discounts, credits, rounding, regional differences, and other adjustments.

The more important qualification is routing completeness.

Seeing one request during calibration proves that one request used the gateway. It does not prove that every request did. A harness could use another stored credential, ignore the base URL on one code path, or route some operations through Bedrock, Vertex, or another endpoint. `ANTHROPIC_BASE_URL` is supported by Anthropic’s TypeScript client, but there has already been a version-specific Agent SDK regression around that variable. [Anthropic SDK client](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts), [Agent SDK issue](https://github.com/anthropics/claude-agent-sdk-typescript/issues/144).

For truly enforced metering, all of these must hold:

- The real API key exists only in the parent/gateway process.
- The harness gets a short-lived placeholder or capability credential.
- The gateway strips supplied authorization and injects the real credential.
- The harness cannot obtain another usable provider credential.
- Direct provider egress is blocked; only the loopback gateway can reach the provider.
- Every provider request is attributed or explicitly marked unallocated.

Without the direct-egress restriction, this is still excellent observed metering, but it is not proof of completeness.

### I would model more than one “grade”

A single `grade` conflates several independent facts. I suggest:

```ts
interface MeteringProvenance {
  source: "provider_gateway" | "acp_usage" | "none";

  // What kind of counter was observed?
  measurement:
    | "provider_reported"
    | "acp_derived"
    | "unavailable";

  // Could traffic have bypassed the observed source?
  routing:
    | "enforced"
    | "observed"
    | "unknown";

  // Can every measured inference be assigned to an operation?
  attribution:
    | "complete"
    | "partial"
    | "unavailable";
}
```

Then production billing requirements become explicit:

```ts
{
  measurement: "provider_reported",
  routing: "enforced",
  attribution: "complete"
}
```

I would offer a convenience preset such as `enforcement: "billing_required"`, but avoid defining “required” permanently as “must use our proxy.” A future harness or protocol revision might provide another trustworthy source.

### Correlation is strong, but not free

The serialized `AgentSession` queue gives us a very good operation boundary, but a harness could still:

- start concurrent inference calls;
- finish ACP before a background model call completes;
- perform automatic title-generation or compaction between operations;
- retry asynchronously after cancellation.

Every gateway request should therefore have its own ID and attribution:

```ts
interface ProviderInferenceRecord {
  requestId: string;
  agentSessionId: string;
  internalSessionId: string;
  operationId: string | null;

  attribution: "direct" | "background" | "ambiguous";
  usage: ProviderReportedUsage;
}
```

Anything not unambiguously attributable must not silently become part of the next operation. It should enter an `unallocatedUsage` bucket. Billing-required mode can reject or block when that happens.

A dedicated gateway per `AgentSession`, or an unguessable per-session routing token, makes this much easier.

### The calibration turn still has value

A calibration operation is useful for compatibility testing, but it should be:

- an explicit `metering_calibration` operation;
- run in a disposable internal thread if possible;
- metered and recorded itself;
- understood as a point-in-time compatibility check, not continuing proof.

Continuous proof comes from withholding credentials and blocking direct egress, not from calibration.

### Where this belongs architecturally

I would avoid putting provider-specific proxy behavior directly into `Adapter`. The adapter currently describes how to launch an ACP harness; provider transport and metering are a separate concern.

Something closer to this would preserve that separation:

```ts
interface MeteringSource {
  startOperation(context: OperationContext): Promise<void>;
  finishOperation(context: OperationContext): Promise<MeteringResult>;
}

class AcpUsageMeteringSource implements MeteringSource {}
class ProviderGatewayMeteringSource implements MeteringSource {}

interface ProviderProtocolCodec {
  prepareUpstreamRequest(...): Promise<...>;
  observeResponse(...): Promise<ProviderUsage[]>;
}

class AnthropicMessagesCodec implements ProviderProtocolCodec {}
```

This could be exposed through an optional package subpath rather than forcing an HTTP reverse proxy and provider codecs into every consumer:

```ts
import { ProviderMeteringGateway } from "acp-lib/metering-gateway";
import { AnthropicMessagesCodec } from "acp-lib/metering-gateway/anthropic";
```

The consumer supplies gateway configuration. A compatibility registry can record that a particular harness/version is known to respect a particular endpoint override, without hardcoding it into the core adapter abstraction.

### Security constraints are part of the feature

Because the gateway sees full prompts, tool results, and responses, it must:

- bind only to loopback and a random port;
- authenticate child requests using an unguessable session token;
- use a strict upstream allowlist;
- never behave as a general forwarding proxy;
- avoid recording request and response bodies by default;
- redact headers and credentials from diagnostics;
- preserve streaming and backpressure;
- handle cancellation and partial streams correctly.

That is enough complexity that I would not treat this as merely a section added to the existing spec.

My recommendation is:

1. Keep the current ACP metering design as the derived fallback.
2. Change its language so cumulative usage is a chosen adapter interpretation, not an ACP guarantee.
3. Add the provenance/completeness dimensions above.
4. Write a separate provider-metering-gateway spec.
5. Build a Claude-direct-API spike against `claude-agent-acp`.
6. Verify endpoint routing, streaming usage, retries, cancellation, internal compaction calls, credential isolation, and background requests.
7. Only then define `billing_required` semantics.

So: yes, the gateway largely dissolves the cumulative-counter problem. It does not automatically dissolve the completeness and attribution problems—but those are solvable, unlike ACP’s missing and ambiguous usage signal. The crucial conceptual change is that “production-grade” means provider-reported usage plus enforced routing plus complete attribution, not merely “the proxy saw some traffic.”





Yes. Limiting reliable billing to OpenCode makes the design much stronger and more feasible—but the initial guarantee should be scoped to certified OpenCode/provider combinations, not “OpenCode with every provider.”

OpenCode gives us several advantages:

- It is open source and can be version-pinned.
- It has explicit provider configuration, including `baseURL`.
- It normalizes usage across providers internally.
- Its newer plugin hooks observe every native HTTP request and response made by a session.
- Those hooks identify whether a call is `primary`, `compaction`, `title`, or `generate`, which largely solves the attribution problem. [OpenCode plugin hooks](https://opencode.ai/v2/docs/build/plugins/)
- It runs directly as an ACP server through `opencode acp`. [OpenCode CLI](https://dev.opencode.ai/docs/cli/)
- Provider endpoints can be explicitly overridden through configuration instead of relying on undocumented harness behavior. [OpenCode providers](https://opencode.ai/docs/providers)

The architecture could become:

```text
consumer
   │
   ▼
AgentSession
   │ ACP: prompts, events, permissions, transcript
   ▼
managed OpenCode process
   │
   ├── bundled metering plugin
   │      └── authenticated local metering channel
   │
   └── provider requests
          └── optional credential/metering gateway
```

ACP remains the control/conversation plane. The OpenCode plugin becomes the metering observation plane.

## Why the OpenCode plugin matters

The plugin can report model-call boundaries directly:

```ts
interface OpenCodeInferenceRecord {
  openCodeSessionId: string;
  requestId: string;

  kind: "primary" | "compaction" | "title" | "generate";
  provider: string;
  model: string;
  attempt: number;

  usage: TokenUsage;
  startedAt: string;
  completedAt: string;
}
```

OpenCode’s internal assistant messages already contain normalized token categories and calculated cost. Its current code handles input, output, reasoning, cache-read, and cache-write tokens. However, OpenCode itself describes calculated cost as an estimate, so we should use its normalized token counts and apply our engraved pricing schedule rather than treating its monetary calculation as billing truth. [OpenCode usage implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts), [OpenCode LLM design](https://github.com/anomalyco/opencode/blob/dev/packages/llm/DESIGN.md)

A bundled plugin can forward final records to an authenticated loopback endpoint owned by `acp-lib`. We would no longer depend primarily on ambiguous `PromptResponse.usage`.

## Reliable mode should be managed OpenCode

I would separate two configurations:

```ts
adapter: openCode()
```

This is ordinary ACP usage. The user’s existing OpenCode installation, configuration, credentials, and providers remain available. Metering is best-effort.

```ts
adapter: managedOpenCode({
  metering: {
    enforcement: "billing_required",
    provider: ...,
    pricingResolver: ...
  }
})
```

The managed variant would:

- accept only tested OpenCode versions;
- create an isolated temporary OpenCode profile/configuration;
- install our bundled metering plugin;
- require a successful authenticated plugin handshake;
- disable or exclude credentials from the user’s normal OpenCode profile;
- configure the selected provider explicitly;
- verify that every model call produces a final metering record;
- fail closed if the plugin disconnects or reports unattributed usage;
- record the precise OpenCode and plugin versions.

This makes the guarantee something we control.

## “OpenCode supports all providers” needs qualification

OpenCode supporting 75+ providers is useful for reach, but it does not make all 75 equally meterable. Providers differ in:

- protocols;
- cache-token semantics;
- reasoning-token reporting;
- streaming formats;
- failed-request billing;
- hosted subscription versus API-key authentication;
- whether normalized usage is complete.

Therefore certification should be a matrix:

| Harness | Provider route | Metering | Required mode |
|---|---|---:|---:|
| OpenCode pinned version | Anthropic API key | certified | yes |
| OpenCode pinned version | OpenAI API key | certified later | yes |
| OpenCode | OpenAI-compatible custom endpoint | observed | best-effort |
| OpenCode | subscription/OAuth | derived | best-effort |
| Other ACP harness | ACP usage | derived | best-effort |

“One harness first” is good. “Every OpenCode provider immediately” would bring most of the uncertainty back.

## Recommended first slice

I would start with:

```text
OpenCode + Anthropic direct API + managed configuration
```

Specifically:

1. Pin one OpenCode version.
2. Build the OpenCode metering plugin.
3. Observe every HTTP request/response and its `kind`.
4. Export normalized per-inference usage through a local authenticated channel.
5. Route Anthropic through an optional gateway for credential isolation.
6. Apply and engrave our own pricing schedule.
7. Correlate OpenCode session IDs with `agentSessionId`, `internalSessionId`, and `operationId`.
8. Test primary calls, tool continuations, retries, compaction, title generation, cancellation, failure, handoff, and subprocess crashes.
9. Enable `billing_required` only for that certified combination.
10. Add OpenAI and other provider routes incrementally.

## Do we still need the gateway?

For metering completeness, perhaps not immediately: an in-process OpenCode plugin sees model calls much closer to their actual execution than ACP does.

For key custody and routing enforcement, the gateway remains valuable. Otherwise OpenCode must possess the real API key, and commands/tools launched by the harness may potentially inherit sensitive environment configuration.

So I would distinguish:

- OpenCode plugin: detects and attributes every inference.
- Provider gateway: keeps credentials outside the harness and provides provider-native verification.
- Both together: strongest billing mode.

This is considerably more achievable than supporting reliable billing across arbitrary ACP harnesses. The right initial contract is not “ACP billing is reliable”; it is:

> `acp-lib` provides certified billing-grade metering when running a supported OpenCode version, provider route, metering plugin, and managed configuration. Other ACP adapters remain best-effort.

That is a narrow, honest contract we can actually test and defend.




# !!


That critique is right on the points that matter, and one of them lands squarely on me.

## Conceding the real one

**Routing completeness kills my calibration argument.** I claimed the preflight "makes required real" — that seeing traffic proves the channel. It doesn't. One observed request proves one observed request; a harness with a second stored credential, a Bedrock/Vertex code path, or a version regression on `ANTHROPIC_BASE_URL` produces silent under-metering that looks identical to correct operation. That's the same ambiguity I criticized ACP for, relocated. The four-axis decomposition (`source` / `measurement` / `routing` / `attribution`) is better than my single `grade` precisely because it makes that failure nameable instead of collapsing it into a word that implies more than it delivers.

"Provider-reported, not exact" — agreed, and I overstated it. Also agreed on: `billing_required` as a preset rather than redefining `required` around our proxy; per-request `ProviderInferenceRecord` with explicit `attribution`; the `unallocatedUsage` bucket; the security constraints; keeping provider transport out of `Adapter` (which matches the existing intent at `src/adapters.ts:1` — "Adapters carry ONLY what's needed to LAUNCH the connection"); and a separate spec.

Three places I'd diverge.

## 1. `routing: "enforced"` is not something the library can ever set

The critique lists direct-egress blocking as a condition for `enforced`. Correct — and that's precisely why acp-lib can't self-report it. Blocking egress needs a network namespace, firewall rules, or a container: root-level, platform-specific machinery that a library calling `Bun.spawn` has no portable way to establish or verify. If the library sets `routing: "enforced"` based on its own configuration, it's asserting something it didn't check.

So the field should be split by who's asserting:

- The library self-reports `routing: "observed"` and never more. That's the truthful ceiling for anything it can establish alone.
- `enforced` is a **consumer assertion about the deployment**, passed in explicitly and stamped into records as provenance, alongside what backs it.

This connects to machinery you already have. `buildSpawnCommand` supports an exec prefix (`["docker","exec","-i","<container>"]`, `src/adapters.ts:74`). A container with no egress except the loopback gateway *is* the enforcement mechanism — and it's the consumer's infrastructure, not the library's. Document the deployment recipe, accept the assertion, record it. Don't manufacture it.

That also keeps `billing_required` honest: it demands `measurement: provider_reported` + a consumer-asserted `enforced` + `attribution: complete`, and the library's contribution is to refuse to run when it can't supply its two-thirds.

## 2. The OpenCode plugin doesn't substitute for the gateway — they solve different axes

The critique says "for metering completeness, perhaps not immediately: an in-process plugin sees model calls much closer to their actual execution." I'd push back on that framing.

A plugin reports what the harness's own code path chooses to report. It's better instrumented than ACP `usage` — the `primary | compaction | title | generate` discriminator is genuinely valuable — but it is **structurally the same class of signal**: self-reported by the counterparty. If a request bypasses the hook (a code path that doesn't fire it, a version drift, a provider integration that routes differently), the plugin is silent in exactly the way ACP `usage` is silent. It can't establish completeness, because completeness is a claim about calls you *didn't* see, and only something on the wire can make that claim.

So:

|                 | measurement        | routing                              | attribution               | custody |
| --------------- | ------------------ | ------------------------------------ | ------------------------- | ------- |
| Gateway         | provider_reported  | observed (→enforced w/ egress block) | partial                   | yes     |
| OpenCode plugin | harness_normalized | unknown                              | **complete, with `kind`** | no      |

The plugin is the **attribution** authority — it knows a request was title-generation, which the gateway can only guess at from request shape. The gateway is the **measurement and custody** authority. Neither subsumes the other, and the combination is strong for a reason more specific than "both together = strongest": the gateway counts, the plugin labels. Where they disagree on the *set* of requests, that discrepancy is itself the completeness signal you've been missing — reconciling gateway request count against plugin record count is a far better continuous check than my calibration turn was.

## 3. I'd sequence gateway-first, not OpenCode-first

This is where I most disagree. The recommended first slice makes the initial deliverable depend on **two** novel integrations — a metering gateway *and* a bundled plugin against a third-party v2 plugin API, plus managed profiles and version pinning.

Consider the leverage:

- A gateway codec is written **per provider protocol**. Anthropic Messages and OpenAI Chat/Responses probably cover the large majority of traffic across `claude`, `codex`, `pi`, `opencode`, and `kimi` alike. Two codecs, many harnesses.
- A plugin is written **per harness**, only for harnesses that expose a plugin API, and re-certified per version.

The gateway is the reusable asset; the plugin is a per-harness enhancement. Building the plugin first means the first thing you ship is the thing with the worst reuse ratio and the tightest external version coupling.

I'd do: **gateway + Anthropic codec, harness-agnostic, spiked against `claude-agent-acp`** (which the critique also lists, as step 5 rather than step 1). That gets you `measurement: provider_reported` and per-inference visibility immediately, on the adapter your consumers most likely want, and the same codec then works when OpenCode is pointed at Anthropic. Add the OpenCode plugin second, as the attribution layer that upgrades `attribution: partial` → `complete` and enables `billing_required`.

The narrow honest contract survives intact — it just arrives via a path that leaves you with a provider-protocol asset rather than a harness-specific one.

## Smaller things worth folding in

- **`unallocatedUsage` needs to reach `AgentSessionMeteringState` and the totals**, not just live in the gateway. This is the same defect I flagged earlier in `UsageTotals`: non-optional numeric fields that silently read as complete. Totals need an explicit incompleteness channel, and unallocated inference is one of its sources.
- **Don't meter `/v1/messages/count_tokens`** — it's a real request with no usage to bill. The codec needs an explicit endpoint classification, not "anything that looks like a POST."
- **The gateway resolves §7's `model: string | null` problem** as a side effect: every provider request carries its actual model id, so pricing stops depending on whether ACP happened to surface model configuration.
- **Failed and partially-streamed requests still consume input tokens.** The codec must record a terminated stream as an inference with whatever `message_start` reported, not discard it.

## Bottom line

I'd accept the critique's corrections wholesale on measurement language, provenance decomposition, attribution, and security, reject `routing: "enforced"` as a library-settable value, treat the plugin as complementary rather than potentially-substitutive, and invert the build order to gateway-first.

Want me to write the provider-metering-gateway spec on that basis — including the ACP-spec edits it forces (§4 cumulative-as-interpretation, §8 as derived fallback, §12 replaced by the provenance axes)?




# ?

Yes—this revised shape is strong enough to become the architecture. I would proceed with it, with four important corrections.

First, models.dev gives us deterministic and auditable pricing, but it does not make usage normalization correct “by construction.” These remain separate:

```text
OpenCode provider integration
    → normalized token categories

models.dev snapshot
    → prices assigned to those categories
```

They are maintained by the same ecosystem, which substantially reduces mismatch risk, but a provider adapter can still normalize incorrectly and the catalog can contain missing or incorrect prices. Models.dev currently has open issues concerning missing cache-write prices, for example. [models.dev repository](https://github.com/sst/models.dev), [example pricing discrepancy](https://github.com/anomalyco/models.dev/issues/2097)

Therefore the certification test must validate both:

- the observed provider usage maps correctly into OpenCode’s normalized categories;
- the catalog prices those categories completely and correctly for the certified route.

Second, a “catalog version” should be a real immutable identity. Models.dev does not appear to publish a semantic catalog version suitable for this purpose. We should vendor a generated snapshot and identify it by:

```ts
interface PricingSource {
  kind: "models.dev";
  commit: string;
  artifactSha256: string;
  generatedAt: string;
}
```

During snapshot generation, JSON numbers should be converted into our canonical decimal representation. Every operation then engraves:

- catalog identity;
- provider ID and model ID used for lookup;
- selected pricing tier;
- every unit price;
- every subtotal.

The date is useful metadata, but the commit and artifact hash provide reproducibility.

Third, I would call the calculated result `ratedCost` or `estimatedCost`, not merely `cost`:

```ts
interface RatedCost {
  basis: "catalog" | "consumer_override";
  amount: Money;
  pricingSource: PricingSource;
}
```

It is exact under the engraved schedule. It is not necessarily identical to the provider invoice.

That gives us two legitimate meanings:

- `providerCost`: something the provider or harness reported;
- `ratedCost`: what our deterministic tariff calculation produced.

If a consumer bills its users according to `ratedCost`, then that amount is authoritative for the consumer’s own billing policy—even if its upstream provider invoice later differs.

Fourth, removing `routing: "enforced"` creates a small hole in the proposed `billing_required` definition. Source inspection and version pinning give us certified coverage, but `routing: "observed"` alone does not express that.

I would add certification explicitly:

```ts
interface MeteringProvenance {
  source: "opencode_plugin" | "acp_usage" | "none";
  measurement:
    | "provider_normalized"
    | "acp_derived"
    | "unavailable";
  routing: "observed" | "unknown";
  attribution: "complete" | "partial" | "unavailable";

  certification?: {
    id: string;
    openCodeVersion: string;
    openCodeArtifactSha256?: string;
    pluginVersion: string;
    providerId: string;
    providerRuntime: string;
    protocol: string;
  };
}
```

Then:

```text
billing_required =
  recognized certification
  + provider-normalized measurement
  + complete attribution
  + complete pricing
```

It does not depend on claiming network enforcement.

## Certification must be narrower than version × provider

I would certify this tuple:

```text
OpenCode artifact/version
× plugin version
× OpenCode runtime path
× provider package/version
× provider route/protocol
× authentication mode
× pricing snapshot
```

For example:

```text
OpenCode 1.x.y
@opencode-ai/anthropic x.y.z
AI SDK runtime
Anthropic Messages API
API-key authentication
models.dev commit abc123
```

This matters because the same `providerId: "anthropic"` could theoretically use a different runtime, proxy, cloud platform, protocol, or provider package.

The record does not necessarily need every field expanded. It can carry a stable certification ID plus the useful diagnostic fields:

```ts
certificationId:
  "opencode-1.x.y/anthropic-messages-api-key/v1"
```

## OpenCode becomes an explicit metering backend

I would avoid replacing the normal OpenCode adapter. Instead:

```ts
openCode()
```

Ordinary ACP adapter, any locally installed OpenCode, best-effort ACP metering.

```ts
managedOpenCode({
  metering: {
    enforcement: "billing_required"
  }
})
```

Managed and certified:

- launches a supported OpenCode artifact;
- creates an isolated configuration;
- loads the bundled plugin;
- performs an authenticated plugin handshake;
- rejects unsupported versions or routes;
- reports every normalized inference;
- resolves prices from the pinned catalog;
- fails if usage, attribution, or pricing is incomplete.

The current adapter merely launches `["opencode", "acp"]`, so this would be a genuinely new managed mode rather than silently changing existing behavior.

## Unallocated usage

Agreed that it belongs in both live state and totals. But we should try to classify auxiliary usage before declaring it unallocated:

```ts
type InferencePurpose =
  | "operation"
  | "handoff_summary"
  | "handoff_seed"
  | "compaction"
  | "title"
  | "retry"
  | "background"
  | "unknown";
```

OpenCode’s hooks already distinguish `primary`, `compaction`, `title`, and `generate`, which is a major advantage. [OpenCode plugin hooks](https://opencode.ai/v2/docs/build/plugins/)

Usage becomes `unallocated` only when we cannot associate it with an `AgentSession` or accountable operation/system activity. In `billing_required`, such usage should still be recorded, but the operation should not claim complete attribution.

## Final shape

I agree with the seven points, amended as follows:

1. ACP usage remains derived and best-effort.
2. Provenance includes explicit certification rather than network-enforcement claims.
3. Unallocated usage is represented in state, records, and totals.
4. A vendored models.dev snapshot supplies default pricing.
5. Catalog commit/hash and applied prices are engraved per operation.
6. `ratedCost` remains distinct from provider-reported cost and invoices.
7. First certification is one pinned OpenCode build, one plugin build, Anthropic Messages through API-key authentication.
8. Other providers become certified entries only after normalization, attribution, pricing, retries, compaction, and failure behavior are tested.
9. The gateway remains a separate future subsystem.

So yes: we should now revise the existing ACP metering spec and create a separate OpenCode certified-metering spec. This is a much more defensible design than trying to make experimental ACP usage carry production billing guarantees.