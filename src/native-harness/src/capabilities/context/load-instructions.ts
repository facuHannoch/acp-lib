import { readFileSync } from "node:fs";

type InstructionFile = "agent" | "agent-demo" | "harness";

// The stable "System prompt" is composed of two parts:
// Agent instructions: behavior, personality, etc
// Harness instructions: A short, stable explanation of how to interpret attributed history and active input. Tool-specific usage guidance lives with the tool definitions


/** Load the Markdown selected by the consumer or context builder. */
export function loadInstructions(file: InstructionFile): string {
  return readFileSync(new URL(`./instructions/${file}.md`, import.meta.url), "utf8");
}


let harnessInstructions: string | undefined;

/** Compose the system message used by inference and the Live Context preview. */
export function composeSystemPrompt(agentInstructions: string): string {
  harnessInstructions ??= loadInstructions("harness").trimEnd();
  return [agentInstructions, harnessInstructions].filter(Boolean).join("\n\n");
}
