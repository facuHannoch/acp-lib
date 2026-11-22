import { Database } from "bun:sqlite";
import { createInterface } from "node:readline";

const [path, mode] = process.argv.slice(2);
const send = (value: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "worker-peer" } });
  } else if (method === "session/prompt") {
    const database = new Database(path!, { readonly: true });
    try {
      const row = database.query(`SELECT assignment_id, original_destination, originating_policies
        FROM worker_assignments WHERE assignment_id = 'assignment-42' AND operation_id <> ''`).get();
      if (JSON.stringify(row) !== JSON.stringify({
        assignment_id: "assignment-42", original_destination: "owner-channel", originating_policies: '["guest"]',
      })) throw new Error("ACP prompt arrived before assignment provenance committed");
    } finally { database.close(); }
    send({ method: "session/update", params: { sessionId: "worker-peer",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Exact worker result" } } } });
    if (mode !== "partial") send({ id, result: { stopReason: "end_turn" } });
  }
}
