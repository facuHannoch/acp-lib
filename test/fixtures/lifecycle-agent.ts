#!/usr/bin/env bun
/**
 * Disposable ACP fault fixture. State belongs to the explicitly supplied temporary directory.
 *
 * A prompt containing `[lifecycle:<mode>]` (or `LIFECYCLE_MODE`) selects the behaviour:
 * `silent` and `ignore` never answer, `partial` sends one chunk and then nothing (all three ignore
 * cancel), `permission` asks for permission, `tool` runs a tool for `LIFECYCLE_TOOL_MS` or until
 * `LIFECYCLE_TOOL_GATE_FILE` exists (and, with
 * `LIFECYCLE_END_GATE_FILE`, ends the turn after its last chunk only once that file exists, so a
 * test can release the end on an event it observed). Any other prompt
 * echoes the process id and the session's history, so a test can kill the process and check context.
 *
 * Faults: `LIFECYCLE_HANG_CONTROL` never answers that one method; `LIFECYCLE_HOLD_CONTROL` holds that
 * method until the file `LIFECYCLE_HOLD_FILE` exists, then answers it normally; `LIFECYCLE_FAIL_CONTROL` answers it
 * with an error; `LIFECYCLE_FAIL_LOAD=1` reports
 * every session missing; while the file `LIFECYCLE_FAIL_LOAD_FILE` exists, loads fail with an internal
 * error although the session exists, and each failed load appends a line to it.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const file = process.env.LIFECYCLE_STATE;
if (process.env.LIFECYCLE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});
const sessions: Record<string, string[]> = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

const save = () => {
  if (file) writeFileSync(file, JSON.stringify(sessions));
};
const send = (value: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value as object }) + "\n");
const reply = (id: unknown, result: unknown) => send({ id, result });
const update = (sessionId: string, update: unknown) => send({ method: "session/update", params: { sessionId, update } });
const text = (sessionId: string, value: string) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });

let pending: { id: unknown; session: string; ignore: boolean } | null = null;
let permission: { promptId: unknown; session: string; id: string } | null = null;

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.once("end", () => process.exit(0));
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (raw.trim()) handle(JSON.parse(raw));
  }
});

function handle(m: any): void {
  if (m.id === permission?.id && !m.method) {
    const outcome = m.result?.outcome?.outcome;
    text(permission!.session, `permission=${outcome}`);
    reply(permission!.promptId, { stopReason: outcome === "cancelled" ? "cancelled" : "end_turn" });
    permission = null;
    pending = null;
    return;
  }
  if (process.env.LIFECYCLE_HANG_CONTROL === m.method) {
    if (process.env.LIFECYCLE_REPORT_HANG === "1") console.error(`hang:${m.method}:${process.pid}`);
    return;
  }
  const holdFile = process.env.LIFECYCLE_HOLD_FILE;
  if (holdFile && process.env.LIFECYCLE_HOLD_CONTROL === m.method && !existsSync(holdFile)) {
    setTimeout(() => handle(m), 5);
    return;
  }
  if (process.env.LIFECYCLE_FAIL_CONTROL === m.method) {
    send({ id: m.id, error: { code: -32603, message: "internal error" } });
    return;
  }
  switch (m.method) {
    case "initialize":
      reply(m.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, delete: {} } },
        agentInfo: { name: "lifecycle-fixture" },
      });
      return;
    case "session/new": {
      const id = randomUUID();
      sessions[id] = [];
      save();
      reply(m.id, { sessionId: id });
      return;
    }
    case "session/load": {
      if (!sessions[m.params.sessionId] || process.env.LIFECYCLE_FAIL_LOAD === "1") {
        send({ id: m.id, error: { code: -32001, message: "session not found" } });
        return;
      }
      // A failure that is not "session missing": the request fails while the session still exists.
      if (process.env.LIFECYCLE_FAIL_LOAD_FILE && existsSync(process.env.LIFECYCLE_FAIL_LOAD_FILE)) {
        appendFileSync(process.env.LIFECYCLE_FAIL_LOAD_FILE, "load\n");
        send({ id: m.id, error: { code: -32603, message: "internal error" } });
        return;
      }
      for (const value of sessions[m.params.sessionId]!) text(m.params.sessionId, value);
      reply(m.id, {});
      return;
    }
    case "session/list":
      reply(m.id, { sessions: [] });
      return;
    case "session/delete":
      delete sessions[m.params.sessionId];
      save();
      reply(m.id, {});
      return;
    case "session/prompt":
      prompt(m);
      return;
    case "session/cancel":
      if (pending && !pending.ignore && !permission) {
        reply(pending.id, { stopReason: "cancelled" });
        pending = null;
      }
      return;
    default:
      if (m.id !== undefined) reply(m.id, {});
  }
}

function prompt(m: any): void {
  const session = String(m.params.sessionId);
  const asked = m.params.prompt.map((block: any) => block.text ?? "").join("\n");
  sessions[session] ??= [];
  sessions[session]!.push(asked);
  save();
  const mode = /\[lifecycle:(\w+)\]/.exec(asked)?.[1] ?? process.env.LIFECYCLE_MODE;
  pending = { id: m.id, session, ignore: mode === "ignore" || mode === "silent" || mode === "partial" };
  if (mode === "silent" || mode === "ignore") return;
  if (mode === "partial") {
    text(session, "partial reply");
    return;
  }
  if (mode === "permission" || mode === "readpermission") {
    const ask = () => {
      if (pending?.id !== m.id) return;
      const gate = mode === "readpermission" ? process.env.LIFECYCLE_PERMISSION_GATE_FILE : undefined;
      if (gate && !existsSync(gate)) { setTimeout(ask, 5); return; }
      permission = { promptId: m.id, session, id: `permission-${randomUUID()}` };
      send({
        id: permission.id,
        method: "session/request_permission",
        params: {
          sessionId: session,
          toolCall: { toolCallId: "permission-tool", title: "permission test",
            ...(mode === "readpermission" ? { kind: "read", rawInput: { path: "README.md" } } : {}) },
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        },
      });
    };
    ask();
    return;
  }
  if (mode === "tool" || mode === "natural") {
    update(session, { sessionUpdate: "tool_call", toolCallId: "sleep", title: "sleep", status: "in_progress" });
    const toolGate = process.env.LIFECYCLE_TOOL_GATE_FILE;
    const finishTool = () => {
      if (pending?.id !== m.id) return;
      if (toolGate && !existsSync(toolGate)) {
        setTimeout(finishTool, 5);
        return;
      }
      if (mode === "natural") {
        text(session, "natural final result");
        reply(m.id, { stopReason: "end_turn" });
        pending = null;
        return;
      }
      update(session, { sessionUpdate: "tool_call_update", toolCallId: "sleep", status: "completed" });
      text(session, "tool finished");
      const end = () => {
        reply(m.id, { stopReason: "end_turn" });
        pending = null;
      };
      const gate = process.env.LIFECYCLE_END_GATE_FILE;
      if (!gate) {
        end();
        return;
      }
      // Wait for the test's release; a cancel while waiting answers the prompt instead.
      const waitForGate = () => {
        if (pending?.id !== m.id) return;
        if (existsSync(gate)) end();
        else setTimeout(waitForGate, 2);
      };
      waitForGate();
    };
    if (toolGate) finishTool();
    else setTimeout(finishTool, Number(process.env.LIFECYCLE_TOOL_MS ?? 150));
    return;
  }
  text(session, `pid=${process.pid}; history=${sessions[session]!.join(" | ")}`);
  reply(m.id, { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });
  pending = null;
}
