/**
 * Where a conversation's controller is created (controller-interface spec, Seams and files). A
 * conversation bound to a native harness channel gets a `NativeController`; every other conversation
 * gets a `HarnessController` for its adapter's external harness command, exactly as before. The
 * native path is opt-in: nothing selects it unless a binding is passed.
 */
import { HarnessController, type AgentControllerConfig } from "../controller.ts";
import { NativeController } from "../native/controller.ts";
import type { NativeHarnessHost } from "../native/host.ts";
import type { ConversationController } from "./contracts.ts";

/** Binds a conversation to one channel of its Agent's shared native harness. */
export interface NativeControllerBinding {
  readonly host: NativeHarnessHost;
  /** The conversation's stable id. */
  readonly channelId: string;
  readonly defaultSender?: string;
}

export function createController(config: AgentControllerConfig & { native?: NativeControllerBinding }): ConversationController {
  if (config.native) {
    if (config.mode && config.mode !== "normal") throw new Error("a native conversation has no degraded or bridge mode");
    return new NativeController({
      host: config.native.host,
      channelId: config.native.channelId,
      ...(config.native.defaultSender ? { defaultSender: config.native.defaultSender } : {}),
      // A conversation that asked to load its provider session has history of its own.
      resumed: config.sessionId !== undefined,
      ...(config.logger ? { logger: config.logger } : {}),
    });
  }
  return new HarnessController(config);
}
