#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Agent } from "@qlairoslabs/acp-client";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../test5-operations/operations-agent.ts");
const directory = await mkdtemp(join(tmpdir(), "acp-agent-sqlite-smoke-"));
const databasePath = join(directory, "agent.sqlite");

const agent = await Agent.open({
  persistence: {
    kind: "sqlite",
    path: databasePath,
  },
  adapters: {
    test: {
      command: ["bun", fixture, "test8"],
      displayName: "Deterministic test agent",
    },
  },
  defaultAdapterId: "test",
});

try {
  const conversation = await agent.conversations.create();
  const result = await conversation.prompt("hi");

  assert.equal(result.status, "completed");

  // Read through SQLite directly—not through the library—to prove the canonical user
  // message was committed to the caller-selected database.
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.query<
      { content: string },
      [string, string, string]
    >(`
      SELECT json_extract(payload_json, '$.content') AS content
      FROM conversation_records
      WHERE agent_conversation_id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.role') = ?
        AND json_extract(payload_json, '$.content') = ?
      LIMIT 1
    `).get(conversation.id, "user", "hi");

    assert.ok(row, "expected SQLite to contain the user message");
    assert.equal(row.content, "hi");
  } finally {
    database.close();
  }

  console.log(`PASS agent=${agent.id} conversation=${conversation.id} content=hi`);
} finally {
  await agent.close();
  await rm(directory, { recursive: true, force: true });
}
