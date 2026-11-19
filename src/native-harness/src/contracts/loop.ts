/** One requested tool invocation; arguments remain JSON until execution. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Neutral history. Provider state is opaque to the loop. */
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; calls: ToolCall[]; providerState?: unknown }
  | { role: "tool"; content: string; callId: string };

/** JSON schema describing the arguments accepted by a configured tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Returns one complete assistant response, without executing tools. Resolving
 * is provider evidence that the request was delivered and seen; rejecting is
 * not. Honors `signal`: stop aborts in-flight inference (decision 0013). */
export type Model = (
  messages: readonly Message[], tools: readonly ToolDefinition[], signal?: AbortSignal,
) => Promise<Extract<Message, { role: "assistant" }>>;

/** Executes only permitted tools; returns serialized successes or errors. Stop
 * aborts `signal`; a call already in flight may still have had its effect. */
export type ExecuteTool = (call: ToolCall, signal?: AbortSignal) => Promise<string>;
