import { MAX_WORKER_APPROVALS, MAX_WORKER_APPROVAL_BYTES, type WorkerApprovalView } from "../native-harness/src/client.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { AgentSessionEvent } from "../agent-conversation-contracts.ts";
import type { Logger } from "../logger.ts";
import type { PermissionOutcome, PermissionRequest, PromptHandlers } from "../types.ts";
import { acpPermissionArrivals, permissionArrival, type PermissionArrival } from "./arrival.ts";
import { DEFAULT_PERMISSION_TIMEOUT_MS } from "./consumer-config.ts";
import type { PermissionSettings } from "./matcher.ts";
import { selectPermissionOutcome, unansweredPermissionOutcome } from "./outcome.ts";
import { permissionLevel, recordingPermissionHandlers, type ConversationPermissionConfig } from "./policy.ts";

export type PermissionResolutionSource = "handler" | "consumer" | "delegator" | "default" | "timeout" | "turn_ended";
export type PermissionResolution = {
  readonly outcome: PermissionOutcome;
  readonly by: PermissionResolutionSource;
  /** ACP can only cancel on the wire if no reject option is offered. */
  readonly refused?: boolean;
};
export interface WorkerPermissionSource {
  readonly kind: "worker";
  readonly handle: string;
  readonly conversationId: AgentConversationId;
}

interface PermissionRequestEventFields {
  readonly kind: "permission_requested";
  readonly id: string;
  readonly tool: PermissionRequest["tool"];
  readonly title: string | undefined;
  readonly options: readonly Readonly<PermissionRequest["options"][number]>[];
  readonly expiresAt?: number;
}

export type ConversationPermissionEvent =
  | (PermissionRequestEventFields & ({ readonly turnId: string; readonly source?: never }
    | { readonly turnId?: string; readonly source: WorkerPermissionSource }))
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
  onCancelTurn?(listener: () => void): void;
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
  readonly turnId?: string;
  close(resolution: PermissionResolution): void;
  closeLocally(stopping?: boolean): void;
  answer?(optionId: string): Promise<boolean>;
  modelView?(policyNames: readonly string[]): WorkerApprovalView | undefined;
  answerAsModel?(option: string, policyNames: readonly string[]): Promise<boolean>;
}

const forwarding = new WeakMap<object, {
  readonly coordinator: ConversationPermissions;
  readonly policy: () => ConversationPermissionConfig;
}>();

export interface ModelWorkerApproval {
  readonly mode: "model" | "both";
  readonly action: WorkerApprovalView["action"];
  readonly authorize: (policies: readonly string[]) => boolean;
  deliver(id: string, signal: AbortSignal): Promise<boolean>;
}

export function readForwardedWorkerPermissions(conversation: object | undefined, policies: readonly string[]): readonly WorkerApprovalView[] {
  const destination = conversation && forwarding.get(conversation);
  return destination ? destination.coordinator.modelViews(policies) : [];
}

export async function answerForwardedWorkerPermission(conversation: object | undefined, id: string, option: string,
  policies: readonly string[]): Promise<boolean> {
  const destination = conversation && forwarding.get(conversation);
  return destination ? destination.coordinator.answerAsModel(id, option, policies) : false;
}

export interface ForwardPermissionOptions {
  readonly source: WorkerPermissionSource;
  readonly includeAllowAlways: boolean;
  readonly model?: ModelWorkerApproval;
  readonly unanswered?: PermissionSettings["unanswered"];
  readonly signal?: AbortSignal;
}

export async function forwardPermission(
  conversation: object | undefined, request: PermissionRequest, options: ForwardPermissionOptions,
): Promise<PermissionOutcome> {
  const destination = conversation && forwarding.get(conversation);
  if (!destination) return unansweredPermissionOutcome(request.options, options.unanswered);
  const { source, signal, includeAllowAlways } = options;
  // A forwarded UI request must not answer the worker's native ticket directly.
  const offered = {
    ...request, options: includeAllowAlways ? request.options : request.options.filter(option => option.kind !== "allow_always"),
  };
  const time = acpPermissionArrivals.get(request);
  if (time && offered !== request) acpPermissionArrivals.set(offered, time);
  return (await destination.coordinator.request(undefined, offered, destination.policy(), undefined, signal, undefined, source, options.model)).outcome;
}

export class ConversationPermissions {
  private readonly pending = new Map<string, PermissionEntry>();
  private stopped = false;

  constructor(
    private readonly emit: (event: AgentSessionEvent) => void,
    private readonly log: () => Logger,
    conversation?: object,
    policy?: () => ConversationPermissionConfig,
  ) {
    if (conversation && policy) forwarding.set(conversation, { coordinator: this, policy });
  }

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

