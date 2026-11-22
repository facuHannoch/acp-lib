#!/usr/bin/env bun
// What does a harness replay when a session is loaded (`session/load`)?
//
// Session adoption (.res/somelogs.md/9-22+/10-2-SPEC-adopt-provider-session.md) captures the replay and stores
// it, so it has to know what arrives: which update kinds, in what order, whether turns can be told apart,
// whether tool calls, thoughts and cancelled turns are replayed. Loading a session replays history and does NOT
// call the model, so this spends no tokens.
//
//   bun smoke-tests/session-replay-probe/index.ts
//
// Environment (all optional):
//   ACP_PROBE_SESSIONS=codex:ID,opencode:ID   sessions to load (default: the ones the test11-steerTurn runs left)
//   ACP_PROBE_LIST=1                          also list what `session/list` returns (the first 10) per adapter
//   ACP_PROBE_DATA_DIR=PATH                   where the raw replay JSON goes (default: this directory)
//
// The raw notifications of each session are written to <adapter>-<id>.json (git-ignored).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, AcpClient, type Adapter } from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.ACP_PROBE_DATA_DIR?.trim() || here);

const DEFAULTS = [
  // codex: s1 control (3 tool calls), s2 steer (cancelled turn + follow-up + memory question), s5 (cancelled mid-tool)
  "codex:01a0fbd4-2e78-7da0-974e-0daf98922217",
  "codex:01a0fbd4-4fcc-70c1-bfa7-6491c2774015",
  "codex:01a0fbd5-94ad-75c2-bc87-9242c44a9705",
  // opencode: s1 control, s2 steer, s4 cancelled text-only story
  "opencode:ses_f0448c705ffeAdw3pWqMK2GDVH",
  "opencode:ses_f0448a685ffelOkcLcKMP0wPn9",
  "opencode:ses_f04477984ffeq7sZPA3Zoi2q9H",
];
const targets = (process.env.ACP_PROBE_SESSIONS?.trim() ? process.env.ACP_PROBE_SESSIONS.split(",") : DEFAULTS).map((entry) => {
  const [adapter, ...rest] = entry.trim().split(":");
  return { adapter: adapter!, sessionId: rest.join(":") };
});

interface Update {
  readonly kind: string;
  readonly text?: string;
  readonly messageId?: string;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly title?: string;
}

function describe(notification: any): Update {
  const update = notification?.update ?? {};
  const kind = String(update.sessionUpdate ?? "unknown");
  const text = typeof update.content?.text === "string" ? update.content.text : undefined;
  return {
    kind,
    ...(text !== undefined ? { text } : {}),
    ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
    ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
    ...(typeof update.status === "string" ? { status: update.status } : {}),
    ...(typeof update.title === "string" ? { title: update.title } : {}),
  };
}

const short = (text: string | undefined, max = 70): string => (text ?? "").replace(/\s+/g, " ").slice(0, max);

/** Consecutive updates of the same kind, as `kind×n`, so the shape of a replay is readable. */
function runs(updates: readonly Update[]): string {
  const out: string[] = [];
  for (const update of updates) {
    const last = out.at(-1);
    const match = last?.match(/^(.*)×(\d+)$/);
    if (match && match[1] === update.kind) out[out.length - 1] = `${update.kind}×${Number(match[2]) + 1}`;
    else if (last === update.kind) out[out.length - 1] = `${update.kind}×2`;
    else out.push(update.kind);
  }
  return out.join(" → ");
}

/** Turns, derived the only way a replay allows: a user message after anything else starts a new turn. */
function turns(updates: readonly Update[]) {
  const result: { user: string; assistant: string; tools: number; thoughts: number; other: number }[] = [];
  let current: (typeof result)[number] | null = null;
  let previous = "";
  for (const update of updates) {
    if (update.kind === "user_message_chunk") {
      if (!current || previous !== "user_message_chunk") {
        current = { user: "", assistant: "", tools: 0, thoughts: 0, other: 0 };
        result.push(current);
      }
      current.user += update.text ?? "";
    } else if (current) {
      if (update.kind === "agent_message_chunk") current.assistant += update.text ?? "";
      else if (update.kind === "agent_thought_chunk") current.thoughts += 1;
      else if (update.kind === "tool_call") current.tools += 1;
      else if (update.kind !== "tool_call_update") current.other += 1;
    }
    previous = update.kind;
  }
  return result;
}

