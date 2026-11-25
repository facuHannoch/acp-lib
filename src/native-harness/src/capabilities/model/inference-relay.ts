import type { ModelAttempt } from "../../contracts/model-execution.ts";
import type { InferenceRelayGrant } from "../../contracts/protocol.ts";
import { openAICompatibleAttempt } from "./openrouter-stream.ts";

const expired = {
  type: "failure", kind: "invalid_config", message: "Inference relay credential expired",
  diagnostic: { provider: "chat_completions", category: "relay_expired" },
} as const;

/** A relay attempt owns its direct dispatcher and releases it on any terminal
 * event, including cancellation by the model runner. */
export function inferenceRelayAttempt(model: string, grant: InferenceRelayGrant,
  metadata?: Parameters<typeof openAICompatibleAttempt>[5]): ModelAttempt {
  return async function* (request, signal) {
    if (Date.now() >= grant.expiresAtMs) { yield expired; return; }
    // Bun's package-name shim can use global, proxy-aware fetch. An explicit
    // unshimmed dispatcher sends this request only to the validated origin.
    const undici: typeof import("undici") = await import(new URL("index.js", import.meta.resolve("undici/package.json")).href);
    const dispatcher = new undici.Agent({ connect: { rejectUnauthorized: true } });
    let dispatchExpired = false;
    const directFetch = (async (input: unknown, init?: RequestInit) => {
      if (Date.now() >= grant.expiresAtMs) {
        dispatchExpired = true;
        throw new Error(expired.message);
      }
      return undici.fetch(String(input), {
        method: "POST", body: String(init?.body),
        headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined,
        redirect: "manual", dispatcher,
      });
    }) as unknown as typeof fetch;
    const attempt = openAICompatibleAttempt(grant.baseUrl, model, grant.bearerToken, directFetch, undefined, metadata);
    const token = grant.bearerToken;
    const marker = "[relay credential hidden]";
    const redact = (text: string) => text.replaceAll(token, marker.includes(token) ? "[ ]" : marker);
    let pending = "";
    try {
      for await (const event of attempt(request, signal)) {
        if (dispatchExpired) { yield expired; return; }
        if (event.type === "text_delta") {
          // Retain only a possible partial credential across provider frames.
          pending = redact(pending + event.text);
          let tail = Math.min(pending.length, token.length - 1);
          while (tail > 0 && !token.startsWith(pending.slice(-tail))) tail--;
          const visible = pending.slice(0, pending.length - tail);
          pending = pending.slice(pending.length - tail);
          if (visible) yield { type: "text_delta", text: visible };
          continue;
        }
        if (event.type === "response") {
          if (event.response.calls.some(call => [call.id, call.name, call.arguments].some(value => value.includes(token)))) {
            yield { type: "failure", kind: "provider", message: "Unsafe inference relay response",
              diagnostic: { provider: "chat_completions", category: "protocol" } };
            return;
          }
          if (pending) yield { type: "text_delta", text: pending };
          yield { ...event, response: { ...event.response,
            content: event.response.content === null ? null : redact(event.response.content) } };
          return;
        }
        yield event;
      }
    } finally { await dispatcher.destroy(); }
  };
}
