import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";

const [path, mode, assignmentId = "assignment-42", originalDestination = "owner-channel"] = process.argv.slice(2);
const send = (value: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
let interruptedPrompt: number | undefined;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "worker-peer" } });
  } else if (method === "session/cancel" && interruptedPrompt !== undefined) {
    send({ id: interruptedPrompt, result: { stopReason: "cancelled" } });
    interruptedPrompt = undefined;
  } else if (method === "session/prompt") {
    const database = new Database(path!, { readonly: true });
    try {
      const row = database.query(`SELECT assignment_id, original_destination, originating_policies
        FROM worker_assignments WHERE assignment_id = ? AND message_id <> ''`).get(assignmentId);
      if (JSON.stringify(row) !== JSON.stringify({
        assignment_id: assignmentId, original_destination: originalDestination, originating_policies: '["guest"]',
      })) throw new Error("ACP prompt arrived before assignment provenance committed");
    } finally { database.close(); }
    if (mode === "fail") {
      send({ id, error: { code: -32000, message: "fake-secret-" + "x".repeat(200) } });
      continue;
    }
    send({ method: "session/update", params: { sessionId: "worker-peer",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: mode === "blank" ? " " : "Exact worker result" } } } });
    if (mode === "interrupt") interruptedPrompt = id;
    else if (mode !== "partial") send({ id, result: { stopReason: "end_turn" } });
  }
}
