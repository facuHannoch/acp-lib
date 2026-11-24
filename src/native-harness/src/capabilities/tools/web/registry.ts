import type { ToolDefinition } from "../../../contracts/loop.ts";
import { resolveWebCredentials, type Validated, type WebConfig } from "./config.ts";
import { WEB_FETCH, WEB_SEARCH, webDefinitions, webProblem } from "./definitions.ts";
import { runExa, type ExaTransport, type WebResponse } from "./exa.ts";
import type { WebDispatchEvidence } from "./usage.ts";

/** Adapter implementations are supplied by the trusted assembly, never config. */
export type DirectFetch = (url: string, signal: AbortSignal, deadlineMs: number) => Promise<WebResponse>;
export interface CheckedWebRegistration {
  definition: ToolDefinition;
  /** Called before approval and again immediately before dispatch. */
  validate(args: unknown): string | undefined;
  /** Freeze this nonsecret attribution in the dispatch transaction. */
  dispatch: WebDispatchEvidence;
  execute(args: unknown, signal: AbortSignal): Promise<WebResponse>;
}
/** Build once per executable open; credentials remain inside executor closures. */
export function createWebRegistry(config: WebConfig, env: Readonly<Record<string, string | undefined>>,
  providers: { exa: ExaTransport; http?: DirectFetch }): Validated<readonly CheckedWebRegistration[]> {
  const credentials = resolveWebCredentials(config, env);
  if (!credentials.ok) return credentials;
  if (config.webFetch?.backend === "http" && !providers.http) return { ok: false, error: { code: "invalid_config", message: "HTTP fetch adapter is unavailable" } };
  const registrations: CheckedWebRegistration[] = [];
  if (config.webSearch) {
    const options = structuredClone(config.webSearch), key = credentials.value.searchKey!;
    registrations.push({ definition: webDefinitions.find(value => value.name === WEB_SEARCH)!, validate: args => webProblem(WEB_SEARCH, args),
      dispatch: { backend: "exa", operation: "web_search", paid: true },
      execute: (args, signal) => runExa({ operation: "web_search", args: args as { query: string }, key, transport: providers.exa,
        maxResults: options.maxResults, excerptBytes: options.excerptBytes, deadlineMs: options.deadlineMs, signal }) });
  }
  if (config.webFetch) {
    const options = structuredClone(config.webFetch);
    registrations.push({ definition: webDefinitions.find(value => value.name === WEB_FETCH)!, validate: args => webProblem(WEB_FETCH, args),
      dispatch: options.backend === "exa" ? { backend: "exa", operation: "web_fetch", paid: true } : { backend: "http", operation: "web_fetch", paid: false },
      execute: (args, signal) => {
        const problem = webProblem(WEB_FETCH, args);
        if (problem) return Promise.resolve({ ok: false, code: "invalid_arguments", message: "Invalid web tool arguments", usage: {} });
        return options.backend === "exa"
          ? runExa({ operation: "web_fetch", args: args as { url: string }, key: credentials.value.fetchKey!, transport: providers.exa, deadlineMs: options.deadlineMs, signal })
          : providers.http!((args as { url: string }).url, signal, options.deadlineMs ?? 15000).then(result => ({ ...result, usage: {} }));
      } });
  }
  return { ok: true, value: registrations };
}
