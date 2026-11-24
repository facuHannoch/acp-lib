/**
 * The rename (controller-interface spec, Names; Brief B1 step 2): `AgentController` is now
 * `HarnessController`, which declares `implements ConversationController`; the old names stay as
 * deprecated aliases, and the existing error strings are unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as publicApi from "../../src/index.ts";
import {
  AgentController,
  HarnessController,
  type AgentControllerStartEvent,
  type ControllerStartEvent,
} from "../../src/controller.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";

const ECHO = join(resolve(import.meta.dir, "../fixtures"), "echo-prompt-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

async function controller(): Promise<HarnessController> {
  const directory = await mkdtemp(join(tmpdir(), "acp-rename-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const created = new HarnessController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture", cwd: directory });
  cleanups.push(() => created.stop());
  return created;
}

// Compile-time: the concrete class is usable wherever a ConversationController is expected, and the
// deprecated start-event alias is the same type as the new name.
const asInterface = (value: HarnessController): ConversationController => value;
const sameEvent = (event: AgentControllerStartEvent): ControllerStartEvent => event;
void asInterface;
void sameEvent;

describe("HarnessController", () => {
  test("the old names are aliases of the new one: the same class, instances of both", async () => {
    expect(AgentController).toBe(HarnessController);
    const created = await controller();
    expect(created).toBeInstanceOf(HarnessController);
    expect(created).toBeInstanceOf(AgentController);
    const old = new AgentController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture" });
    expect(old).toBeInstanceOf(HarnessController);
  });

  test("the public entry point exports the new name and keeps the old one (the same value)", () => {
    expect(publicApi.HarnessController).toBe(HarnessController);
    expect(publicApi.AgentController).toBe(HarnessController);
  });

  test("it has every core member of the interface, and (being the full controller) every optional one", async () => {
    const created = await controller();
    const core = [
      "send", "subscribeTurns", "prepareTurn", "abandonTurn", "cancel", "forceStop", "stop", "start", "startFresh",
      "isConnected", "subscribeOutput", "subscribeConnection", "cancelGraceMs", "conversationCapabilities",
      "configOptions", "setConfig", "subscribeUsageUpdate", "currentSessionId",
    ];
    const optional = [
      "prepareInternalPrompt", "availableCommands", "subscribeAvailableCommands", "currentMode", "setMode",
      "reconnect", "listSessions", "bridge", "authenticate",
    ];
    expect(core.filter((name) => !(name in created))).toEqual([]);
    expect(optional.filter((name) => !(name in created))).toEqual([]);
  });

  test("members read through the interface behave as on the class (before start)", async () => {
    const created = await controller();
    const asController: ConversationController = created;
    expect(asController.isConnected).toBe(false);
    expect(asController.currentSessionId).toBeNull();
    expect(asController.configOptions.size).toBe(0);
    expect(asController.cancelGraceMs).toBeUndefined();
    expect(asController.conversationCapabilities).toEqual({ nativeSteering: false, reminders: false, backend: null });
  });

  test("the existing error strings keep the old class name (callers and snapshots match on them)", async () => {
    const created = await controller();
    // `prompt()` checks the connection synchronously (as it always did), so it throws, not rejects.
    expect(() => created.prepareTurn("t", { handlers: {} }).prompt()).toThrow("AgentController is not started — call start() first");
    expect(() => created.currentClient).toThrow("AgentController is not started — call start() first");
  });

  test("start progress still reports the two events through the renamed type", async () => {
    const created = await controller();
    const events: ControllerStartEvent[] = [];
    const result = await created.start((event) => events.push(event));
    expect(result.sessionId).not.toBe("");
    expect(events.map((event) => event.stage)).toEqual(["initialized", "internal_session_acquired"]);
  }, 20_000);
});
