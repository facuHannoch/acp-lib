import { permissionArrival } from "../permissions/arrival.ts";
import type { ChannelEvent } from "../native-harness/src/client.ts";
import type { Logger } from "../logger.ts";
import { cancelledPermission, nativeConversationStopping, nativePermissionRequests, refuseNativeOnClose, type NativePermission, type PermissionResolution } from "../permissions/conversation.ts";
import { recordingPermissionHandlers } from "../permissions/policy.ts";
import type { PermissionRequest, PromptHandlers } from "../types.ts";
import type { NativeApprovalRequest, NativeApprovalResponder } from "./host.ts";

type ApprovalEvent = Extract<ChannelEvent["event"], { type: "approval_requested" }>;
type CloseEvent = Extract<ChannelEvent["event"], { type: "approval_closed" }>;
type SendApproval = (decision: "allow_once" | "deny") => Promise<boolean>;
const allow = { outcome: "selected", optionId: "allow_once" } as const;
const deny = { outcome: "selected", optionId: "deny" } as const;

class Approval implements NativePermission {
  readonly arrival = permissionArrival();
  readonly resolution: Promise<PermissionResolution>;
  private resolve!: (result: PermissionResolution) => void;
  private readonly abort = new AbortController();
  private inFlight = false;
  private observedAnswer?: PermissionResolution;
  private started = false;

  constructor(
    readonly request: NativeApprovalRequest,
    readonly hostHandled: boolean,
    private readonly send: SendApproval,
  ) {
    this.resolution = new Promise(resolve => { this.resolve = resolve; });
  }

  get signal(): AbortSignal { return this.abort.signal; }
  get settled(): boolean { return this.abort.signal.aborted; }
  get hasWireOutcome(): boolean { return this.settled || this.observedAnswer !== undefined; }

  start(responder: NativeApprovalResponder, log: Logger): void {
    if (this.started) return;
    this.started = true;
    void Promise.resolve().then(() => {
      if (!this.abort.signal.aborted) {
        return responder(this.request, decision => this.answer({ outcome: decision === "allow_once" ? allow : deny, by: "handler" }), this.abort.signal);
      }
    }).catch(error => log.warn("native_approval_responder_failed", { requestId: this.request.requestId, error: String(error) }));
  }

  async answer(resolution: PermissionResolution): Promise<boolean> {
    if (this.inFlight || this.abort.signal.aborted) return false;
    this.inFlight = true;
    const decision = resolution.outcome.outcome === "selected" && resolution.outcome.optionId === "allow_once" ? allow : deny;
    try {
      const accepted = await this.send(decision.optionId);
      if (this.abort.signal.aborted) return false;
      this.finish(accepted ? { ...resolution, outcome: decision } : this.observedAnswer ?? cancelledPermission);
      return accepted;
    } finally {
      if (!this.abort.signal.aborted) this.finish(this.observedAnswer ?? cancelledPermission);
    }
  }

  closed(reason: CloseEvent["reason"]): void {
    if (reason === "approval_denied" || reason === "dispatched") {
      // The harness can emit the effect before replying to approval/respond.
      this.observedAnswer = { outcome: reason === "dispatched" ? allow : deny, by: "consumer" };
      if (!this.inFlight) this.finish(this.observedAnswer);
    } else if (reason === "approval_timeout") {
      this.finish({ outcome: deny, by: "timeout" });
    } else {
      this.finish(cancelledPermission);
    }
  }

  endTurn(): void {
    if (!this.inFlight || !this.observedAnswer) this.finish(cancelledPermission);
  }

  finish(result: PermissionResolution): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.resolve(result);
  }
}

/** Attach the same ticket to live and observed copies. Held events keep their ticket after turn cleanup. */
export class NativeApprovals {
  private readonly active = new Map<string, Approval>();
  get busy(): boolean { return [...this.active.values()].some(ticket => !ticket.settled); }
  private readonly events = new WeakMap<ApprovalEvent, Approval>();

  constructor(private readonly responder: NativeApprovalResponder | undefined, private readonly log: Logger) {}

  observe(channel: string, event: ApprovalEvent, send: SendApproval): void {
    let ticket = this.events.get(event) ?? this.active.get(event.requestId);
    if (!ticket) {
      const { type: _type, ...request } = event;
      ticket = new Approval({ ...request, channel }, this.responder !== undefined, send);
      this.active.set(event.requestId, ticket);
    }
    this.events.set(event, ticket);
  }

  start(event: ApprovalEvent): void {
    if (this.responder) this.events.get(event)?.start(this.responder, this.log);
  }

  ticket(event: ApprovalEvent): NativePermission | undefined { return this.events.get(event); }

  closed(event: CloseEvent): void { this.active.get(event.requestId)?.closed(event.reason); }

  end(channel: string, turnId: string): void {
    for (const [id, ticket] of this.active) {
      if (ticket.request.channel !== channel || ticket.request.turnId !== turnId) continue;
      this.active.delete(id);
      ticket.endTurn();
    }
  }

  disconnected(): void {
    for (const ticket of this.active.values()) ticket.finish(cancelledPermission);
  }

  stop(): void {
    this.disconnected();
    this.active.clear();
  }
}

const APPROVAL_OPTIONS: PermissionRequest["options"] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

export async function runNativeApproval(
  ticket: NativePermission, event: ApprovalEvent, handlers: PromptHandlers, cancelled: AbortSignal, log: Logger,
): Promise<void> {
  const request: PermissionRequest = {
    toolCallId: event.toolCallId, title: event.tool, options: APPROVAL_OPTIONS.map(option => ({ ...option })),
    tool: { name: event.tool, rawInput: event.arguments }, raw: event,
  };
  nativePermissionRequests.set(request, ticket);
  const handler = handlers.onPermissionRequest;
  const recording = handler && recordingPermissionHandlers.has(handler) ? handler : undefined;
  const close = () => refuseNativeOnClose(ticket, cancelled.reason === nativeConversationStopping, () => log);
  if (!recording) {
    if (cancelled.aborted) close();
    else cancelled.addEventListener("abort", close, { once: true });
  }
  try {
    if (recording) {
      await recording(request, cancelled);
    } else if (ticket.hostHandled) {
      await ticket.resolution;
    } else if (!cancelled.aborted) {
      const signal = AbortSignal.any([cancelled, ticket.signal]);
      if (signal.aborted) return;
      const answer = handler ? await Promise.race([
        Promise.resolve().then(() => handler.call(handlers, request, signal)),
        ticket.resolution.then(result => result.outcome),
      ]) : deny;
      if (!signal.aborted) await ticket.answer({ outcome: answer, by: handler ? "handler" : "default" });
    }
  } catch (error) {
    log.warn("native_approval_handler_failed", { requestId: event.requestId, error: String(error) });
    if (!ticket.hostHandled && !cancelled.aborted && !recording) {
      await ticket.answer({ outcome: deny, by: "handler" }).catch(() => false);
    }
  } finally {
    cancelled.removeEventListener("abort", close);
  }
}
