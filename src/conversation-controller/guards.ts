/**
 * Small guards over a `ConversationController`'s optional members, so the session never depends on
 * the concrete `HarnessController` type (controller-interface spec, Capabilities: every optional
 * member and its guard).
 */
import { HarnessController } from "../controller.ts";
import type { ConversationController } from "./contracts.ts";

/** Whether the controller talks to a screen-scraped (PTY) harness: only a controller with a mode can. */
export function isDegradedController(controller: ConversationController): boolean {
  return controller.currentMode === "degraded";
}

/** The controller as a `HarnessController` (an external harness over ACP or a PTY), or null for any other backend. */
export function harnessControllerOf(controller: ConversationController): HarnessController | null {
  return controller instanceof HarnessController ? controller : null;
}
