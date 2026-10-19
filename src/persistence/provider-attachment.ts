import type { AgentMode } from "../controller.ts";

export interface ProviderAttachmentDescriptor {
  readonly attachmentAttemptId: string;
  readonly internalSessionId: string;
  readonly adapterId: string;
  readonly mode: AgentMode;
  readonly model?: string;
  readonly acquiredAt: string;
  readonly providerSessionRecordId?: string;
  readonly transitionId?: string;
}

export type ProviderAttachmentState =
  | { readonly kind: "absent" }
  | { readonly kind: "runtime_only"; readonly descriptor: ProviderAttachmentDescriptor }
  | { readonly kind: "recorded"; readonly descriptor: ProviderAttachmentDescriptor };

export interface ProviderAttachmentCommitAcknowledgement {
  readonly attachmentAttemptId: string;
  readonly providerSessionRecordId: string;
}

export function runtimeOnlyProviderAttachment(
  descriptor: ProviderAttachmentDescriptor,
): ProviderAttachmentState {
  return Object.freeze({ kind: "runtime_only", descriptor: Object.freeze({ ...descriptor }) });
}

export function recordedProviderAttachment(
  descriptor: ProviderAttachmentDescriptor,
): ProviderAttachmentState {
  return Object.freeze({ kind: "recorded", descriptor: Object.freeze({ ...descriptor }) });
}

export function acknowledgeProviderAttachment(
  state: ProviderAttachmentState,
  acknowledgement: ProviderAttachmentCommitAcknowledgement,
): ProviderAttachmentState {
  if (state.kind !== "runtime_only") return state;
  if (state.descriptor.attachmentAttemptId !== acknowledgement.attachmentAttemptId) return state;
  return recordedProviderAttachment({
    ...state.descriptor,
    providerSessionRecordId: acknowledgement.providerSessionRecordId,
  });
}
