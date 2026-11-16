import type { Agent, TurnInput, TurnRunner } from "./agent.ts";
import type { Model, ExecuteTool, ToolDefinition } from "./loop.ts";
import type { SharedContextStore } from "./context.ts";
import type { EventSink } from "./events.ts";

export interface TurnServices { model: Model; tools: readonly ToolDefinition[]; executeTool: ExecuteTool }
/** Host composition controls implementations; the kernel sees only contracts. */
export interface SessionOptions {
  systemPrompt: string;
  store?: SharedContextStore;
  configureTurn(input: TurnInput, notify: Agent["notify"]): TurnServices;
  wrapTurn?: (run: TurnRunner) => TurnRunner;
}
export interface HarnessSession {
  agent: Agent;
  store: SharedContextStore;
  subscribe(listener: EventSink): () => void;
}
