import type { AgentSessionEvent } from "../agent-conversation-contracts.ts";
import type { Logger } from "../logger.ts";
import type { PermissionOutcome, PermissionRequest, PromptHandlers } from "../types.ts";
import { acpPermissionArrivals, permissionArrival, type PermissionArrival } from "./arrival.ts";
import { DEFAULT_PERMISSION_TIMEOUT_MS } from "./consumer-config.ts";
import { selectPermissionOutcome } from "./outcome.ts";
import { permissionLevel, recordingPermissionHandlers, type ConversationPermissionConfig } from "./policy.ts";

export type PermissionResolutionSource = "handler" | "consumer" | "default" | "timeout" | "turn_ended";
export type PermissionResolution = {
  readonly outcome: PermissionOutcome;
  readonly by: PermissionResolutionSource;
  /** ACP can only cancel on the wire if no reject option is offered. */
  readonly refused?: boolean;
};
export type ConversationPermissionEvent =
  | { kind: "permission_requested"; id: string; turnId: string; tool: PermissionRequest["tool"]; title: string | undefined;
      options: readonly Readonly<PermissionRequest["options"][number]>[]; expiresAt?: number }
  | { kind: "permission_resolved"; id: string; outcome: "approved" | "denied" | "cancelled"; by: PermissionResolutionSource };

export const cancelledPermission: PermissionResolution = { outcome: { outcome: "cancelled" }, by: "turn_ended" };

export function permissionOutcome(request: PermissionRequest, resolution: PermissionResolution) {
  if (resolution.refused) return "denied" as const;
  if (resolution.outcome.outcome === "cancelled") return "cancelled" as const;
  const { optionId } = resolution.outcome;
  const kind = request.options.find(option => option.optionId === optionId)?.kind;
  return kind === "allow_once" || kind === "allow_always" ? "approved" as const : "denied" as const;
}

/** A native approval already has a request identity and a wire-level settlement. */
export interface NativePermission {
  readonly arrival: PermissionArrival;
  readonly hostHandled: boolean;
  readonly settled: boolean;
  readonly signal: AbortSignal;
  readonly hasWireOutcome: boolean;
  readonly resolution: Promise<PermissionResolution>;
  answer(resolution: PermissionResolution): Promise<boolean>;
}

export const nativeProviderTurnEnded = Symbol("native provider turn ended");
export const nativeConversationStopping = Symbol("native conversation stopping");

export function refuseNativeOnClose(native: NativePermission | undefined, stopping: boolean, log: () => Logger): void {
  if (!native || native.hasWireOutcome || (native.hostHandled && !stopping)) return;
  void native.answer(cancelledPermission).catch(error =>
    log().warn("native_approval_local_refusal_failed", { error: String(error) }));
}

export const nativePermissionRequests = new WeakMap<PermissionRequest, NativePermission>();

interface PermissionEntry {
  readonly turnId: string;
  close(resolution: PermissionResolution): void;
  closeLocally(stopping?: boolean): void;
  answer?(optionId: string): Promise<boolean>;
}

export class ConversationPermissions {
  private readonly pending = new Map<string, PermissionEntry>();
  private stopped = false;

  constructor(
    private readonly emit: (event: AgentSessionEvent) => void,
    private readonly log: () => Logger,
  ) {}

