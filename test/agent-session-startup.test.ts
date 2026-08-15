import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";
import { appendTranscriptLine, readTranscriptLines } from "../src/transcript.ts";

const AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const live = new Set<AgentSession>();

afterEach(async () => {
  await Promise.allSettled([...live].map((session) => session.stop()));
  live.clear();
});

function adapter(label: string) {
  return { command: ["bun", AGENT, label] };
}

async function track(config: Parameters<typeof AgentSession.create>[0]): Promise<AgentSession> {
  const session = await AgentSession.create(config);
  live.add(session);
  return session;
}

describe("AgentSession startup identity", () => {
  test("new provider intent is independent of an existing transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-startup-"));
    const transcriptPath = join(root, "chosen-history.jsonl");
    await appendTranscriptLine(transcriptPath, {
      v: 1,
      t: "meta",
      event: "open",
      ts: 1,
      internalSessionId: "historical-thread",
      adapter: "old-adapter",
    });

    const session = await track({
      adapter: adapter("explicit-new"),
      adapterId: "fake",
      agentSessionId: "logical-id",
      providerSession: { kind: "new" },
      transcriptPath,
    });

    expect(session.agentSessionId).toBe("logical-id");
    expect(session.transcriptPath).toBe(transcriptPath);
    expect(session.internalSessionId).toBe("explicit-new-thread-1");
    expect(session.internalSessionId).not.toBe("historical-thread");
    const opens = (await readTranscriptLines(transcriptPath)).filter((line) => line.t === "meta");
    expect(opens.map((line) => line.internalSessionId)).toEqual([
      "historical-thread",
      "explicit-new-thread-1",
    ]);
  });

  test("explicit load retains both supplied logical and provider identities", async () => {
    const session = await track({
      adapter: adapter("explicit-load"),
      adapterId: "fake",
      agentSessionId: "logical-existing",
      providerSession: {
        kind: "load",
        internalSessionId: "provider-existing",
      },
    });

    expect(session.agentSessionId).toBe("logical-existing");
    expect(session.internalSessionId).toBe("provider-existing");
    expect(session.connection.currentSessionId).toBe("provider-existing");
  });

  test("explicit load fails closed by default", async () => {
    await expect(AgentSession.create({
      adapter: adapter("fail-load"),
      adapterId: "fake",
      providerSession: { kind: "load", internalSessionId: "missing-provider-thread" },
    })).rejects.toThrow("deterministic load failure");
  });

  test("load fallback creates a new provider thread only when requested", async () => {
    const session = await track({
      adapter: adapter("fail-load"),
      adapterId: "fake",
      agentSessionId: "logical-fallback",
      providerSession: {
        kind: "load",
        internalSessionId: "missing-provider-thread",
        onFailure: "new",
      },
    });

    expect(session.agentSessionId).toBe("logical-fallback");
    expect(session.internalSessionId).toBe("fail-load-thread-1");
  });

  test("legacy internalSessionId keeps its historical fallback policy", async () => {
    const session = await track({
      adapter: adapter("fail-load"),
      adapterId: "fake",
      internalSessionId: "missing-provider-thread",
    });
    expect(session.internalSessionId).toBe("fail-load-thread-1");
  });

  test("configuration rejects competing provider selectors and impossible degraded loads", async () => {
    await expect(AgentSession.create({
      adapter: adapter("invalid"),
      adapterId: "fake",
      providerSession: { kind: "new" },
      internalSessionId: "also-selected",
    })).rejects.toThrow("both providerSession and internalSessionId");

    await expect(AgentSession.create({
      adapter: adapter("invalid"),
      adapterId: "fake",
      mode: "degraded",
      providerSession: { kind: "load", internalSessionId: "provider-thread" },
    })).rejects.toThrow("requires ACP");
  });

  test("a malformed existing transcript is appendable but never a startup selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-startup-bad-transcript-"));
    const transcriptPath = join(root, "damaged.jsonl");
    await writeFile(transcriptPath, "{this is not valid json}\n", "utf8");

    const session = await track({
      adapter: adapter("damaged-history"),
      adapterId: "fake",
      providerSession: { kind: "new" },
      transcriptPath,
    });
    expect(session.internalSessionId).toBe("damaged-history-thread-1");
    expect(await readTranscriptLines(transcriptPath)).toEqual([
      expect.objectContaining({
        t: "meta",
        event: "open",
        internalSessionId: "damaged-history-thread-1",
      }),
    ]);
  });

  test("omitting transcript configuration creates no library history storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-startup-no-transcript-"));
    const session = await track({
      adapter: adapter("ephemeral"),
      adapterId: "fake",
      cwd: root,
      providerSession: { kind: "new" },
    });
    expect(session.transcriptPath).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  test("agentSessionId is always exposed, whether supplied or minted", async () => {
    const supplied = await track({
      adapter: adapter("supplied-id"),
      adapterId: "fake",
      agentSessionId: "consumer-chosen",
      providerSession: { kind: "new" },
    });
    const minted = await track({
      adapter: adapter("minted-id"),
      adapterId: "fake",
      providerSession: { kind: "new" },
    });
    expect(supplied.agentSessionId).toBe("consumer-chosen");
    expect(minted.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
