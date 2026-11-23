import { AcpClient, type ConnectResult } from "./client.ts";
import type { AgentClient } from "./agent-client.ts";
import type { ConnectionAttempt } from "./connection-attempt.ts";
import type { AgentControllerConfig, AgentMode, ControllerStartEvent } from "./controller.ts";
import { ConnectionCancelledError, ProcessCrashError } from "./errors.ts";

export interface ReadyConnection {
  client: AgentClient;
  acp: AcpClient | null;
  result: ConnectResult;
}

/**
 * Bring up a fresh leaf for the configured adapter in `mode`. normal → AcpClient
 * (connect + new/load session); degraded → PtyClient (spawn interactive CLI). PtyClient
 * is dynamically imported so the normal-mode path never loads the degraded subpath.
 */
export async function bringUp(
  config: AgentControllerConfig,
  attempt: ConnectionAttempt<ControllerStartEvent>,
  mode: AgentMode,
  sessionId?: string,
  loadFailure = config.sessionLoadFailure,
): Promise<ReadyConnection> {
  const adapter = config.adapter;
  if (mode === "degraded") {
    const { PtyClient } = await import("./degraded/index.ts");
    attempt.signal.throwIfAborted();
    const client = new PtyClient({
      adapter,
      launcher: config.launcher,
      execPrefix: config.execPrefix,
      env: config.env,
      cwd: config.cwd,
      logger: config.logger,
    });
    try {
      await client.start();
      attempt.signal.throwIfAborted();
    } catch (err) {
      await client.stop();
      throw err;
    }
    return { client, acp: null, result: { sessionId: "", resumed: false } };
  }

  const client = new AcpClient({
    adapter,
    launcher: config.launcher,
    execPrefix: config.execPrefix,
    env: config.env,
    cwd: config.cwd,
    additionalDirectories: config.additionalDirectories,
    sessionId,
    sessionLoadFailure: loadFailure,
    permissions: config.permissions, permissionRule: config.permissionRule,
    clientInfo: config.clientInfo,
    clientCapabilities: config.clientCapabilities,
    clientHandlers: config.clientHandlers,
    logger: config.logger,
    wire: config.wire,
  });
  // connect() is fatal (no connection = nothing to do). startSession() is NOT: an
  // unauthenticated agent may refuse session/new, but we keep the connection up so the
  // user can /login and then create a session. (Auth state is opaque — see SPEC.)
  try {
    attempt.own(() => client.stop());
    const capabilities = await client.connect();
    attempt.signal.throwIfAborted();
    attempt.report({ stage: "initialized", capabilities });
  } catch (err) {
    await client.stop();
    attempt.signal.throwIfAborted();
    throw err;
  }
  let result: ConnectResult;
  try {
    result = await client.startSession({
      mcpServers: config.mcpServers,
      additionalDirectories: config.additionalDirectories,
      loadFailure: loadFailure,
      ...(config.onSessionReplay ? { onReplayUpdate: config.onSessionReplay } : {}),
    });
  } catch (err) {
    attempt.signal.throwIfAborted();
    if (err instanceof ConnectionCancelledError || err instanceof ProcessCrashError ||
      config.requireStartupSession || (sessionId && loadFailure === "error")) {
      await client.stop();
      throw err;
    }
    config.logger?.warn("session_start_failed", { error: String(err) });
    result = { sessionId: "", resumed: false };
  }
  attempt.signal.throwIfAborted();
  if (result.sessionId) {
    attempt.report({
      stage: "internal_session_acquired",
      internalSessionId: result.sessionId,
      disposition: result.resumed ? "resumed" : "created",
    });
  }
  return { client, acp: client, result };
}

export function observeStartProgress(
  config: AgentControllerConfig,
  listener: ((event: ControllerStartEvent) => void) | undefined,
): ((event: ControllerStartEvent) => void) | undefined {
  if (!listener) return;
  return event => {
    try { listener(event); }
    catch (error) { config.logger?.warn("controller_start_progress_listener_failed", { error: String(error) }); }
  };
}