  end(turnId: string): void {
    for (const entry of this.pending.values()) if (entry.turnId === turnId) entry.closeLocally();
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) entry.closeLocally(true);
  }

  async answer(id: string, optionId: string): Promise<{ accepted: boolean }> {
    return { accepted: await this.pending.get(id)?.answer?.(optionId) ?? false };
  }

  internalHandler(turnId: string, policy: ConversationPermissionConfig): PromptHandlers {
    const onPermissionRequest: NonNullable<PromptHandlers["onPermissionRequest"]> = async (request, signal) =>
      (await this.request(turnId, request, policy, undefined, signal)).outcome;
    recordingPermissionHandlers.add(onPermissionRequest);
    return { onPermissionRequest };
  }

  request(
    turnId: string,
    request: PermissionRequest,
    policy: ConversationPermissionConfig,
    consumer: PromptHandlers | undefined,
    signal?: AbortSignal,
    recordRequested?: () => Promise<void>,
  ): Promise<PermissionResolution> {
    const native = nativePermissionRequests.get(request);
    if (this.stopped || signal?.aborted) {
      refuseNativeOnClose(native, this.stopped || signal?.reason === nativeConversationStopping, this.log);
      return Promise.resolve(cancelledPermission);
    }
    const id = crypto.randomUUID();
    const handlerAbort = new AbortController();
    const abort = () => {
      if (signal?.reason === nativeProviderTurnEnded && native?.hasWireOutcome) return;
      entry.closeLocally(signal?.reason === nativeConversationStopping);
    };
    const handler = consumer?.onPermissionRequest;
    const refuse = (by: PermissionResolutionSource): PermissionResolution =>
      ({ outcome: selectPermissionOutcome("deny", request.options)!, by, refused: true });
    let level: ReturnType<typeof permissionLevel> | undefined;
    if (!native?.hostHandled && !native?.settled) {
      try {
        level = permissionLevel(request, policy, Boolean(native));
      } catch (error) {
        this.log().warn("conversation_permission_rule_failed", { turnId, id, error: String(error) });
      }
    }

    const waitForConsumer = level === "ask" && !handler && policy.answersPermissions === true;
    const offered = Object.freeze(request.options.map(option => Object.freeze({ ...option })));
    const arrival = native?.arrival ?? acpPermissionArrivals.get(request) ?? permissionArrival();
    const budget = policy.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const remaining = () => budget - (performance.now() - arrival.monotonicTime);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (resolution: PermissionResolution) => void;
    const result = new Promise<PermissionResolution>(accept => { resolve = accept; });
    const entry: PermissionEntry = {
      turnId,
      closeLocally: (stopping = false) => {
        if (!this.pending.has(id)) return;
        entry.close(cancelledPermission);
        refuseNativeOnClose(native, stopping, this.log);
      },
      close: resolution => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        handlerAbort.abort();
        const outcome = permissionOutcome(request, resolution);
        // Finish notifying all request listeners before any reentrant stop publishes its resolution.
        queueMicrotask(() => this.emit({ kind: "permission_resolved", id, outcome, by: resolution.by }));
        resolve(resolution);
      },
    };
    this.pending.set(id, entry);
    signal?.addEventListener("abort", abort, { once: true });
    if (native) void native.resolution.then(entry.close);
    if (this.stopped || signal?.aborted) abort();

    const send = async (decision: PermissionResolution) => {
      if (!this.pending.has(id)) return false;
      if (native) return native.answer(decision);
      entry.close(decision);
      return true;
    };
    const failed = (error: unknown) => {
      this.log().warn("conversation_permission_response_failed", { turnId, id, error: String(error) });
      entry.close(cancelledPermission);
      return false;
    };
    const record = Promise.resolve().then(recordRequested);
    const recordReady = () => Promise.race([record.then(() => true), result.then(() => false)]);
    const sendAfterRecord = async (decision: PermissionResolution) => {
      try {
        if (!await recordReady()) return false;
      } catch (error) {
        this.log().warn("conversation_permission_record_failed", { turnId, id, error: String(error) });
        await send(refuse("default"));
        return false;
      }
      return send(decision);
    };

    if (waitForConsumer) {
      const claim = () => {
        if (!entry.answer) return false;
        entry.answer = undefined;
        clearTimeout(timer);
        return true;
      };
      const expire = () => {
        if (claim()) void send(refuse("timeout")).catch(failed);
      };
      entry.answer = async optionId => {
        if (remaining() <= 0) expire();
        if (!offered.some(option => option.optionId === optionId) || !claim()) return false;
        const accepted = await sendAfterRecord({ outcome: { outcome: "selected", optionId }, by: "consumer" }).catch(failed);
        return accepted && (await result).by === "consumer";
      };
      timer = setTimeout(expire, Math.max(0, Math.ceil(remaining())));
      // A failed requested record cannot leave an otherwise unclaimed request open.
      void record.catch(() => { if (claim()) void sendAfterRecord(refuse("default")).catch(failed); });
    }

    this.emit({
      kind: "permission_requested", id, turnId, tool: request.tool && Object.freeze(structuredClone(request.tool)),
      title: request.title, options: offered, ...(waitForConsumer ? { expiresAt: arrival.wallTime + budget } : {}),
    });

    if (native?.hostHandled || native?.settled || waitForConsumer) return result;
    if (level !== "ask" || !handler) {
      const decision = level === "ask" || level === undefined ? refuse("default")
        : { outcome: selectPermissionOutcome(level, request.options)!, by: "default" as const };
      void sendAfterRecord(decision).catch(failed);
      return result;
    }

    const runHandler = async () => {
      try {
        if (!await recordReady()) return;
      } catch (error) {
        this.log().warn("conversation_permission_record_failed", { turnId, id, error: String(error) });
        await send(refuse("default"));
        return;
      }
      if (!this.pending.has(id)) return;
      try {
        const outcome = await Promise.race([
          Promise.resolve(handler.call(consumer, request, handlerAbort.signal)),
          result.then(resolution => resolution.outcome),
        ]);
        await send({ outcome, by: "handler" });
      } catch (error) {
        this.log().warn("conversation_permission_handler_failed", { turnId, id, error: String(error) });
        await send(refuse("handler"));
      }
    };
    void runHandler().catch(failed);
    return result;
  }
}
