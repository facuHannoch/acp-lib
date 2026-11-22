#!/usr/bin/env bun
// Adopt an existing session of a real harness: list its sessions, adopt one, store its history, and look at what
// was stored. Like smoke-tests/end-to-end: run it, and `agent.sqlite` appears in this directory.
//
//   bun smoke-tests/test12-adoption/index.ts
//
// By default it makes NO model call: listing, `session/load` and importing the replay do not need one. Set
// ACP_TEST12_RECAP=1 to also ask the session to summarize itself (one hidden turn, which spends tokens).
//
// Configuration (environment variables, all optional):
//   ACP_TEST12_ADAPTER=codex|opencode|...   default codex (any key of ADAPTERS)
//   ACP_TEST12_SESSION=ID                   the session to adopt (default: the first one listed)
//   ACP_TEST12_LAST=N                       import the last N turns (default 3; 0 imports nothing; "all" imports all)
//   ACP_TEST12_RECAP=1                      also make the recap (spends tokens)
//   ACP_TEST12_LIST_LIMIT=N                 how many sessions to list (default 10)
//   ACP_TEST12_DATA_DIR=PATH                where agent.sqlite goes (default: this directory)

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, Agent, type Adapter, type ConversationRecord } from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = (key: string): string | undefined => process.env[`ACP_TEST12_${key}`]?.trim() || undefined;
const adapterId = env("ADAPTER") ?? "codex";
const adapter = (ADAPTERS as Record<string, Adapter>)[adapterId];
if (!adapter) throw new Error(`unknown adapter: ${adapterId}`);
const dataDirectory = resolve(env("DATA_DIR") ?? here);
const databasePath = join(dataDirectory, "agent.sqlite");
const recap = env("RECAP") === "1";
const lastSetting = env("LAST") ?? "3";
const importHistory = lastSetting === "all" ? true : Number(lastSetting) === 0 ? false : { last: Number(lastSetting) };
const limit = Number(env("LIST_LIMIT") ?? 10);

await mkdir(dataDirectory, { recursive: true });
for (const suffix of ["", "-wal", "-shm", ".agent-owner.sqlite"]) await rm(`${databasePath}${suffix}`, { force: true });

const short = (text: string, max = 70): string => text.replace(/\s+/g, " ").slice(0, max);
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: databasePath },
  adapters: { [adapterId]: adapter },
  defaultAdapterId: adapterId,
  capture: { message: "content", tool_call: "content", thinking: "content", activity: "content" },
  conversationDefaults: { cwd: process.cwd(), permissions: { default: "ask" } },
});

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

try {
  console.log(`=== ${adapterId}: listing sessions (limit ${limit}) ===`);
  const sessions = await agent.conversations.listProviderSessions({ limit });
  console.log(`  ${sessions.length} session(s)`);
  for (const session of sessions) console.log(`    ${session.providerSessionId}  ${short(session.cwd, 40)}  "${short(session.title ?? "", 50)}"`);
  const chosen = env("SESSION") ?? sessions[0]?.providerSessionId;
  if (!chosen) throw new Error("no session to adopt: the provider lists none (set ACP_TEST12_SESSION)");

  console.log(`\n=== adopting ${chosen} (recap ${recap ? "on" : "off"}, history ${JSON.stringify(importHistory)}) ===`);
  const started = Date.now();
  const conversation = await agent.conversations.create({ adopt: { providerSessionId: chosen, importHistory, recap } });
  console.log(`  adopted in ${Date.now() - started}ms as ${conversation.id}`);

  const summary = await agent.conversations.get(conversation.id);
  check("stored as adopted, asking for that session", summary?.adopted === true && summary.adoptProviderSessionId === chosen);
  const active = await agent.persistence.providerSessions.active(conversation.id);
  check("the provider session is attached and recorded", active?.internalSessionId === chosen, active?.internalSessionId);

  const records: ConversationRecord[] = (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records as never;
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  console.log(`  stored records: ${[...counts].map(([kind, n]) => `${kind}×${n}`).join(" ") || "none"}`);
  const messages = records.filter((record): record is Extract<ConversationRecord, { kind: "message" }> => record.kind === "message");
  for (const message of messages) console.log(`    ${message.role}: ${short(String(message.content), 90)}`);
  if (importHistory) check("history was imported", messages.length > 0, `${messages.length} message(s)`);
  else check("nothing imported", messages.length === (recap ? 1 : 0));
  check("imported messages are marked", messages.every((message) => JSON.parse(message.metadata ?? "{}").imported === true || messages.length === 0));
  if (recap) {
    const recapMessage = messages.find((message) => JSON.parse(message.metadata ?? "{}").origin === "adoption_recap");
    check("the recap was stored", recapMessage !== undefined, short(String(recapMessage?.content ?? "none"), 100));
    check("the recap errors", !records.some((record) => record.kind === "error"));
  }

  const again = await agent.conversations.create({ adopt: { providerSessionId: chosen } }).catch((error: unknown) => error);
  check("adopting it again is refused, naming the owner", (again as { code?: string; ownedBy?: string[] })?.code === "provider_session_in_use"
    && (again as { ownedBy: string[] }).ownedBy[0] === conversation.id);

  const listed = await agent.conversations.listProviderSessions({ limit: Math.max(limit, 500) });
  const entry = listed.find((session) => session.providerSessionId === chosen);
  if (entry) check("the listing now says who owns it", entry.adoptedBy === conversation.id);
  else console.log(`  skip the listing check: ${chosen} is not among the first ${listed.length} sessions the provider lists`);

  await conversation.stop();
  const reopened = await agent.conversations.open(conversation.id);
  check("after stopping, it opens by loading the same session", reopened.providerSession === "loaded"
    && reopened.conversation.internalSessionId === chosen);
  console.log(`\n  database: ${databasePath}\n  conversation: ${conversation.id}`);
} catch (error) {
  failures += 1;
  console.log(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await agent.close().catch(() => undefined);
}
process.exit(failures > 0 ? 1 : 0);
