#!/usr/bin/env bun
/** Disposable ACP fault fixture. State belongs to the explicitly supplied temporary directory. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const file = process.env.LIFECYCLE_STATE;
const sessions: Record<string, string[]> = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const save = () => { if (file) writeFileSync(file, JSON.stringify(sessions)); };
const send = (value: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value as object }) + "\n");
const reply = (id: unknown, result: unknown) => send({ id, result });
const update = (sessionId: string, update: unknown) => send({ method: "session/update", params: { sessionId, update } });
const text = (sessionId: string, value: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
let pending: { id: unknown; session: string; ignore: boolean } | null = null;
let permission: { promptId: unknown; session: string; id: string } | null = null;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (raw.trim()) handle(JSON.parse(raw));
  }
});
function handle(m: any): void {
  if (m.id === permission?.id && !m.method) {
    text(permission!.session, `permission=${m.result?.outcome?.outcome}`);
    reply(permission!.promptId, { stopReason: m.result?.outcome?.outcome === "cancelled" ? "cancelled" : "end_turn" });
    permission = null; pending = null; return;
  }
  if (process.env.LIFECYCLE_HANG_CONTROL === m.method) return;
  switch (m.method) {
    case "initialize": reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } }, agentInfo: { name: "lifecycle-fixture" } }); return;
    case "session/new": {
      const id = randomUUID(); sessions[id] = []; save(); reply(m.id, { sessionId: id }); return;
    }
    case "session/load": {
      if (!sessions[m.params.sessionId] || process.env.LIFECYCLE_FAIL_LOAD === "1") { send({ id: m.id, error: { code: -32001, message: "session not found" } }); return; }
      const interval = Number(process.env.LIFECYCLE_REPLAY_INTERVAL ?? 0);
      const history = sessions[m.params.sessionId]!;
      if (interval) {
        history.forEach((value, i) => setTimeout(() => text(m.params.sessionId, value), interval * (i + 1)));
        setTimeout(() => reply(m.id, {}), interval * (history.length + 1));
      } else { for (const value of history) text(m.params.sessionId, value); reply(m.id, {}); }
      return;
    }
    case "session/list": reply(m.id, { sessions: [] }); return;
    case "session/prompt": {
      const session = String(m.params.sessionId);
      const asked = m.params.prompt.map((b: any) => b.text ?? "").join("\n");
      sessions[session] ??= []; sessions[session]!.push(asked); save();
      const mode = /\[lifecycle:(\w+)\]/.exec(asked)?.[1] ?? process.env.LIFECYCLE_MODE;
      pending = { id: m.id, session, ignore: mode === "ignore" || mode === "silent" || mode === "partial" };
      if (mode === "silent" || mode === "ignore") return;
      if (mode === "partial") { text(session, "partial reply"); return; }
      if (mode === "permission") {
        permission = { promptId: m.id, session, id: `permission-${randomUUID()}` };
        send({ id: permission.id, method: "session/request_permission", params: { sessionId: session,
          toolCall: { toolCallId: "permission-tool", title: "permission test" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } }); return;
      }
      if (mode === "tool") {
        update(session, { sessionUpdate: "tool_call", toolCallId: "sleep", title: "sleep", status: "in_progress" });
        setTimeout(() => {
          if (pending?.id !== m.id) return;
          update(session, { sessionUpdate: "tool_call_update", toolCallId: "sleep", status: "completed" });
          text(session, "tool finished"); reply(m.id, { stopReason: "end_turn" }); pending = null;
        }, Number(process.env.LIFECYCLE_TOOL_MS ?? 150)); return;
      }
      text(session, `pid=${process.pid}; history=${sessions[session]!.join(" | ")}`);
      reply(m.id, { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } }); pending = null; return;
    }
    case "session/cancel":
      if (pending && !pending.ignore && !permission) { reply(pending.id, { stopReason: "cancelled" }); pending = null; }
      return;
    default: if (m.id !== undefined) reply(m.id, {});
  }
}
