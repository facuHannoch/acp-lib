import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import type { ManagedConfig } from "../src/contracts/config-permissions.ts";
import type { SessionStorage } from "../src/contracts/storage.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (): ManagedConfig => ({ version: 1, system: "owner", model: { protocol: "scripted", script: "fixture" }, defaultPolicy: "__legacy_allow",
  policies: { __legacy_allow: { fallback: "deny", tools: {} } } });
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("timeout"); }
function services(effects: string[]) { return { tools: [], model: async (messages: readonly { role: string }[]) => messages.at(-1)?.role === "tool"
  ? { role: "assistant" as const, content: "done", calls: [] }
  : { role: "assistant" as const, content: null, calls: [{ id: "c", name: "work", arguments: "{}" }] },
  executeTool: async () => { effects.push("ran"); return "ok"; } }; }

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: omitted session config uses an immutable owner snapshot, not legacy allow`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-owner-config-"));
  const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "session.sqlite"));
  const supplied = base(), opened = adapter.open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config: supplied });
  if (!opened.ok) throw new Error(opened.error.message);
  supplied.policies.__legacy_allow!.fallback = "allow";
  const effects: string[] = [], session = createSession({ systemPrompt: "owner", storage: opened.value, configureTurn: () => services(effects) });
  try {
    const owner = opened.value.ownerConfig(); expect(owner).toMatchObject({ ok: true, value: { policies: { __legacy_allow: { fallback: "deny" } } } });
    if (owner.ok && owner.value) owner.value.policies.__legacy_allow!.fallback = "allow";
    const replacement = base(); replacement.policies.__legacy_allow!.fallback = "allow";
    expect(opened.value.saveConfig(replacement).ok).toBe(true);
    expect(opened.value.ownerConfig()).toMatchObject({ ok: true, value: { policies: { __legacy_allow: { fallback: "deny" } } } });
    session.start(); session.agent.send({ channelId: "a", participantId: "u", text: "hi" });
    await until(() => session.snapshot().turns[0]?.state.status === "completed");
    expect(effects).toEqual([]);
    const result = session.snapshot().timeline.find(entry => entry.message.role === "tool")!.message;
    expect(result.role === "tool" && JSON.parse(result.content).code).toBe("policy_denied");
  } finally { session.stop("done"); opened.value.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("assembly checks config values and prompt, ignores key order, and never treats read failure as absence", () => {
  const config = base(), opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" }, config });
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const reordered = { policies: { __legacy_allow: { tools: {}, fallback: "deny" as const } }, defaultPolicy: "__legacy_allow", model: { script: "fixture", protocol: "scripted" as const }, system: "owner", version: 1 as const };
    expect(() => createSession({ systemPrompt: "owner", storage: opened.value, config: reordered, configureTurn: () => services([]) })).not.toThrow();
    const wrong = base(); wrong.policies.__legacy_allow!.fallback = "allow";
    expect(() => createSession({ systemPrompt: "owner", storage: opened.value, config: wrong, configureTurn: () => services([]) })).toThrow("does not match");
    expect(() => createSession({ systemPrompt: "other", storage: opened.value, configureTurn: () => services([]) })).toThrow("system prompt");
    const broken = new Proxy(opened.value, { get(target, key) { return key === "ownerConfig" ? () => ({ ok: false, error: { code: "storage_failure", message: "read failed" } }) : Reflect.get(target, key); } }) as SessionStorage;
    expect(() => createSession({ systemPrompt: "owner", storage: broken, config, configureTurn: () => services([]) })).toThrow("read failed");
  } finally { opened.value.close(); }
});

test("legacy opens expose absence; own storage receives an explicit config", async () => {
  const legacy = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "legacy", compatibilityKey: "k" } });
  if (!legacy.ok) throw new Error(legacy.error.message);
  expect(legacy.value.ownerConfig()).toMatchObject({ ok: true, value: undefined });
  expect(() => createSession({ systemPrompt: "arbitrary legacy prompt", storage: legacy.value, configureTurn: () => services([]) })).not.toThrow();
  expect(() => createSession({ systemPrompt: "owner", storage: legacy.value, config: base(), configureTurn: () => services([]) })).toThrow("does not match");
  legacy.value.close();
  const effects: string[] = [], session = createSession({ systemPrompt: "owner", config: base(), configureTurn: () => services(effects) });
  try { session.start(); session.agent.send({ channelId: "a", participantId: "u", text: "hi" }); await until(() => session.snapshot().turns[0]?.state.status === "completed"); expect(effects).toEqual([]); }
  finally { session.stop("done"); }
});
