import { createInterface } from "node:readline/promises";
import { localConnection } from "../../runtime/config/development.ts";
import { sendLocal } from "../protocol/local.ts";

export async function chat(channelId: string, participantId: string) {
  const { socketPath } = localConnection();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Channel ${channelId}, participant ${participantId}. Type /exit to disconnect.`);
  try {
    while (true) {
      let text: string;
      try { text = await terminal.question("> "); }
      catch { break; }
      if (text.trim() === "/exit") break;
      if (!text.trim()) continue;
      try { console.log(await sendLocal(socketPath, { channelId, participantId, text })); }
      catch (error) { console.error(String(error)); }
    }
  } finally {
    // Closing the terminal disconnects this client; the agent owns channel state.
    terminal.close();
  }
}
