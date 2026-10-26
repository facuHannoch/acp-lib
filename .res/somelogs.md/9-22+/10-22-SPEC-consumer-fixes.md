Here are the four in plainer terms, with examples. Two corrections from checking the code: on 10, I said the runtime's per-item table is rebuilt on reopen, and it isn't. On 6, the fix needs one caveat.

---

### 5. Which operation the raw protocol lines are filed under

**Protocol lines** are the raw ACP messages we log when the `protocol` capture is on (`session/prompt`, each `session/update`, and so on). Each line is stamped with the id of "the operation running right now". That value comes from one field set by the queue.

Suppose a handoff runs, with id `H`. To do its work it runs an internal inference, which has its own id `aii-123`:

```
records the inference writes  →  operationId: aii-123
raw protocol lines meanwhile  →  operationId: H        (the queue item)
```

So if a consumer asks "everything for `aii-123`", they get the inference's messages but not its raw lines. Those sit under `H`. Things that run outside the queue (recaps, recovery seeding, adoption) get raw lines with **no** id at all.

**Fix idea:** when an inner operation starts, it sets "running now" to its own id, and puts the old one back when it ends. There's one catch: if a recap can run *at the same time* as a turn, a single "running now" value can't be right for both. That's why I'd check whether that overlap happens first.

It's low priority, since only debugging uses these lines.

---

### 6. Tool calls inheriting an old operation

**Why the map exists:** sometimes a tool's final update ("completed") arrives after its turn has ended, during the next turn. Without the map, that update would be filed under the *new* turn. So we remember `toolCallId → operation that announced it`, and a late update looks it up. Entries are removed when the tool reaches completed or failed.

**The problem:** the key is only the tool id.

```
turn A: tool "tool-1" announced, never gets a final update   → map: tool-1 → A
turn B: harness announces a NEW tool, also called "tool-1"   → looks up map → filed under A ✗
```

Real harnesses use unique ids (`toolu_…`, `call_…`), so it's unlikely in practice. Our test fixtures do reuse `tool-1`, though.

**Fix:** when a tool is *announced*, it belongs to the current turn, so overwrite the map entry. Only *updates* look up the map. The caveat I found: Claude announces every call **twice** (`src/activity.ts:358`: once with empty input, then again with the real input). Both announcements come in the same turn, so overwriting with the same turn's id is harmless.

---

### 7. Timeline items keyed by a field that isn't always there

The **timeline** (`timeline-reconcile.ts`) turns the records into the list of items a UI shows. Several records for the same tool call (announced, input, completed) are merged into **one item** by a key:

```
key = "<operationId>:" + toolCallId
```

That `operationId` is read from the **old place, `metadata.operationId`**, not from the new `operationId` field this branch added. If metadata doesn't have it, the key is just `toolCallId`. Then:

```
turn A: tool-1   → key "tool-1"
turn B: tool-1   → key "tool-1"   → both merged into ONE timeline item ✗
```

**Fix:** read the new field first and fall back to metadata. That's a one-line change.

**Why I hedged:** the key *is* the item's id, and a consumer may have stored item ids. If some record has the new field but not the metadata key, its key changes from `"tool-1"` to `"A:tool-1"` after the upgrade. A consumer comparing against stored ids would then see a "new" item. If metadata always has it too (I think it does), nothing changes. A test can confirm that.

---

### 10. Where `startedAt` comes from

When an item first appears (a message, or a tool call), we note the time. Every later update of that item reports that time as `startedAt`. The note lives in a Map in memory (`agent-conversation-presentation.ts:60`). That causes two problems:

1. **It never shrinks.** It holds one entry per item for the whole conversation. That's minor.
2. **It's lost on reopen.** Say a tool started at 10:00, the conversation was closed and reopened, and its update arrives at 10:05. The update then reports `startedAt: 10:05`. Only cases that straddle a reopen are affected.

**Correction:** I said the runtime already has a per-item table (`presentationStates`, used for `position`/`revision`) that gets rebuilt on reopen. It doesn't get rebuilt; it starts empty too. So `position` probably has the same reopen problem.

**Revised fix:** move `startedAt` into that table, so there's one per-item record instead of two. When a transcript is reopened, rebuild the table from the file (the first record of each item gives both `position` and `startedAt`). That fixes the reopen case for both fields. Shrinking it can wait.

---

To be sure about "ok for the others": shall I go ahead and implement 1, 2, 3, 4, 8 and 9 plus the tests, and hold 5, 6, 7 and 10 until you've decided on them?







---





  Still open on the list:
  - paging by turns;
  - messages made of parts (the remaining requirements items);
  - automatic rotation;
  - SQLite crash marker;
  - SQLite settings restore (low priority);
  - OpenCode's compaction summary showing up as reply text;
  - review items:
    - 11: the schema-15 upgrade copies the whole records table, accepted for now;
    - 14: steers only take effect between tool calls.

  My suggestion: merge into beta now. Then either do the real-harness run, or start the "messages made of parts" design, since it covers
  the largest share of what's left from the requirements.
