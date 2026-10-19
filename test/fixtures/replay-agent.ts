#!/usr/bin/env bun
// Scripted ACP agent that already holds sessions and replays them on session/load, like a harness does.
//
//   REPLAY_AGENT_FILE=/path/sessions.json   { "<sessionId>": [ <raw session/update objects, replayed in order> ] }
//   REPLAY_AGENT_NO_LOAD=1                  do not advertise loadSession
//   REPLAY_AGENT_NO_DELETE=1                do not advertise session/delete
//   REPLAY_AGENT_FAIL_DELETE=1              fail session/delete
//   REPLAY_AGENT_NO_LIST=1                  do not advertise session/list
//   REPLAY_AGENT_PAGE_SIZE=N                list sessions N at a time, with a cursor
//   REPLAY_AGENT_FAIL_RECAP=1               fail the prompt that asks the session to summarize itself
//
// A prompt that contains ECHO_OPENCODE_CONFIG is answered with the OPENCODE_CONFIG_CONTENT this process was started with.
//
// A session/load of an id that is not in the file fails (-32001, "session not found"), like a harness whose
// session was deleted. Prompts after a load or a new session answer with a fixed reply.

import { readFileSync, writeFileSync } from "node:fs";

const sessions: Record<string, unknown[]> = process.env.REPLAY_AGENT_FILE
  ? JSON.parse(readFileSync(process.env.REPLAY_AGENT_FILE, "utf8"))
  : {};
const noLoad = process.env.REPLAY_AGENT_NO_LOAD === "1";
const failRecap = process.env.REPLAY_AGENT_FAIL_RECAP === "1";
const noList = process.env.REPLAY_AGENT_NO_LIST === "1";
const noDelete = process.env.REPLAY_AGENT_NO_DELETE === "1";
const failDelete = process.env.REPLAY_AGENT_FAIL_DELETE === "1";
const pageSize = Number(process.env.REPLAY_AGENT_PAGE_SIZE ?? 0);
let counter = 1;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) handle(JSON.parse(raw));
  }
});
process.stdin.resume();

const send = (message: unknown): void => void process.stdout.write(`${JSON.stringify(message)}\n`);

function handle(message: any): void {
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: {
            loadSession: !noLoad,
            promptCapabilities: {},
            mcpCapabilities: {},
            sessionCapabilities: { ...(noList ? {} : { list: {} }), ...(noDelete ? {} : { delete: {} }) },
          },
          agentInfo: { name: "replay-agent", title: "Replay Agent" },
        },
      });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `new-${counter++}-${process.pid.toString(36)}`, configOptions: [] } });
      return;
    case "session/load": {
      const sessionId = String(message.params?.sessionId);
      const history = sessions[sessionId];
      if (!history) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: `session not found: ${sessionId}` } });
        return;
      }
      for (const update of history) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      }
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
      return;
    }
    case "session/delete": {
      const sessionId = String(message.params?.sessionId);
      if (failDelete || !(sessionId in sessions)) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: `cannot delete ${sessionId}` } });
        return;
      }
      delete sessions[sessionId];
      // Another process (the next listing) must see it gone, so the file is the source of truth.
      if (process.env.REPLAY_AGENT_FILE) writeFileSync(process.env.REPLAY_AGENT_FILE, JSON.stringify(sessions));
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    case "session/list": {
      const all = Object.keys(sessions);
      const start = message.params?.cursor ? Number(message.params.cursor) : 0;
      const slice = pageSize > 0 ? all.slice(start, start + pageSize) : all;
      const next = pageSize > 0 && start + pageSize < all.length ? String(start + pageSize) : undefined;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessions: slice.map((sessionId) => ({
            sessionId,
            cwd: message.params?.cwd ?? process.cwd(),
            title: `Session ${sessionId}`,
            updatedAt: "2026-10-05T00:00:00.000Z",
          })),
          ...(next ? { nextCursor: next } : {}),
        },
      });
      return;
    }
    case "session/prompt": {
      const sessionId = String(message.params?.sessionId);
      const asked = (message.params?.prompt ?? []).map((block: any) => block?.text ?? "").join("\n");
      const recap = /summarize this conversation for the memory/.test(asked);
      if (recap && process.env.REPLAY_AGENT_STALL_RECAP === "1") return;
      if (recap && failRecap) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "recap failed on purpose" } });
        return;
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `live-${counter++}`,
            content: { type: "text", text: /ECHO_OPENCODE_CONFIG/.test(asked)
              ? `ENV=${process.env.OPENCODE_CONFIG_CONTENT ?? "unset"}`
              : recap ? "RECAP: the user greeted and asked to read a.txt, which says kiwi." : "LIVE_REPLY" },
          },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: { totalTokens: 8, inputTokens: 3, outputTokens: 5 } } });
      return;
    }
    default:
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}
