#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Agent } from "@qlairoslabs/acp-client";
import { findStoredUserMessage } from "./queries.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../test5-operations/operations-agent.ts");
const configuredDirectory = process.env.ACP_TEST8_DATA_DIR?.trim();
const ownsTemporaryDirectory = !configuredDirectory;
const directory = configuredDirectory
  ? resolve(configuredDirectory)
  : await mkdtemp(join(tmpdir(), "acp-agent-sqlite-smoke-"));
if (configuredDirectory) await mkdir(directory, { recursive: true });
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
    const row = findStoredUserMessage(database, conversation.id, "hi");

    assert.ok(row, "expected SQLite to contain the user message");
    assert.equal(row.content, "hi");
  } finally {
    database.close();
  }

  console.log(`PASS agent=${agent.id} conversation=${conversation.id} content=hi`);
} finally {
  await agent.close();
  if (ownsTemporaryDirectory) {
    await rm(directory, { recursive: true, force: true });
  } else {
    console.log(`SQLite retained at ${databasePath}`);
  }
}
