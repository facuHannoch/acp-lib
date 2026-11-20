/**
 * Where a conversation's controller is created (controller-interface spec, Seams and files). The
 * adapter's type chooses the controller: today only an `Adapter` (an external harness command)
 * exists, so it is always a `HarnessController`; the native controller joins here later.
 */
import { HarnessController, type AgentControllerConfig } from "../controller.ts";
import type { ConversationController } from "./contracts.ts";

export function createController(config: AgentControllerConfig): ConversationController {
  return new HarnessController(config);
}
