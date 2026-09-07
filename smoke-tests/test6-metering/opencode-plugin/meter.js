// Probe: record every assistant message OpenCode produces, with its own tokens and cost.
// ACP collapses a whole turn into one usage report; this shows what it hides.
import { appendFileSync } from "node:fs";

const OUT = process.env.METER_OUT ?? "/tmp/meter.jsonl";

export const MeterPlugin = async () => ({
  event: async ({ event }) => {
    if (event?.type !== "message.updated") return;
    const info = event.properties?.info;
    if (!info || info.role !== "assistant") return;
    appendFileSync(
      OUT,
      JSON.stringify({
        messageID: info.id,
        sessionID: info.sessionID,
        providerID: info.providerID,
        modelID: info.modelID,
        summary: info.summary ?? false,
        completed: info.time?.completed ?? null,
        cost: info.cost,
        tokens: info.tokens,
      }) + "\n",
    );
  },
});
