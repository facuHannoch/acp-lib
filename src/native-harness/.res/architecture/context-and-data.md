# Context and data

| Layer | Responsibility |
| --- | --- |
| Storage | Commit inbox items, timeline entries, turn and channel state, and model-call records. |
| Queries | Read neutral storage snapshots. The protocol projects revisioned status and load views, message pages, and model-call records. |
| Context builder | Render a fresh inference request for the active turn from the stored timeline and system prompt. |

The timeline is the common record for all channels. It orders events and
attributes them to a sender, channel, and turn. A pending input lives in the
inbox and joins the timeline when taken. The agent can have several inference
requests in flight, each built from the timeline as it existed when that
iteration started. Later entries are available at a later inference boundary.

The [context builder](../../src/capabilities/context/build.ts) combines the
system prompt, channel and participant labels, attributed shared history,
and the active turn's native messages. The active turn is excluded from the
shared-history block so its tool calls and results appear once as paired
messages. Notices carry source attribution. Opaque provider state stays out of
shared text. Tool definitions are a separate model-request field.

The current builder includes other channels' history and tool result content.
Bounded recall, compaction, and history access rules remain open. The tool
permission gate governs execution; shared history has its own visibility
design to complete. See the [work index](../docs/WORK.md).

The development inspector's **Live context** tab shows a rendering of the
current shared base. **Channels** shows captured inference requests and
results for individual turns. These are distinct data sources. A current
rendering can change while an older captured inference request stays fixed.
The inspector also reads stored model-call records after SQLite reopen.
