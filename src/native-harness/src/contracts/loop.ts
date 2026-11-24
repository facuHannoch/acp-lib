/** One requested tool invocation; arguments remain JSON until execution. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Neutral history. Provider state is opaque to the loop. */
export type Message =
  | { role: "system" | "user"; content: string; parts?: readonly import("./attachments.ts").InputPart[] }
  | { role: "assistant"; content: string | null; calls: ToolCall[]; providerState?: unknown }
  | { role: "tool"; content: string; callId: string; /** Decision 0021; absent means a legacy success. */ outcome?: import("./tools.ts").ToolOutcome };

/** JSON schema describing the arguments accepted by a configured tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Legacy complete-response adapter. Wrap through the model call runner for
 * validation, evidence and atomic commit (decision 0019). Honors `signal`. */
export type Model = (
  messages: readonly Message[], tools: readonly ToolDefinition[], signal?: AbortSignal,
) => Promise<Extract<Message, { role: "assistant" }>>;

/** Executes only permitted tools; returns serialized successes or errors. Stop
 * aborts `signal`; a call already in flight may still have had its effect. */
export interface ToolExecutionResult { content: string; outcome: import("./tools.ts").ToolOutcome }
export type ExecuteTool<Result = string> = (call: ToolCall, signal?: AbortSignal) => Promise<Result>;
export type ExecuteTurnTool = ExecuteTool<string | ToolExecutionResult>;
