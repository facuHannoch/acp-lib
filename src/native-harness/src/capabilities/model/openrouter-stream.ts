import type { ModelAttempt, ModelAttemptEvent } from "../../contracts/model-execution.ts";
import { createHash } from "node:crypto";
import { OPENCODE_GO_BASE_URL, type CompatibleModel } from "../../contracts/config-permissions.ts";
import { imageDataPrefix, readVerifiedImage, VisionInputError, type AttachmentLookup } from "../attachments/vision.ts";
import { ATTACHMENT_LIMITS, type AttachmentMetadata } from "../../contracts/attachments.ts";
import { chatRequestSizer, prepareChatRequest } from "./chat-request.ts";
import { exceededContextBudget } from "../../util/context-budget.ts";

const providerContextFailure = { type: "failure", kind: "invalid_request", message: "Provider rejected the request context length",
  contextFailure: { limit: "provider_context" } } as const;

function isProviderContextError(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("error" in value) || !value.error || typeof value.error !== "object") return false;
  const error = value.error;
  if ("code" in error && ["context_length_exceeded", "context_window_exceeded", "max_context_length_exceeded"].includes(String(error.code))) return true;
  return "message" in error && typeof error.message === "string" && /maximum context length|context window (?:has been |is )?exceeded/i.test(error.message);
}

/** Error bodies are only needed for classification. Read a small prefix and
 * release the response even if the endpoint sends an unbounded body. */
async function readErrorBody(response: Response): Promise<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let value = "", remaining = 16 * 1024;
  try {
    while (remaining > 0) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(value + decoder.decode());
      value += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      remaining -= chunk.value.byteLength;
    }
    return JSON.parse(value + decoder.decode());
  } catch { return; }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** OpenRouter SSE translation stays at the provider boundary; tool fragments are
 * private until a valid terminal response is assembled by the adapter. */
type Vision = { supported: boolean; metadata: AttachmentLookup; read: (metadata: AttachmentMetadata) => Uint8Array;
  verify?: (metadata: AttachmentMetadata, signal: AbortSignal) => Promise<void> };
export function openRouterAttempt(apiKey: string, model: string, fetcher: typeof fetch = fetch, onRequest?: (body: string) => void, vision?: Vision): ModelAttempt {
  return chatAttempt(apiKey, model, fetcher, onRequest, undefined, vision);
}
export function openAICompatibleAttempt(baseUrl: string, model: string, apiKey?: string, fetcher: typeof fetch = fetch, onRequest?: (body: string) => void, metadata?: Vision["metadata"]): ModelAttempt {
  return compatibleAttempt(baseUrl, model, apiKey, fetcher, onRequest, metadata);
}

export function managedCompatibleAttempt(model: CompatibleModel, conversation: { sessionId: string; channelId: string },
  apiKey?: string, onRequest?: (body: string) => void, metadata?: Vision["metadata"], fetcher: typeof fetch = fetch): ModelAttempt {
  if (model.protocol === "openai-compatible")
    return compatibleAttempt(model.baseUrl, model.model, apiKey, fetcher, onRequest, metadata);
  // Restarts and retries share the same cache affinity. Separate channels
  // never send each other's identifiers to the provider.
  const affinity = createHash("sha256").update(JSON.stringify(["acp-client/opencode-go/v1", conversation.sessionId, conversation.channelId])).digest("hex");
  return compatibleAttempt(OPENCODE_GO_BASE_URL, model.model, apiKey, fetcher, onRequest, metadata, "ses_" + affinity);
}

function compatibleAttempt(baseUrl: string, model: string, apiKey: string | undefined, fetcher: typeof fetch,
  onRequest?: (body: string) => void, metadata?: Vision["metadata"], goSession?: string): ModelAttempt {
  const references: Vision | undefined = metadata ? { supported: false, metadata, read: () => { throw new Error("Image bytes unavailable for text-only model"); } } : undefined;
  return chatAttempt(apiKey, model, fetcher, onRequest, `${baseUrl}/chat/completions`, references, goSession);
}

