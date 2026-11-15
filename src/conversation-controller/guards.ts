/**
 * Small guards over a `ConversationController`'s optional members, so the session never depends on
 * the concrete `HarnessController` type (controller-interface spec, Capabilities: every optional
 * member and its guard).
 */
import type { Capabilities } from "../capabilities.ts";
import { HarnessController } from "../controller.ts";
import { ProviderSessionReloadUnsupportedError, UnsupportedError } from "../errors.ts";
import type { ConnectResult } from "../client.ts";
import type { StaleLimits } from "../operations/contracts.ts";
import type { InternalSessionCommand, SessionListEntry } from "../types.ts";
import type { ConversationController } from "./contracts.ts";

/** Whether the controller talks to a screen-scraped (PTY) harness: only a controller with a mode can. */
export function isDegradedController(controller: ConversationController): boolean {
  return controller.currentMode === "degraded";
}

/** The controller as a `HarnessController` (an external harness over ACP or a PTY), or null for any other backend. */
export function harnessControllerOf(controller: ConversationController): HarnessController | null {
  return controller instanceof HarnessController ? controller : null;
}

type OptionalMember = "bridge" | "authenticate" | "setMode" | "reconnect" | "prepareInternalPrompt";

/** An optional method of the controller, bound to it; `UnsupportedError` (naming `what`) when the controller doesn't have it. */
export function requireMember<K extends OptionalMember>(
  controller: ConversationController,
  name: K,
  what: string,
): NonNullable<ConversationController[K]> {
  const member = controller[name];
  if (typeof member !== "function") throw new UnsupportedError(`this conversation's controller does not support ${what}`);
  return member.bind(controller) as NonNullable<ConversationController[K]>;
}

const NO_COMMANDS: readonly InternalSessionCommand[] = Object.freeze([]);

/** The commands the backend advertises; none for a controller without them. */
export function availableCommandsOf(controller: ConversationController): readonly InternalSessionCommand[] {
  return controller.availableCommands ?? NO_COMMANDS;
}

/**
 * The agent's own session list, for a controller that is connected, not degraded, lists sessions and whose
 * backend says it can. An unknown backend (not connected yet) is not an unsupported one: the ACP getter
 * throws `NotConnectedError`, as it always did here. Otherwise empty.
 */
export async function listAgentSessions(controller: ConversationController): Promise<SessionListEntry[]> {
  if (isDegradedController(controller)) return [];
  const backend = controller.conversationCapabilities.backend;
  if (!backend) void harnessControllerOf(controller)?.capabilities;
  return backend?.listSessions && controller.listSessions ? (await controller.listSessions()).sessions : [];
}

/** The raw ACP capabilities, through the `HarnessController`; `UnsupportedError` for a backend that has none (use `conversationCapabilities`). */
export function acpCapabilitiesOf(controller: ConversationController): Capabilities {
  const harness = harnessControllerOf(controller);
  if (!harness) throw new UnsupportedError("this conversation's controller has no ACP capabilities; use conversationCapabilities");
  return harness.capabilities;
}

/**
 * Reloads the provider session, for a controller that can. One that can't throws, so recovery takes over:
 * it is handled as a session the provider no longer has, under the conversation's continuation rule.
 */
export function reloadProviderSession(controller: ConversationController, sessionId: string): Promise<ConnectResult> {
  if (!controller.reconnect) throw new ProviderSessionReloadUnsupportedError();
  return controller.reconnect(sessionId);
}

/**
 * The stall limits a provider request runs under. A screen-scraped (PTY) harness can't report tools or permissions, so
 * silence explains nothing: no limit by default (a configured one still applies). A prepared turn that isn't `live` is
 * replaying output the backend already produced (controller-interface spec: the stall check applies from the point the
 * turn is live), so no stall limit applies to it at all.
 */
export function stallLimitsFor(controller: ConversationController, provider: object, limits: StaleLimits | undefined): StaleLimits | undefined {
  if ((provider as { live?: boolean }).live === false) return { ...limits, firstOutputMs: false, nextOutputMs: false };
  return isDegradedController(controller) ? { firstOutputMs: false, nextOutputMs: false, ...limits } : limits;
}
