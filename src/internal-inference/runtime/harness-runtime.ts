import { AgentController, type AgentControllerConfig } from "../../controller.ts";
import type {
  InternalInferenceRequest,
  InternalInferenceResult,
  InternalInferenceRuntime,
  InternalInferenceRuntimeLifecycle,
} from "../contracts.ts";

export interface HarnessInternalInferenceRuntimeConfig {
  controllerConfig(request: InternalInferenceRequest): AgentControllerConfig;
}

/** Executes one internal inference in a fresh, disposable ACP provider session. */
export class HarnessInternalInferenceRuntime implements InternalInferenceRuntime {
  constructor(private readonly config: HarnessInternalInferenceRuntimeConfig) {}

  async run(
    request: InternalInferenceRequest,
    signal?: AbortSignal,
    lifecycle?: InternalInferenceRuntimeLifecycle,
  ): Promise<InternalInferenceResult> {
    const inherited = this.config.controllerConfig(request);
    const controller = new AgentController({
      ...inherited,
      adapterId: request.adapterId,
      cwd: request.cwd ?? inherited.cwd,
      mode: "normal",
      mcpServers: [],
      defaultPermission: "cancel",
      clientHandlers: {},
    });
    const abort = () => controller.interrupt();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw abortError();
      const connection = await controller.startFresh();
      await lifecycle?.sessionStarted({ internalSessionId: connection.sessionId, model: null });
      if (signal?.aborted) throw abortError();
      const result = await controller.prompt(request.prompt);
      if (result.status !== "completed") {
        throw new Error(`internal inference prompt ${result.status}: ${result.stopReason}`);
      }
      return Object.freeze({
        internalInferenceId: request.internalInferenceId,
        internalSessionId: connection.sessionId,
        adapterId: request.adapterId,
        model: null,
        messages: result.messages,
        usage: result.usage,
        stopReason: result.stopReason,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      await controller.stop();
    }
  }
}

function abortError(): Error {
  const error = new Error("internal inference aborted");
  error.name = "AbortError";
  return error;
}