function goFailureCode(status: number, body: unknown) {
  const error = body && typeof body === "object" && "error" in body ? body.error : body;
  const fields = error && typeof error === "object" ? error as { code?: unknown; type?: unknown } : undefined;
  if (fields?.code === "MissingSessionID" || fields?.type === "MissingSessionID") return "missing_session_id";
  if (status === 401 || fields?.code === "InvalidAPIKey" || fields?.type === "InvalidAPIKey") return "invalid_api_key";
  if (status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
}

function chatAttempt(apiKey: string | undefined, model: string, fetcher: typeof fetch, onRequest?: (body: string) => void,
  endpoint?: string, vision?: Vision, goSession?: string): ModelAttempt {
  return async function* (request, signal) {
    const imageUrls: string[] = [];
    const compatible = endpoint !== undefined;
    const profile = request.contextBudget;
    const wire = prepareChatRequest(model, compatible, request.tools, profile?.maxOutputTokens);
    let budget, messages: string;
    try {
      let imageBytes = 0;
      const unavailable = new Set<string>();
      const images = new Map<string, AttachmentMetadata>(), references = new Map<string, AttachmentMetadata>();
      for (const message of request.messages) if (message.role === "user" && message.parts) {
        if (!vision) throw new VisionInputError("unsupported_image", "No attachment resolver is configured");
        for (const part of message.parts) if (part.type === "attachment") {
          const metadata = vision.metadata(part.id);
          if (!metadata) unavailable.add(part.id);
          else {
            references.set(part.id, metadata);
            if (metadata.mediaType.startsWith("image/")) { imageBytes += metadata.bytes; images.set(part.id, metadata); }
          }
        }
      }
      if (unavailable.size) throw new VisionInputError("attachment_unavailable", "Attachment metadata is unavailable", [...unavailable]);
      if (endpoint && images.size) throw new VisionInputError("unsupported_image", "The configured model does not support image input", [...images.keys()]);
      if (imageBytes > ATTACHMENT_LIMITS.imageBytesPerTurn) throw new VisionInputError("transfer_limit", "Image request exceeds the turn budget");
      if (images.size && !vision!.supported) throw new VisionInputError("unsupported_image", "The configured model does not support image input", [...images.keys()]);
      const metadata = vision && ((id: string) => references.get(id));
      if (profile) {
        budget = chatRequestSizer(model, compatible, profile, metadata)(request.tools)(request.messages);
        const contextFailure = exceededContextBudget(budget);
        if (contextFailure) {
          yield { type: "failure", kind: "invalid_request", message: "Request exceeds the configured context budget", contextFailure };
          return;
        }
      }
      const bytes = new Map<string, Uint8Array>();
      for (const [id, metadata] of images) try {
        await vision!.verify?.(metadata, signal);
        bytes.set(id, readVerifiedImage(metadata, vision!.read));
      } catch { unavailable.add(id); }
      if (unavailable.size) throw new VisionInputError("attachment_unavailable", "Image bytes are unavailable", [...unavailable]);
      messages = wire.messages(request.messages, metadata, compatible ? undefined : image => {
        const url = imageDataPrefix(image.mediaType) + Buffer.from(bytes.get(image.id)!).toString("base64");
        imageUrls.push(url);
        return url;
      });
    } catch (error) {
      if (error instanceof VisionInputError) { yield { type: "failure", kind: "invalid_request", code: error.code, attachmentIds: error.attachmentIds, message: error.message }; return; }
      throw error;
    }
    const requestBytes = wire.fixedBytes + Buffer.byteLength(messages);
    if (budget && requestBytes > budget.maxRequestBytes) {
      yield { type: "failure", kind: "invalid_request", message: "Encoded request exceeds the byte cap",
        contextFailure: { limit: "request_bytes", budget: { ...budget, requestBytes } } };
      return;
    }
    const body = wire.body(messages);
    const redact = (text: string) => {
      let safe = apiKey ? text.replaceAll(apiKey, "[REDACTED]") : text;
      for (const url of imageUrls) { safe = safe.replaceAll(url, "[REDACTED_IMAGE]"); const encoded = url.slice(url.indexOf(",") + 1); if (encoded) safe = safe.replaceAll(encoded, "[REDACTED_IMAGE]"); }
      return safe;
    };
    const diagnosticProvider = endpoint ? "chat_completions" as const : "openrouter" as const;
    const errorText = () => endpoint ? "Chat Completions transport failed" : "OpenRouter transport failed";
    onRequest?.(imageUrls.length ? redact(body) : body);
    let response: Response;
    try { response = await fetcher(endpoint ?? "https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: {
      ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }), "Content-Type": "application/json",
      ...(goSession ? { "User-Agent": "acp-client/native-harness", "x-opencode-session": goSession } : {}),
    }, body, signal, ...(endpoint ? { redirect: "manual" } : {}) }); }
    catch (error) { if (!signal.aborted) yield { type: "failure", kind: "transient", message: errorText(), diagnostic: { provider: diagnosticProvider, category: "transport" } }; return; }
    if (!response.ok) {
      if (endpoint) {
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => {});
          yield { type: "failure", kind: "provider", message: "redirect_refused", diagnostic: { provider: diagnosticProvider, category: "redirect" },
            ...(goSession ? { providerFailure: `OpenCode Go HTTP ${response.status} (redirect_refused)` } : {}) }; return;
        }
        const upstream = await readErrorBody(response);
        if (isProviderContextError(upstream)) { yield providerContextFailure; return; }
        if (goSession) {
          const code = goFailureCode(response.status, upstream);
          const message = `OpenCode Go HTTP ${response.status}${code ? ` (${code})` : ""}`;
          yield { type: "failure", kind: response.status === 429 || response.status >= 500 ? "transient" : "invalid_request", message, providerFailure: message };
          return;
        }
        yield { type: "failure", kind: response.status === 429 || response.status >= 500 ? "transient" : "invalid_request", message: `Chat Completions HTTP ${response.status}`, diagnostic: { provider: diagnosticProvider, category: "http", status: response.status } }; return;
      }
      if (isProviderContextError(await readErrorBody(response))) { yield providerContextFailure; return; }
      yield { type: "failure", kind: response.status === 429 || response.status >= 500 ? "transient" : "invalid_request",
        message: `OpenRouter HTTP ${response.status}`, diagnostic: { provider: diagnosticProvider, category: "http", status: response.status } }; return;
    }
    const safeRequestId = (id: string | undefined) => endpoint && apiKey && id?.includes(apiKey) ? undefined : id;
    const requestId = safeRequestId(response.headers.get("x-request-id") ?? undefined);
    if (!response.body) return;
    let content = "", buffer = "", stop: string | undefined, providerId = requestId, reasoning = "";
    const reasoningDetails: unknown[] = [];
    let confirmed = false;
    const fragments = new Map<number, { id: string; name: string; arguments: string }>();
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try {
      while (!signal.aborted) {
        const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; if (chunk.done && buffer) { lines.push(buffer); buffer = ""; }
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
          let payload: { id?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; choices?: { finish_reason?: string | null; delta?: { content?: string | null; reasoning?: string | null; reasoning_details?: unknown[]; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
          try { payload = JSON.parse(data); } catch { yield { type: "failure", kind: "provider", message: endpoint ? "Malformed Chat Completions stream" : "Malformed OpenRouter stream" }; return; }
          if (isProviderContextError(payload)) { yield providerContextFailure; return; }
          if (!providerId && payload.id) providerId = safeRequestId(payload.id);
          // A parsed response frame, unlike an HTTP success header, is evidence
          // the provider has accepted the inference request.
          if (!confirmed) { confirmed = true; yield { type: "accepted", ...(providerId ? { providerRequestId: providerId } : {}) }; }
          if (payload.usage) yield { type: "usage", usage: { ...(payload.usage.prompt_tokens !== undefined ? { inputTokens: payload.usage.prompt_tokens } : {}), ...(payload.usage.completion_tokens !== undefined ? { outputTokens: payload.usage.completion_tokens } : {}), ...(payload.usage.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {}) } };
          const choice = payload.choices?.[0]; if (!choice) continue;
          const delta = choice.delta;
          if (delta?.reasoning) reasoning += delta.reasoning;
          if (delta?.reasoning_details) reasoningDetails.push(...delta.reasoning_details);
          if (delta?.content) { content += delta.content; yield { type: "text_delta", text: delta.content }; }
          if (delta?.tool_calls?.length) {
            yield { type: "seen" };
            for (const f of delta.tool_calls) { if (!Number.isSafeInteger(f.index) || f.index < 0) { yield { type: "failure", kind: "provider", message: "Invalid tool fragment index" }; return; }
              const current = fragments.get(f.index) ?? { id: "", name: "", arguments: "" }; current.id += f.id ?? ""; current.name += f.function?.name ?? ""; current.arguments += f.function?.arguments ?? ""; fragments.set(f.index, current); }
          }
          if (choice.finish_reason) stop = choice.finish_reason;
        }
        if (chunk.done) break;
      }
      if (signal.aborted || !stop) return;
      const ordered = [...fragments.entries()].sort((a, b) => a[0] - b[0]);
      if (ordered.some(([n], i) => n !== i)) { yield { type: "failure", kind: "provider", message: "Non-contiguous tool fragments" }; return; }
      const stopReason = stop === "stop" ? "complete" : stop === "tool_calls" ? "tool_calls" : stop === "length" ? "output_limit" : undefined;
      if (!stopReason) { yield { type: "failure", kind: "provider", message: endpoint ? "Unsupported Chat Completions finish reason" : "Unsupported OpenRouter finish reason" }; return; }
      const calls = ordered.map(([, value]) => value);
      const message = { role: "assistant" as const, content: content || null, calls };
      const event: ModelAttemptEvent = { type: "response", response: { ...message, stopReason, ...(endpoint ? {} : { providerState: { role: "assistant", content: message.content,
        ...(reasoning ? { reasoning } : {}), ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) } }) }, ...(providerId ? { providerRequestId: providerId } : {}) };
      yield event;
    } catch (error) { if (!signal.aborted) yield { type: "failure", kind: "transient", message: errorText(), diagnostic: { provider: diagnosticProvider, category: "transport" } }; }
    finally { if (endpoint || profile) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
}