  modelViews(policies: readonly string[]): readonly WorkerApprovalView[] {
    const views: WorkerApprovalView[] = [];
    for (const entry of this.pending.values()) {
      if (!entry.answerAsModel) continue;
      const view = entry.modelView?.(policies);
      if (!view || Buffer.byteLength(JSON.stringify([...views, view])) > MAX_WORKER_APPROVAL_BYTES) continue;
      views.push(view);
      if (views.length === MAX_WORKER_APPROVALS) break;
    }
    return views;
  }

  async answerAsModel(id: string, option: string, policies: readonly string[]): Promise<boolean> {
    return await this.pending.get(id)?.answerAsModel?.(option, policies) ?? false;
  }

  internalHandler(turnId: string, policy: ConversationPermissionConfig): PromptHandlers {
    const onPermissionRequest: NonNullable<PromptHandlers["onPermissionRequest"]> = async (request, signal) =>
      (await this.request(turnId, request, policy, undefined, signal)).outcome;
    recordingPermissionHandlers.add(onPermissionRequest);
    return { onPermissionRequest };
  }

  request(
    turnId: string | undefined,
    request: PermissionRequest,
    policy: ConversationPermissionConfig,
    consumer: PromptHandlers | undefined,
    signal?: AbortSignal,
    recordRequested?: () => Promise<void>,
    source?: WorkerPermissionSource,
    model?: ModelWorkerApproval,
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
    if (source) level = "ask";
    else if (!native?.hostHandled && !native?.settled) {
      try {
        level = permissionLevel(request, policy, Boolean(native));
      } catch (error) {
        this.log().warn("conversation_permission_rule_failed", { turnId, id, error: String(error) });
      }
    }

    const waitForConsumer = level === "ask" && !handler && model?.mode !== "model" && policy.answersPermissions === true;
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

    if (waitForConsumer || model) {
      const claim = () => {
        if (!entry.answer && !entry.answerAsModel) return false;
        entry.answer = undefined;
        entry.answerAsModel = undefined;
        clearTimeout(timer);
        return true;
      };
      const expire = () => {
        if (claim()) void send(refuse("timeout")).catch(failed);
      };
      const answer = async (optionId: string, by: "consumer" | "delegator") => {
        if (remaining() <= 0) expire();
        if (!offered.some(option => option.optionId === optionId) || !claim()) return false;
        const accepted = await sendAfterRecord({ outcome: { outcome: "selected", optionId }, by }).catch(failed);
        return accepted && (await result).by === by;
      };
      if (waitForConsumer) entry.answer = optionId => answer(optionId, "consumer");
      if (model) {
        const choices = new Map<WorkerApprovalView["choices"][number], string>();
        for (const option of offered) {
          const kind = option.kind === "allow_once" ? "allow_once" : option.kind === "reject_once" ? "reject_once" : undefined;
          if (kind && !choices.has(kind)) choices.set(kind, option.optionId);
        }
        entry.answerAsModel = async (option, policies) => {
          const optionId = option === "allow_once" || option === "reject_once" ? choices.get(option) : undefined;
          return optionId !== undefined && model.authorize(policies) && answer(optionId, "delegator");
        };
        if (source) entry.modelView = policies => {
          if (remaining() <= 0 || !model.authorize(policies)) return;
          return { request: id, worker: source.handle, action: model.action, choices: [...choices.keys()], expiresAt: arrival.wallTime + budget };
        };
        const unavailable = () => {
          if (!entry.answerAsModel || !this.pending.has(id)) return;
          if (!entry.answer && claim()) {
            void sendAfterRecord({
              outcome: unansweredPermissionOutcome(request.options, policy.permissions?.unanswered),
              by: "default", refused: true,
            }).catch(failed);
          } else entry.answerAsModel = undefined;
        };
        void Promise.resolve().then(async () => {
          if (!entry.answerAsModel || handlerAbort.signal.aborted) return;
          if (!await model.deliver(id, handlerAbort.signal)) unavailable();
        }).catch(unavailable);
      }
      timer = setTimeout(expire, Math.max(0, Math.ceil(remaining())));
      // A failed requested record cannot leave an otherwise unclaimed request open.
      void record.catch(() => { if (claim()) void sendAfterRecord(refuse("default")).catch(failed); });
    }

    if (!model || waitForConsumer) this.emit({
      kind: "permission_requested", id, ...(source ? { source: Object.freeze({ ...source }) } : { turnId: turnId! }),
      tool: request.tool && Object.freeze(structuredClone(request.tool)),
      title: request.title, options: offered, ...(waitForConsumer || model ? { expiresAt: arrival.wallTime + budget } : {}),
    });

    if (native?.hostHandled || native?.settled || waitForConsumer || model) return result;
    if (level !== "ask" || !handler) {
      const unanswered = level === "ask" && !handler;
      const cancelTurn = unanswered && policy.permissions?.unanswered === "cancel";
      const decision = cancelTurn
        ? { outcome: unansweredPermissionOutcome(request.options, "cancel"), by: "default" as const }
        : level === "ask" || level === undefined ? refuse("default")
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
