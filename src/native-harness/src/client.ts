export { HarnessClient, HarnessClientError } from "./interfaces/client.ts";
export { createInProcessTransport } from "./interfaces/protocol/in-process.ts";
export { createStdioTransport } from "./interfaces/protocol/stdio-client.ts";
export type { StdioConnection } from "./contracts/protocol.ts";
export type { ChannelEvent } from "./contracts/events.ts";
export type { InitializeParams, CreateParams, PushParams, ProtocolConfig, ClientTransport } from "./contracts/protocol.ts";
export type { ManagedConfig, ManagedModel, ToolPolicy, ToolDecision, ItemPolicy, ApprovalRequest, ApprovalAnswer, ApprovalCloseReason } from "./contracts/config-permissions.ts";

export type { ModelCallSummary, ModelAttemptSummary, ModelUsage, ModelTextEvent, ModelTextPage } from "./contracts/model-execution.ts";
export { aggregateUsage } from "./capabilities/model/usage.ts";
