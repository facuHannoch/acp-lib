import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { PermissionRequest } from "../types.ts";

/** Project the ACP packet while keeping the existing prompt callback fields and raw packet. */
export function toPermissionRequest(params: RequestPermissionRequest): PermissionRequest {
  const call = params.toolCall;
  const tool = {
    ...(call?.kind == null ? {} : { kind: call.kind }),
    ...(call?.rawInput === undefined ? {} : { rawInput: call.rawInput }),
  };
  return {
    toolCallId: call?.toolCallId ?? "",
    title: call?.title ?? undefined,
    options: (params.options ?? []).map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    ...(call?.kind != null || call?.rawInput !== undefined ? { tool } : {}),
    raw: params,
  };
}