async function open(adapterName: string): Promise<AcpClient> {
  const adapter = (ADAPTERS as Record<string, Adapter>)[adapterName];
  if (!adapter) throw new Error(`unknown adapter: ${adapterName}`);
  const client = new AcpClient({ adapter, cwd: process.cwd(), permissions: { default: "ask" } });
  await client.connect();
  return client;
}

async function probe(client: AcpClient, adapter: string, sessionId: string): Promise<void> {
  console.log(`\n=== ${adapter} ${sessionId} ===`);
  const raw: unknown[] = [];
  const started = Date.now();
  try {
    await client.loadSession(sessionId, { onUpdate: (notification) => raw.push(notification) });
  } catch (error) {
    console.log(`  load failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const updates = raw.map(describe);
  const kinds = new Map<string, number>();
  for (const update of updates) kinds.set(update.kind, (kinds.get(update.kind) ?? 0) + 1);
  const withMessageId = updates.filter((update) => update.messageId).length;
  const distinctIds = new Set(updates.map((update) => update.messageId).filter(Boolean));
  console.log(`  loaded in ${Date.now() - started}ms; ${updates.length} update(s)`);
  console.log(`  kinds: ${[...kinds].map(([kind, count]) => `${kind}×${count}`).join(" ")}`);
  console.log(`  shape: ${runs(updates)}`);
  console.log(`  messageId on ${withMessageId}/${updates.length} updates, ${distinctIds.size} distinct`);
  const found = turns(updates);
  console.log(`  turns found by role alternation: ${found.length}`);
  found.forEach((turn, index) => {
    console.log(
      `    ${index + 1}. user "${short(turn.user)}" → assistant ${turn.assistant.length}ch "${short(turn.assistant)}" ` +
        `(tools ${turn.tools}, thoughts ${turn.thoughts}, other ${turn.other})`,
    );
  });
  // Tool calls fold by id: the announce says `pending`, the updates after it carry the final status and output.
  const calls = new Map<string, { title: string; states: string[]; input: boolean; output: boolean }>();
  for (const notification of raw as any[]) {
    const update = notification?.update ?? {};
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
    const call = calls.get(update.toolCallId) ?? { title: "", states: [], input: false, output: false };
    if (update.title) call.title = update.title;
    if (update.status) call.states.push(update.status);
    if (update.rawInput && Object.keys(update.rawInput).length > 0) call.input = true;
    if (update.rawOutput || update.content?.length) call.output = true;
    calls.set(update.toolCallId, call);
  }
  for (const call of calls.values()) {
    console.log(`  tool call: ${short(call.title, 50)} | ${call.states.join(">")} | input ${call.input} output ${call.output}`);
  }
  const thoughts = updates.filter((update) => update.kind === "agent_thought_chunk");
  if (thoughts.length > 0) console.log(`  thoughts: ${thoughts.length} chunk(s), first "${short(thoughts[0]!.text, 60)}"`);
  const file = join(dataDir, `${adapter}-${sessionId.replace(/[^\w.-]/g, "_")}.json`);
  await writeFile(file, JSON.stringify(raw, null, 2));
  console.log(`  raw: ${file}`);
}

await mkdir(dataDir, { recursive: true });
const byAdapter = new Map<string, string[]>();
for (const target of targets) byAdapter.set(target.adapter, [...(byAdapter.get(target.adapter) ?? []), target.sessionId]);

for (const [adapter, sessions] of byAdapter) {
  let client: AcpClient | undefined;
  try {
    client = await open(adapter);
    console.log(`\n##### ${adapter}: loadSession=${client.capabilities.agent.loadSession} list=${Boolean(client.capabilities.agent.sessionCapabilities.list)} resume=${Boolean(client.capabilities.agent.sessionCapabilities.resume)}`);
    if (process.env.ACP_PROBE_LIST) {
      const page = await client.listSessions().catch((error: unknown) => ({ sessions: [], error: String(error) }) as any);
      console.log(`  session/list: ${page.sessions.length} session(s)${page.error ? ` (${page.error})` : ""}`);
      for (const entry of page.sessions.slice(0, 10)) console.log(`    ${entry.sessionId} ${entry.cwd} "${short(entry.title, 50)}"`);
    }
    for (const sessionId of sessions) await probe(client, adapter, sessionId);
  } catch (error) {
    console.log(`\n##### ${adapter}: could not start (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    await client?.stop().catch(() => {});
  }
}
