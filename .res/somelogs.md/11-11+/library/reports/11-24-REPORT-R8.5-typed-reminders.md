# R8.5 Part 1 — typed reminder client inventory

Baseline: alpha `4dad65e`, branch `reminders-typed`. This is the proposed
type and call-site refactor. The one-off behavior, route selection and
public event shapes stay as in R8. Part 2 awaits core-p's go.

| Current copy or cast | Harness source of truth and proposed replacement |
| --- | --- |
| `WireReminder` in `src/native/reminders/wire.ts` | Import exported `Reminder` from `src/native-harness/src/client.ts`, aliased where necessary to distinguish it from the library's numeric-time persistence model. Use it for wire rows in `sync.ts`, fixture declarations and the decoder. This also removes the wire copy's `blockedReason?: string` drift. |
| `WireReceipt` in `wire.ts` | Use exported `ReminderChangeResult` in `sync.ts` and the scripted fixture. Preserve the `outcome` discriminant: applied has a row and optional `alreadyQueued`; blocked has a reason. Retain the existing runtime handling for a missing applied row or missing blocked reason. |
| `ReminderOpenResult` in `wire.ts`, the intersection in `native/recovery.ts`, and the optional-session shape in `sync.opened` | Use `Awaited<ReturnType<HarnessClient["openSession"]>>`, which resolves to the harness's `OpenResult`. The same result covers `createSession`; the harness declares optional receipt/page/deadline fields on it. Keep the existing session-identity fallback at the runtime boundary. |
| `ReminderPage` in `wire.ts` | Use exported `ReminderList` and, when needed, `ReminderListParams`. Keep the conversion from the first open page's `remindersNext` to `next`; keep cursor and restart policy unchanged. |
| `WireReminderEvent` in `wire.ts` | Derive the reminder cases from exported `ChannelEvent["event"]`, selecting the `reminder_*` discriminants. Apply a distributive type mapping from wire `type` to existing public `kind`; preserve the public union in `agent-conversation-contracts.ts` and the callback shape used by `factory.ts`, `native/controller.ts` and `native/host.ts`. |
| Deadline payload in `ReminderNotification` | Use the payload of exported `ReminderSessionEvent` (omit wire `type` for the existing local deadline payload). The channel/deadline routing envelope is library-owned and remains an adapter type for `notifications.ts`, `connection.ts`, `host-config.ts`, and the host. |
| `IdleStopResult` in `native/reminders/idle.ts` | Use exported `ConditionalStopResult` for the idle supervisor and host's in-flight stop promise. The method's parameter type is exported as `ConditionalStopParams`. |
| `WireChange` export, freeze/stage storage, and the live seam | It already aliases exported `ReminderChange`. Prefer direct imports outside the adapter where clearer. Keep the adapter's typed return and require the create/update/cancel constructions to remain assignable without casts, using the explicit return annotation and branch-level `satisfies` or a compile-time assertion. Keep frozen entries and serialization unchanged. |
| `initialize(description: unknown)` and the anonymous negotiated-limit shape in `sync.ts` | Derive the initialize description and its non-null `reminderLimits` from `HarnessClient["initialize"]`. The config in `limits.ts` is library-owned; its name mapping, runtime numeric checks and defaults remain. |
| Block-reason spellings in `schedule.ts` and string reasons in journal/service transport outcomes | Derive the known harness subset from `Extract<ReminderChangeResult, { outcome: "blocked" }>["reason"]`. Keep library-only local error codes and the journal's ability to store arbitrary reason strings, including local quarantine reasons and future wire reasons. Do not force those domains into the closed harness union. |
| `reminderRpc<WireReceipt>(client, "reminder/change", entry)` in `sync.dispatch` | `client.changeReminder(entry)`. Keep identity checks, serialized dispatch and receipt ordering. |
| `reminderRpc<{ reminder: WireReminder }>(client, "reminder/get", { id })` in `sync.refresh` | `client.getReminder({ id })`. Preserve channel filtering and `not_found` handling. |
| `reminderRpc<ReminderPage>(client, "reminder/list", params)` in `sync.sweep` | `client.listReminders(params)`. Keep omitted defaults, scope and cursor arguments. |
| `reminderRpc<IdleStopResult>(connection.client, "session/stop", params)` in `native/host.ts` | `connection.client.stopIfIdle(params)`. Keep the same `ifIdle` and window parameters; ordinary explicit stop still calls `stop()`. Remove `reminderRpc` once all four uses are replaced. |

`OpenResult`, `ReminderOpen`, `ReminderChannelEvent`, `ReminderBlockReason`,
`ReminderLimits`, `ReminderState` and `OneOffSchedule` are not individually
re-exported by the public client facade. The first five needed types are
available through the public method/event shapes above; the row state and
schedule are likewise available from exported `Reminder`. No new harness
export is required for this plan. Scripted peers that currently implement
generic `request` will expose the corresponding typed fixture methods
over the same fake handler. Existing assertions and runtime scenarios remain.

## Boundary risks and checks

- The harness union is exhaustive for the checked-in protocol, but a newer
  peer can still send an unknown string at runtime. Preserve it in the
  blocked result/journal and surface it to the consumer. Only known
  `stale` and `conflict` trigger their existing defect-specific handling.
  Add a test with a future block reason observed through the typed RPC
  boundary. Keep the existing missing-reason fallback separate from an
  unknown, present reason.
- Harness fields use canonical ISO text and numeric millisecond grace.
  Library fields use epoch milliseconds with a separate local expiry
  policy. Keep conversion in `wire.ts`, including `done` to `completed`,
  omitted default grace, explicit null, and the stored acceptance anchor.
  Preserve strict discriminated create/update/cancel payloads and
  byte-identical replay.
- The transport shim still receives untyped JSON. A compile-time mapping
  is not runtime validation. Keep its event allowlist, required-field checks,
  and behavior for unknown/malformed reminder event kinds. Keep both the
  shim and typed-client notification routes so production and injected
  stdio connections follow the same delivery rules as before.
- No harness source changes are planned and routines remain refused.
  Replace imports and calls within the existing host line budget (909);
  native controller baseline 591, ceiling 599, agent-session alpha
  baseline 4,527. Verify typecheck and plain `bun test` from a clean
  archive with `TMPDIR=/dev/shm`, all unchanged reminder behavior, 20
  runs of the joint file and 20 isolated runs of the new runtime test.
  Compare the characterization snapshots and protected file sizes.
