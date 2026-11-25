import type { AttachmentMetadata } from "../../contracts/attachments.ts";
import type { ContextRequestSizer } from "../../contracts/context.ts";
import type { ModelContextBudget } from "../../contracts/config-permissions.ts";
import type { Message, ToolDefinition } from "../../contracts/loop.ts";
import { imageDataPrefix, projectVisionParts, type AttachmentLookup } from "../attachments/vision.ts";
import { effectiveContextBudget } from "../../util/context-budget.ts";

type ImageUrl = (metadata: AttachmentMetadata) => string;

function wireMessage(message: Message, compatible: boolean, metadata?: AttachmentLookup, imageUrl?: ImageUrl): unknown {
  if (message.role === "assistant") return (compatible ? undefined : message.providerState) ?? { role: "assistant", content: message.content,
    ...(message.calls.length ? { tool_calls: message.calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}) };
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.callId };
  if (message.role !== "user" || !message.parts || !metadata) return message;
  const separator = message.content.indexOf("\n\n");
  const attribution = message.content.startsWith("Participant: ") && separator >= 0 ? message.content.slice(0, separator + 2) : "";
  const content = projectVisionParts(message.parts, metadata, imageUrl);
  if (compatible) return { role: "user", content: attribution + content.map(part => part.type === "text" ? part.text : "").join("") };
  return { role: "user", content: attribution ? [{ type: "text", text: attribution }, ...content] : content };
}

/** Render the fixed fields only once, so fitting optional history does not
 * repeatedly serialize a large tool catalog. */
export function prepareChatRequest(model: string, compatible: boolean, tools: readonly ToolDefinition[], maxOutputTokens?: number) {
  const fixed = JSON.stringify({ model, stream: true, stream_options: { include_usage: true },
    ...(maxOutputTokens === undefined ? {} : compatible ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }) });
  const prefix = fixed.slice(0, -1) + ',"messages":';
  const offer = tools.length ? JSON.stringify(tools.map(tool => ({ type: "function", function: tool }))) : "";
  const suffix = (offer ? ',"tools":' + offer + (compatible ? ',"tool_choice":"auto"' : "") : "") + "}";
  return {
    messages: (messages: readonly Message[], metadata?: AttachmentLookup, imageUrl?: ImageUrl) =>
      JSON.stringify(messages.map(message => wireMessage(message, compatible, metadata, imageUrl))),
    fixedBytes: Buffer.byteLength(prefix) + Buffer.byteLength(suffix),
    toolDefinitionBytes: Buffer.byteLength(offer),
    body: (messages: string) => prefix + messages + suffix,
  };
}

export function chatRequestSizer(model: string, compatible: boolean, profile: ModelContextBudget,
  metadata?: AttachmentLookup): ContextRequestSizer {
  const effective = effectiveContextBudget(profile);
  return tools => {
    const wire = prepareChatRequest(model, compatible, tools, profile.maxOutputTokens);
    const known = new Map<string, AttachmentMetadata | undefined>();
    const lookup = metadata && ((id: string) => {
      if (!known.has(id)) known.set(id, metadata(id));
      return known.get(id);
    });
    return messages => {
      let imageBytes = 0, imageCount = 0;
      const projected = wire.messages(messages, lookup, compatible ? undefined : image => {
        imageCount += 1;
        // The empty URL placeholder already contributes its JSON quotes.
        imageBytes += Buffer.byteLength(JSON.stringify(imageDataPrefix(image.mediaType))) - 2 + 4 * Math.ceil(image.bytes / 3);
        return "";
      });
      const textBytes = wire.fixedBytes + Buffer.byteLength(projected);
      return { estimator: "chat-completions-utf8-v1", ...effective, toolDefinitionBytes: wire.toolDefinitionBytes,
        estimatedInputTokens: textBytes + imageCount * 4096, requestBytes: textBytes + imageBytes };
    };
  };
}

