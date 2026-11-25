import agent from "./instructions/agent.md" with { type: "text" };
import agentDemo from "./instructions/agent-demo.md" with { type: "text" };
import harness from "./instructions/harness.md" with { type: "text" };

// The stable "System prompt" is composed of two parts:
// Agent instructions: behavior, personality, etc
// Harness instructions: A short, stable explanation of how to interpret attributed history and active input. Tool-specific usage guidance lives with the tool definitions


// Static text imports also include the built-in instructions in compiled Bun binaries.
const instructions = { agent, "agent-demo": agentDemo, harness };

/** Load the Markdown selected by the consumer or context builder. */
export function loadInstructions(file: keyof typeof instructions): string {
  return instructions[file];
}

/** Compose the system message used by inference and the Live Context preview. */
export function composeSystemPrompt(agentInstructions: string): string {
  return [agentInstructions, harness.trimEnd()].filter(Boolean).join("\n\n");
}
