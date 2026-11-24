import type { ModelAttempt, ModelAttemptEvent } from "../../contracts/model-execution.ts";
import type { Message } from "../../contracts/loop.ts";

function wireMessage(message: Message, preserveProviderState: boolean): unknown {
  if (message.role === "assistant") return (preserveProviderState ? message.providerState : undefined) ?? { role: "assistant", content: message.content,
    ...(message.calls.length ? { tool_calls: message.calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}) };
  return message.role === "tool" ? { role: "tool", content: message.content, tool_call_id: message.callId } : message;
}
/** OpenRouter SSE translation stays at the provider boundary; tool fragments are
 * private until a valid terminal response is assembled by the adapter. */
export function openRouterAttempt(apiKey: string, model: string, fetcher: typeof fetch = fetch, onRequest?: (body: string) => void): ModelAttempt {
  return chatAttempt(apiKey, model, fetcher, onRequest);
}

export function openAICompatibleAttempt(baseUrl: string, model: string, apiKey?: string, fetcher: typeof fetch = fetch,
  onRequest?: (body: string) => void): ModelAttempt {
  return chatAttempt(apiKey, model, fetcher, onRequest, `${baseUrl}/chat/completions`);
}

function chatAttempt(apiKey: string | undefined, model: string, fetcher: typeof fetch, onRequest?: (body: string) => void, endpoint?: string): ModelAttempt {
  const errorText = (error: unknown) => endpoint ? "Chat Completions transport failed" : String(error).replaceAll(apiKey!, "[REDACTED]");
  return async function* (request, signal) {
    const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages: request.messages.map(message => wireMessage(message, endpoint === undefined)),
      ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: "function", function: tool })), ...(endpoint ? { tool_choice: "auto" } : {}) } : {}) });
    onRequest?.(body);
    let response: Response;
    try { response = await fetcher(endpoint ?? "https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }), "Content-Type": "application/json" }, body, signal, ...(endpoint ? { redirect: "manual" } : {}) }); }
    catch (error) { if (!signal.aborted) yield { type: "failure", kind: "transient", message: errorText(error) }; return; }
    if (!response.ok) {
      if (endpoint) {
        void response.body?.cancel().catch(() => {});
        if (response.status >= 300 && response.status < 400) {
          yield { type: "failure", kind: "provider", message: "redirect_refused" };
          return;
        }
        yield { type: "failure", kind: response.status === 429 || response.status >= 500 ? "transient" : "invalid_request",
          message: `Chat Completions HTTP ${response.status}` };
        return;
      }
      const text = (await response.text()).replaceAll(apiKey!, "[REDACTED]");
      yield { type: "failure", kind: response.status === 429 || response.status >= 500 ? "transient" : "invalid_request", message: `OpenRouter HTTP ${response.status}: ${text}` }; return;
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
      if (!stopReason) { yield { type: "failure", kind: "provider", message: endpoint ? "Unsupported Chat Completions finish reason" : `Unsupported finish reason: ${stop}` }; return; }
      const calls = ordered.map(([, value]) => value);
      const message = { role: "assistant" as const, content: content || null, calls };
      const event: ModelAttemptEvent = { type: "response", response: { ...message, stopReason, ...(endpoint ? {} : { providerState: { role: "assistant", content: message.content,
        ...(reasoning ? { reasoning } : {}), ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) } }) }, ...(providerId ? { providerRequestId: providerId } : {}) };
      yield event;
    } catch (error) { if (!signal.aborted) yield { type: "failure", kind: "transient", message: errorText(error) }; }
    finally { if (endpoint) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
}
