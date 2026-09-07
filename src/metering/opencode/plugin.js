// The metering plugin acp-lib installs into a managed OpenCode profile.
//
// Ships as plain JS because OpenCode loads it, not us: it runs inside the harness process
// and must not depend on this library's build.
//
// Why it exists: ACP reports ONE model inference per prompt, while a turn with tool calls
// runs several and the provider bills all of them. Measured on opencode-go/kimi-k2.6, a
// three-tool-call turn billed 3.43x what ACP reported. OpenCode emits one assistant
// message per inference, each carrying its own cost and normalized token counts, so
// observing them here recovers exactly what ACP hides.
//
// Configured entirely through env vars set by the parent at spawn time:
//   ACP_METER_URL     loopback endpoint to POST to
//   ACP_METER_TOKEN   shared secret, echoed in a header
//   ACP_METER_DEBUG   optional; log delivery failures to stderr

const URL_ = process.env.ACP_METER_URL;
const TOKEN = process.env.ACP_METER_TOKEN;
const DEBUG = process.env.ACP_METER_DEBUG === "1";

function warn(message, error) {
  if (DEBUG) process.stderr.write(`[acp-meter] ${message}: ${String(error)}\n`);
}

async function post(body) {
  if (!URL_ || !TOKEN) return;
  try {
    await fetch(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acp-meter-token": TOKEN },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Never throw into the harness: a metering channel that breaks the agent is worse
    // than one that goes quiet. The parent detects silence through its own handshake.
    warn("delivery failed", error);
  }
}

// A per-session counter so the parent can tell a quiet channel from a lossy one. Without
// it a dropped POST is indistinguishable from an inference that never happened, and the
// operation would still be reported as completely attributed.
const sequence = new Map();

export const AcpMeteringPlugin = async ({ directory, worktree }) => {
  // Announced at startup so the parent can tell "plugin never loaded" from "no inferences
  // happened yet" — the distinction billing-grade metering depends on.
  await post({ type: "hello", pid: process.pid, directory, worktree, at: Date.now() });

  return {
    event: async ({ event }) => {
      if (event?.type !== "message.updated") return;
      const info = event.properties?.info;
      if (!info || info.role !== "assistant") return;
      // `message.updated` fires repeatedly while a message streams; only the completed
      // state carries final token counts. Earlier ones report zeros and would understate.
      if (!info.time?.completed) return;

      const next = (sequence.get(info.sessionID) ?? 0) + 1;
      sequence.set(info.sessionID, next);

      await post({
        type: "inference",
        sequence: next,
        messageID: info.id,
        sessionID: info.sessionID,
        providerID: info.providerID,
        modelID: info.modelID,
        // True for compaction summaries — an inference no user prompt asked for, and
        // exactly the kind ACP never surfaces.
        summary: info.summary === true,
        completedAt: info.time.completed,
        cost: info.cost,
        tokens: info.tokens,
      });
    },
  };
};
