export { HarnessClient, HarnessClientError, FunctionError } from "./interfaces/client.ts";
export type { FunctionHandler, ResultReader } from "./interfaces/client.ts";
export type { ToolRegistration, ToolCatalogInput, ToolAvailability, ToolInvocation, ToolInvocationState, ToolOutcome, ResultReference, TurnPhase, FunctionCall, FunctionResult, ResultRead, ResultPage } from "./contracts/tools.ts";
export { createInProcessTransport } from "./interfaces/protocol/in-process.ts";
export { createStdioTransport } from "./interfaces/protocol/stdio-client.ts";
export type { StdioConnection } from "./contracts/protocol.ts";
export type { ChannelEvent } from "./contracts/events.ts";
export type { InitializeParams, CreateParams, PushParams, NotifyParams, ProtocolConfig, ClientTransport, PendingChannelChange, ChannelChangeResult, LoadResult, StatusResult, ChannelStatusResult, ItemStatus, TurnStatus, StoredMessage } from "./contracts/protocol.ts";
export type { InferenceRelayGrant } from "./contracts/protocol.ts";
export type { ManagedConfig, ManagedModel, ModelContextBudget, ToolPolicy, ToolDecision, ItemPolicy, ApprovalRequest, ApprovalAnswer, ApprovalCloseReason } from "./contracts/config-permissions.ts";
export type { ContextLimitFailure, ContextBudgetMeasurement } from "./contracts/context.ts";

export type { ModelCallSummary, ModelAttemptSummary, ModelUsage, ModelTextEvent, ModelTextPage } from "./contracts/model-execution.ts";
export { aggregateUsage } from "./capabilities/model/usage.ts";

export type { Reminder, ReminderChange, ReminderChangeResult, ReminderList, ReminderListParams, ReminderWake, ReminderSessionEvent, ConditionalStopParams, ConditionalStopResult } from "./contracts/reminders.ts";

export type { InitializeResult } from "./contracts/protocol.ts";
export type { OpenResult } from "./contracts/operator-controls.ts";
export type { ReminderBlockReason, OneOffSchedule, ReminderSchedule, RoutineSchedule, IntervalRoutineSchedule, CalendarRoutineSchedule, RoutineEnd, RoutineDeliveryOptions, RoutineTimezoneMigration, ReminderLimits, ReminderChannelEvent } from "./contracts/reminders.ts";
