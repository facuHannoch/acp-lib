#!/usr/bin/env bun
// Scripted ACP agent for steer-smoke.ts: free, deterministic, and cancellable.
//
// It exists to validate the runner without spending tokens, and later to serve as the
// fixture for steering unit tests. It does NOT model any real harness; what real harnesses
// do on cancel is what the smoke test measures.
//
// Behaviour is selected by substrings in the prompt (see `route`). Cancel behaviour is
// configurable through the environment:
//
//   STEER_AGENT_CANCEL_USAGE=none|partial   usage on a cancelled turn (default none)
//   STEER_AGENT_KILL_TOOL=1|0               whether a cancel kills the running tool (default 1)
//   STEER_AGENT_IGNORE_CANCEL=1             ignore session/cancel, so the turn ends normally (a cancel that
//                                           loses the race with the end of the turn)

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORDS = [
  { file: "a.txt", word: "kiwi" },
  { file: "b.txt", word: "banana" },
  { file: "c.txt", word: "fig" },
];
const cancelUsage = process.env.STEER_AGENT_CANCEL_USAGE ?? "none";
const killTool = process.env.STEER_AGENT_KILL_TOOL !== "0";
const ignoreCancel = process.env.STEER_AGENT_IGNORE_CANCEL === "1";

interface Active {
  readonly id: unknown;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  cancelled: boolean;
  tokens: number;
  readonly onCancel: Array<() => void>;
}

const sessions = new Map<string, { cwd: string; read: string[]; active: Active | null }>();
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

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
}

function handle(message: any): void {
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: {} },
          agentInfo: { name: "steer-agent", title: "Steer Smoke Agent" },
        },
      });
      return;
    case "session/new": {
      const sessionId = `steer-${counter++}-${process.pid.toString(36)}`;
      sessions.set(sessionId, { cwd: String(message.params?.cwd ?? process.cwd()), read: [], active: null });
      // Like codex-acp: a vendor extension notification the client does not model.
      send({ jsonrpc: "2.0", method: "_vendor/status_update", params: { status: "ready" } });
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: [] } });
      return;
    }
    case "session/cancel": {
      const session = sessions.get(String(message.params?.sessionId));
      const active = session?.active;
      if (!active || active.cancelled || ignoreCancel) return;
      active.cancelled = true;
      for (const timer of active.timers) clearTimeout(timer);
      for (const hook of active.onCancel) hook();
      send({
        jsonrpc: "2.0",
        id: active.id,
        result: {
          stopReason: "cancelled",
          ...(cancelUsage === "partial"
            ? { usage: { totalTokens: active.tokens, inputTokens: 1, outputTokens: active.tokens - 1 } }
            : {}),
        },
      });
      session.active = null;
      return;
    }
    case "session/prompt":
      prompt(message);
      return;
    default:
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
}

function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => (block as { text?: string }).text ?? "").join("\n");
}

function prompt(message: any): void {
  const sessionId = String(message.params?.sessionId);
  const session = sessions.get(sessionId);
  if (!session) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown session" } });
    return;
  }
  const active: Active = { id: message.id, timers: new Set(), cancelled: false, tokens: 10, onCancel: [] };
  session.active = active;
  const text = promptText(message.params?.prompt);

  const later = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      active.timers.delete(timer);
      if (!active.cancelled) fn();
    }, ms);
    active.timers.add(timer);
  };
  const say = (chunk: string): void => {
    active.tokens += 2;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  };
  const finish = (): void => {
    if (active.cancelled) return;
    session.active = null;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn", usage: { totalTokens: active.tokens, inputTokens: 5, outputTokens: active.tokens - 5 } },
    });
  };
  const tool = (toolCallId: string, title: string, status: string): void =>
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, kind: "read", status });
  const toolDone = (toolCallId: string, output: string, status = "completed"): void =>
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status, rawOutput: output });

  const route = routeOf(text);

  if (route === "sequential") {
    // One tool call per model step, with an inference-sized gap between steps.
    let delay = 100;
    WORDS.forEach(({ file, word }, index) => {
      later(delay, () => tool(`read-${index}`, `read ${file}`, "in_progress"));
      later(delay + 150, () => {
        session.read.push(word);
        toolDone(`read-${index}`, word);
      });
      delay += 150 + 400;
    });
    later(delay, () => {
      say(answer(session.read, text));
      finish();
    });
  } else if (route === "parallel") {
    // Like Codex: the model decided on a batch, but each call is announced only when it starts, and
    // the next one starts within milliseconds of the previous one finishing. Tool time is longer
    // when the prompt asks for `sleep 3`.
    const toolMs = /sleep 3/.test(text) ? 3000 : 100;
    let at = 50;
    WORDS.forEach(({ file, word }, index) => {
      later(at, () => tool(`par-${index}`, `read ${file}`, "in_progress"));
      later(at + toolMs, () => {
        session.read.push(word);
        toolDone(`par-${index}`, word);
      });
      at += toolMs + 5;
    });
    later(at + 400, () => {
      say(answer(session.read, text));
      finish();
    });
  } else if (route === "story") {
    for (let index = 0; index < 40; index += 1) {
      later(30 * (index + 1), () => say(`Ottoline watched the fog, part ${index}. `));
    }
    later(30 * 42, finish);
  } else if (route === "sleep") {
    later(50, () => tool("sleep-0", "shell: sleep 20", "in_progress"));
    const path = join(session.cwd, "done.txt");
    const survivor = setTimeout(async () => {
      await writeFile(path, "done\n").catch(() => {});
      if (!active.cancelled) {
        toolDone("sleep-0", "done");
        say("done");
        finish();
      }
    }, 20_000);
    if (killTool) active.onCancel.push(() => clearTimeout(survivor));
  } else if (route === "ok") {
    later(40, () => say("OK"));
    later(90, finish);
  } else if (route === "memory") {
    later(40, () => say(session.read[0] ?? "unknown"));
    later(60, finish);
  } else if (route === "exists") {
    later(40, async () => {
      const exists = await Bun.file(join(session.cwd, "done.txt")).exists();
      say(exists ? "done.txt exists" : "done.txt does not exist");
      finish();
    });
  } else if (/length/i.test(text)) {
    // A follow-up that arrives after a cancel: the agent picks the task back up, reading
    // whatever it had not read yet, and answers with the new instruction applied.
    later(60, () => {
      for (const { word } of WORDS) if (!session.read.includes(word)) session.read.push(word);
      say(answer(session.read, text));
      finish();
    });
  } else if (/Summarize in one sentence/i.test(text)) {
    later(40, () => say("Ottoline, the lighthouse keeper, watched the early fog."));
    later(60, finish);
  } else {
    later(40, () => say(`echo: ${text.slice(0, 80)}`));
    later(80, finish);
  }
}

function routeOf(text: string): string {
  if (/single step using parallel|parallel tool calls/i.test(text)) return "parallel";
  if (/one at a time/i.test(text)) return "sequential";
  if (/lighthouse keeper/i.test(text)) return "story";
  if (/sleep 20/i.test(text)) return "sleep";
  if (/just the word OK/i.test(text)) return "ok";
  if (/What did a\.txt contain/i.test(text)) return "memory";
  if (/Does done\.txt exist/i.test(text)) return "exists";
  return "other";
}

function answer(read: readonly string[], text: string): string {
  const words = read.length > 0 ? read : WORDS.map((entry) => entry.word);
  if (/only report the length of the longest|only the length of the longest/i.test(text)) {
    return "banana (6)";
  }
  if (/length/i.test(text)) return words.map((word) => `${word} (${word.length})`).join(", ");
  return words.join(", ");
}
