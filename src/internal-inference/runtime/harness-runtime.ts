import { OperationSupervisor } from "../../operations/supervisor.ts";
import type { OutputListener } from "../../operations/contracts.ts";
import { HarnessController, type AgentControllerConfig } from "../../controller.ts";
import type { PromptResult } from "../../types.ts";
import type {
  InternalInferenceRequest,
  InternalInferenceResult,
  InternalInferenceRuntime,
  InternalInferenceRuntimeLifecycle,
} from "../contracts.ts";

export interface HarnessInternalInferenceRuntimeConfig {
  controllerConfig(request: InternalInferenceRequest): AgentControllerConfig;
  /** Test/custom seam; production defaults to HarnessController. */
  createController?(config: AgentControllerConfig): InternalInferenceController;
}

export interface InternalInferenceController {
  startFresh(): Promise<{ sessionId: string }>;
  prompt(text: string): Promise<PromptResult>;
  subscribeOutput?(listener: OutputListener): () => void;
  cancel?(): void;
  forceStop?(): Promise<void>;
  interrupt(): void;
  stop(): Promise<void>;
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
    const controllerConfig: AgentControllerConfig = {
      ...inherited,
      adapterId: request.adapterId,
      cwd: request.cwd ?? inherited.cwd,
      mode: "normal",
      mcpServers: [],
      permissions: { default: "ask" },
      clientHandlers: {},
    };
    const controller = this.config.createController?.(controllerConfig)
      ?? new HarnessController(controllerConfig);
    let supervisor: OperationSupervisor | undefined;
    const abort = () => supervisor ? supervisor.cancel("abort") : controller.interrupt();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw abortError();
      lifecycle?.stageChanged?.("creating_session");
      const connection = await controller.startFresh();
      await lifecycle?.sessionStarted({ internalSessionId: connection.sessionId, model: null });
      if (signal?.aborted) throw abortError();
      lifecycle?.stageChanged?.("prompting");
      supervisor = new OperationSupervisor({
        prompt: () => controller.prompt(request.prompt),
        subscribeOutput: (listener) => controller.subscribeOutput?.(listener) ?? (() => {}),
        cancel: () => controller.cancel ? controller.cancel() : controller.interrupt(),
        forceStop: () => controller.forceStop ? controller.forceStop() : controller.stop(),
      }, { operationId: request.internalInferenceId, kind: "internal_inference", sessionId: connection.sessionId,
        cancelGraceMs: controllerConfig.adapter.cancelGraceMs,
        limits: controllerConfig.operationLifecycle?.internalInference,
        onStageChanged: () => lifecycle?.operationChanged?.(() => supervisor!.activity),
      });
      const result = await supervisor.run();
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
      lifecycle?.operationChanged?.(null);
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
