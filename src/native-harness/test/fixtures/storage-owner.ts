// Child process for SQLite ownership and crash tests. Holds a real owner,
// commits a known amount of work, reports readiness, then waits to be killed.
import { createSqliteStorageAdapter } from "../../src/state/storage/sqlite.ts";

const [path, mode] = process.argv.slice(2);
const opened = createSqliteStorageAdapter(path!).open({ mode: "create", identity: { sessionId: "s1", compatibilityKey: "k1" } });
if (!opened.ok) { console.log(`error ${opened.error.code}`); process.exit(1); }
const s = opened.value;
s.acceptItem({ itemId: "taken", kind: "participant_message", channelId: "c1", senderId: "ana", text: "run the tool" });
const begun = s.beginTurn("c1");
if (!begun.ok || !begun.value) process.exit(1);
const turnId = begun.value.turn.turnId;
s.appendMessage(turnId, { role: "assistant", content: null, calls: [{ id: "done", name: "echo", arguments: "{}" }, { id: "effect", name: "echo", arguments: "{}" }] });
s.appendMessage(turnId, { role: "tool", callId: "done", content: "recorded" });
s.acceptItem({ itemId: "pending", kind: "participant_message", channelId: "c1", senderId: "ana", text: "never taken" });
if (mode === "suspending") s.beginSuspend();
console.log("ready");
setInterval(() => {}, 1000);
