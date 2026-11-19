import type { Message, Model, ToolDefinition } from "../../contracts/loop.ts";

type Answer = Extract<Message, { role: "assistant" }>;
export interface CapturedRequest {
  messages: Message[];
  tools: ToolDefinition[];
}

export class ScriptedModelError extends Error {
  constructor(public readonly code: "invalid_script" | "script_load_failed" | "script_exhausted", message: string) {
    super(message);
    this.name = "ScriptedModelError";
  }
}

function invalid(message: string): never { throw new ScriptedModelError("invalid_script", message); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path}: unknown field ${key}`);
}

function parseScript(value: unknown): Answer[] {
  if (!object(value)) invalid("Script must be an object");
  fields(value, ["version", "responses"], "script");
  if (value.version !== 1) invalid("Expected script version 1");
  if (!Array.isArray(value.responses) || !value.responses.length) invalid("responses must be a nonempty array");
  return value.responses.map((response: unknown, index: number) => {
    const path = `responses[${index}]`;
    if (!object(response)) invalid(`${path} must be an object`);
    fields(response, ["content", "calls"], path);
    if (response.content !== null && typeof response.content !== "string") invalid(`${path}.content must be a string or null`);
    const rawCalls = response.calls === undefined ? [] : response.calls;
    if (!Array.isArray(rawCalls)) invalid(`${path}.calls must be an array`);
    const ids = new Set<string>();
    const calls = rawCalls.map((call: unknown, callIndex: number) => {
      const location = `${path}.calls[${callIndex}]`;
      if (!object(call)) invalid(`${location} must be an object`);
      fields(call, ["id", "name", "arguments"], location);
      if (typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)) invalid(`${location}.id must be nonempty and unique within the response`);
      if (typeof call.name !== "string" || !call.name.trim()) invalid(`${location}.name must be nonempty`);
      if (!object(call.arguments)) invalid(`${location}.arguments must be a JSON object`);
      ids.add(call.id);
      return { id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) };
    });
    return { role: "assistant", content: response.content, calls };
  });
}

/** Consume one response per invocation, independently of all other instances.
 * `startAt` skips responses already consumed by an earlier process, so a
 * reopened session continues its script instead of replaying it. */
export function createScriptedModel(script: unknown, startAt = 0) {
  // The JSON round trip enforces file-equivalent data and detaches input objects.
  let answers: Answer[];
  try { answers = parseScript(JSON.parse(JSON.stringify(script))); }
  catch (error) {
    if (error instanceof ScriptedModelError) throw error;
    invalid(`Script must be JSON-serializable: ${String(error)}`);
  }
  const requests: CapturedRequest[] = [];
  let position = startAt;
  const model: Model = async (messages, tools) => {
    requests.push(structuredClone({ messages: [...messages], tools: [...tools] }));
    const answer = answers[position];
    if (!answer) throw new ScriptedModelError("script_exhausted", `Script exhausted at model call ${requests.length}; ${answers.length} responses configured`);
    position++;
    return structuredClone(answer);
  };
  return { model, requests: () => structuredClone(requests), remaining: () => answers.length - position };
}

export async function loadScriptedModel(path: string) {
  let text: string;
  try { text = await Bun.file(path).text(); }
  catch (error) { throw new ScriptedModelError("script_load_failed", `Cannot read script ${path}: ${String(error)}`); }
  let script: unknown;
  try { script = JSON.parse(text); }
  catch (error) { throw new ScriptedModelError("invalid_script", `Invalid JSON in ${path}: ${String(error)}`); }
  return createScriptedModel(script);
}
