import type { AgentSessionEvent } from "../agent-conversation-contracts.ts";
import type { Logger } from "../logger.ts";
import type { PermissionOutcome, PermissionRequest, PromptHandlers } from "../types.ts";
import { selectPermissionOutcome } from "./outcome.ts";
import { permissionLevel, recordingPermissionHandlers, type PermissionPolicyConfig } from "./policy.ts";

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
  readonly requestedAt: number;
  readonly hostHandled: boolean;
  readonly resolution: Promise<PermissionResolution>;
  answer(resolution: PermissionResolution): Promise<boolean>;
}

export const nativePermissionRequests = new WeakMap<PermissionRequest, NativePermission>();

interface PermissionEntry {
  readonly turnId: string;
  close(resolution: PermissionResolution): void;
}

export class ConversationPermissions {
  private readonly pending = new Set<PermissionEntry>();
  private stopped = false;

  constructor(
    private readonly emit: (event: AgentSessionEvent) => void,
    private readonly log: () => Logger,
  ) {}

  end(turnId: string): void {
    for (const entry of this.pending) if (entry.turnId === turnId) entry.close(cancelledPermission);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending) entry.close(cancelledPermission);
  }

  internalHandler(turnId: string, policy: PermissionPolicyConfig): PromptHandlers {
    const onPermissionRequest: NonNullable<PromptHandlers["onPermissionRequest"]> = async (request, signal) =>
      (await this.request(turnId, request, policy, undefined, signal)).outcome;
    recordingPermissionHandlers.add(onPermissionRequest);
    return { onPermissionRequest };
  }

  request(
    turnId: string,
    request: PermissionRequest,
    policy: PermissionPolicyConfig,
    consumer: PromptHandlers | undefined,
    signal?: AbortSignal,
    recordRequested?: () => Promise<void>,
  ): Promise<PermissionResolution> {
    if (this.stopped || signal?.aborted) return Promise.resolve(cancelledPermission);
    const native = nativePermissionRequests.get(request);
    const id = crypto.randomUUID();
    const handlerAbort = new AbortController();
    const abort = () => entry.close(cancelledPermission);
    const handler = consumer?.onPermissionRequest;
    let resolve!: (resolution: PermissionResolution) => void;
    const result = new Promise<PermissionResolution>(accept => { resolve = accept; });
    const entry: PermissionEntry = {
      turnId,
      close: resolution => {
        if (!this.pending.delete(entry)) return;
        signal?.removeEventListener("abort", abort);
        handlerAbort.abort();
        const outcome = permissionOutcome(request, resolution);
        // Finish notifying all request listeners before any reentrant stop publishes its resolution.
        queueMicrotask(() => this.emit({ kind: "permission_resolved", id, outcome, by: resolution.by }));
        resolve(resolution);
      },
    };
    this.pending.add(entry);
    signal?.addEventListener("abort", abort, { once: true });
    if (native) void native.resolution.then(entry.close);

    const nominate = async (decision: PermissionResolution) => {
      if (!this.pending.has(entry)) return;
      if (native) await native.answer(decision);
      else entry.close(decision);
    };

    this.emit({
      kind: "permission_requested", id, turnId, tool: request.tool && Object.freeze({ ...request.tool }),
      title: request.title, options: Object.freeze(request.options.map(option => Object.freeze({ ...option }))),
    });

    const run = async () => {
      if (native?.hostHandled) return;
      let by: PermissionResolutionSource = "default";
      try {
        await recordRequested?.();
        if (!this.pending.has(entry)) return;
        const level = permissionLevel(request, policy, Boolean(native));
        if (level === "ask" && handler) {
          by = "handler";
          const outcome = await handler.call(consumer, request, handlerAbort.signal);
          await nominate({ outcome, by });
        } else {
          const outcome = selectPermissionOutcome(level === "ask" ? "deny" : level, request.options)!;
          await nominate({ outcome, by, refused: level === "ask" });
        }
      } catch (error) {
        this.log().warn("conversation_permission_failed", { turnId, id, error: String(error) });
        await nominate({ outcome: selectPermissionOutcome("deny", request.options)!, by, refused: true });
      }
    };
    void run().catch(error => {
      this.log().warn("conversation_permission_response_failed", { turnId, id, error: String(error) });
      entry.close(cancelledPermission);
    });
    return result;
  }
}
