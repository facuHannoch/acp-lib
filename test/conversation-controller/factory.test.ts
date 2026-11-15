/**
 * The controller factory (controller-interface spec, Seams and files; Brief B1 step 4): every controller a
 * conversation creates, at open and for a handoff target, comes from `createController`; session and turn
 * code never construct one directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { AgentSession } from "../../src/agent-session.ts";
import { HarnessController } from "../../src/controller.ts";
import { createController } from "../../src/conversation-controller/index.ts";

const ROOT = resolve(import.meta.dir, "../..");
const LIFECYCLE = join(ROOT, "test/fixtures/lifecycle-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("the factory", () => {
  test("an adapter gives a HarnessController configured as asked", () => {
    const controller = createController({ adapter: { command: ["bun", LIFECYCLE] }, adapterId: "fixture", mode: "normal" });
    expect(controller).toBeInstanceOf(HarnessController);
    expect((controller as HarnessController).currentAdapterId).toBe("fixture");
    expect(controller.currentMode).toBe("normal");
    expect(controller.isConnected).toBe(false);
  });

  test("each call makes a new controller (a handoff target never reuses the live one)", () => {
    const config = { adapter: { command: ["bun", LIFECYCLE] }, adapterId: "fixture" };
    expect(createController(config)).not.toBe(createController(config));
  });

  test("nothing in src/ constructs a controller directly except the factory, the internal-inference runtime and the low-level CLI", () => {
    const direct = /new (HarnessController|AgentController)\(/;
    const offenders = sourceFiles(join(ROOT, "src"))
      .filter((path) => direct.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path))
      .sort();
    expect(offenders).toEqual([
      "src/cli/index.ts",
      "src/conversation-controller/factory.ts",
      "src/internal-inference/runtime/harness-runtime.ts",
    ]);
  });

  test("the session and the turn code never construct one (the gate: no direct controller type use outside the factory and harnessConnection)", () => {
    for (const path of [join(ROOT, "src/agent-session.ts"), ...sourceFiles(join(ROOT, "src/conversation-turns"))]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/new (HarnessController|AgentController)\(/);
    }
  });
});

describe("a conversation's controllers come from it", () => {
  test("opening and a handoff each build a controller through the factory: the handoff target replaces the live one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-factory-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const created = await AgentSession.create({
      adapterId: "mock",
      adapter: { command: ["bun", LIFECYCLE], cancelGraceMs: 80 },
      env: { LIFECYCLE_STATE: join(directory, "sessions.json") },
      metering: { pricing: false },
      persistence: { root: directory },
      agentSessionId: "factory-handoff",
      creationId: "factory-handoff-1",
    });
    cleanups.push(() => created.stop());
    await created.prompt("remember kiwi");
    const before = created.connection;
    expect(before).toBeInstanceOf(HarnessController);
    const result = await created.handoff({ continuation: { kind: "none" } });
    expect(result.summary).toBe(""); // no continuation requested
    const after = created.connection;
    expect(after).not.toBe(before);
    expect(after).toBeInstanceOf(HarnessController);
    expect(after.isConnected).toBe(true);
    expect((after as HarnessController).currentAdapterId).toBe("mock");
    expect((await created.prompt("still here")).status).toBe("completed");
  }, 30_000);
});
