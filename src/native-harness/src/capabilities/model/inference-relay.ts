import type { ModelAttempt } from "../../contracts/model-execution.ts";
import type { InferenceRelayGrant } from "../../contracts/protocol.ts";
import { openAICompatibleAttempt } from "./openrouter-stream.ts";

const expired = {
  type: "failure", kind: "invalid_config", message: "Inference relay credential expired",
  diagnostic: { provider: "chat_completions", category: "relay_expired" },
} as const;

export function createRelayAuthority(initial: InferenceRelayGrant) {
  let current = { grant: initial, revoked: false };
  return {
    capture: () => current,
    replace(grant: InferenceRelayGrant) { current = { grant, revoked: false }; },
    revoke(captured: typeof current) { if (current === captured) current.revoked = true; },
  };
}
export type RelayAuthority = ReturnType<typeof createRelayAuthority>;

const refusals = new Map([
  ["native_grant_revoked", 401], ["native_authentication_required", 401],
  ["native_source_rejected", 403], ["native_admission_rejected", 403], ["native_policy_mismatch", 403],
  ["native_allowance_exhausted", 429], ["native_provider_authentication_failed", 502],
  ["native_provider_model_failed", 502], ["native_unavailable", 503],
]);
async function relayRefusal(response: { status: number; body: ReadableStream<Uint8Array> | null }) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = 16 * 1024, text = "";
  const deadline = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => deadline.resolve(undefined), 1000);
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline.promise]);
      if (!next) return;
      if (next.done) break;
      remaining -= next.value.byteLength;
      if (remaining < 0) return;
      text += decoder.decode(next.value, { stream: true });
    }
    const type: unknown = JSON.parse(text + decoder.decode())?.error?.type;
    if (typeof type === "string" && refusals.get(type) === response.status) return type;
  } catch { return; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** A relay attempt owns its direct dispatcher and releases it on any terminal
 * event, including cancellation by the model runner. */
export function inferenceRelayAttempt(model: string, authority: RelayAuthority,
  metadata?: Parameters<typeof openAICompatibleAttempt>[5],
  onRequest?: Parameters<typeof openAICompatibleAttempt>[4]): ModelAttempt {
  return async function* (request, signal) {
    const captured = authority.capture(), { grant } = captured;
    const isExpired = () => grant.expiresAtMs !== undefined && Date.now() >= grant.expiresAtMs;
    const refusalEvent = (reason: string) => ({
      type: "failure", kind: "provider", message: "Inference relay refused",
      diagnostic: { provider: "chat_completions", category: "relay_refusal", reason }, noRetry: true,
    }) as const;
    if (captured.revoked) { yield refusalEvent("native_grant_revoked"); return; }
    if (isExpired()) { yield expired; return; }
    // Bun's package-name shim can use global, proxy-aware fetch. An explicit
    // unshimmed dispatcher sends this request only to the validated origin.
    const undici: typeof import("undici") = await import(new URL("index.js", import.meta.resolve("undici/package.json")).href);
    const dispatcher = new undici.Agent({ connect: { rejectUnauthorized: true } });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= dispatcher.destroy().catch(() => {});
    const abort = () => { void close(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let dispatchExpired = false, dispatched = false;
    let refusal: string | undefined;
    const directFetch = (async (input: unknown, init?: RequestInit) => {
      if (isExpired()) {
        dispatchExpired = true;
        throw new Error(expired.message);
      }
      if (authority.capture() !== captured) { refusal = "native_unavailable"; throw new Error("Inference relay replaced"); }
      if (captured.revoked) { refusal = "native_grant_revoked"; throw new Error("Inference relay revoked"); }
      (init?.signal ?? signal).throwIfAborted();
      dispatched = true;
      const response = await undici.fetch(String(input), {
        method: "POST", body: String(init?.body),
        headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined,
        redirect: "manual", dispatcher,
      });
      if (response.ok) return response;
      refusal = await relayRefusal(response);
      if (refusal === "native_grant_revoked") authority.revoke(captured);
      return new Response(null, { status: response.status });
    }) as unknown as typeof fetch;
    const attempt = openAICompatibleAttempt(grant.baseUrl, model, grant.bearerToken, directFetch, onRequest, metadata);
    const token = grant.bearerToken;
    const marker = "[relay credential hidden]";
    const redact = (text: string) => text.replaceAll(token, marker.includes(token) ? "[ ]" : marker);
    let pending = "";
    try {
      for await (const event of attempt(request, signal)) {
        if (dispatchExpired) { yield expired; return; }
        if (refusal) { yield refusalEvent(refusal); return; }
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
        yield event.type === "failure" && dispatched ? { ...event, noRetry: true } : event;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await close();
    }
  };
}
