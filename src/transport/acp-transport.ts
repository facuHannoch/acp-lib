/// <reference types="bun" />
// The ONLY module that touches the SDK or spawns a process. Wraps
// @agentclientprotocol/sdk: spawn → ndjson stream → ClientSideConnection. Everything
// above this layer is protocol-plumbing-agnostic. See SPEC.md "Architecture".

import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { ProcessCrashError } from "../errors.ts";

export interface AcpTransportOptions {
  /** Full command to spawn: [...execPrefix, ...adapter.command]. */
  command: string[];
  /** cwd for the spawned process. Omit for `docker exec` (host path won't resolve in-container). */
  cwd?: string;
  env?: Record<string, string>;

  /** A session/update notification arrived. */
  onUpdate?: (notification: schema.SessionNotification) => void;
  /** The agent asked for permission (blocking — must resolve to an outcome). */
  onPermissionRequest?: (
    params: schema.RequestPermissionRequest,
  ) => Promise<schema.RequestPermissionResponse>;
  /** The agent wants to read a file from the client. */
  onReadTextFile?: (
    params: schema.ReadTextFileRequest,
  ) => Promise<schema.ReadTextFileResponse>;
  /** The agent wants to write a file via the client. */
  onWriteTextFile?: (
    params: schema.WriteTextFileRequest,
  ) => Promise<schema.WriteTextFileResponse>;
  /** A line of stderr from the process. */
  onStderr?: (line: string) => void;
  /** The process exited unexpectedly (not via stop()). */
  onCrash?: (code: number | null) => void;
}

export class AcpTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private stopping = false;

  constructor(private opts: AcpTransportOptions) {}

  async start(): Promise<void> {
    if (this.proc) return;

    // A TransformStream gives us a real WritableStream<Uint8Array> for the SDK —
    // Bun's FileSink (from stdin:"pipe") lacks getWriter().
    const stdinTransform = new TransformStream<Uint8Array, Uint8Array>();

    const proc = Bun.spawn(this.opts.command, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdin: stdinTransform.readable,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;

    const stream = acp.ndJsonStream(
      stdinTransform.writable,
      proc.stdout as ReadableStream<Uint8Array>,
    );
    const handler = new ClientHandler(this.opts);
    this.connection = new acp.ClientSideConnection(() => handler, stream);

    if (proc.stderr) this.pumpStderr(proc.stderr as ReadableStream<Uint8Array>);

    proc.exited
      .then((code) => {
        if (this.proc === proc && !this.stopping) {
          this.proc = null;
          this.connection = null;
          this.opts.onCrash?.(code ?? null);
        }
      })
      .catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.proc) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    this.proc = null;
    this.connection = null;
  }

  private conn(): acp.ClientSideConnection {
    if (!this.connection) throw new ProcessCrashError(null, "ACP transport not started");
    return this.connection;
  }

  // --- protocol methods (thin pass-through to the SDK) ----------------------------

  initialize(params: schema.InitializeRequest): Promise<schema.InitializeResponse> {
    return this.conn().initialize(params);
  }
  newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse> {
    return this.conn().newSession(params);
  }
  loadSession(params: schema.LoadSessionRequest): Promise<schema.LoadSessionResponse> {
    return this.conn().loadSession(params);
  }
  forkSession(params: schema.ForkSessionRequest): Promise<schema.ForkSessionResponse> {
    return this.conn().unstable_forkSession(params);
  }
  resumeSession(params: schema.ResumeSessionRequest): Promise<schema.ResumeSessionResponse> {
    return this.conn().resumeSession(params);
  }
  listSessions(params: schema.ListSessionsRequest): Promise<schema.ListSessionsResponse> {
    return this.conn().listSessions(params);
  }
  prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    return this.conn().prompt(params);
  }
  cancel(params: schema.CancelNotification): Promise<void> {
    return this.conn().cancel(params);
  }
  authenticate(params: schema.AuthenticateRequest): Promise<schema.AuthenticateResponse> {
    return this.conn().authenticate(params);
  }
  setSessionConfigOption(
    params: schema.SetSessionConfigOptionRequest,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    return this.conn().setSessionConfigOption(params);
  }

  /** Race a promise against process exit — catches dead/unauthenticated binaries early. */
  raceExit<T>(p: Promise<T>): Promise<T> {
    if (!this.proc) return p;
    const exit = this.proc.exited.then((code) => {
      throw new ProcessCrashError(
        code ?? null,
        `ACP server exited (code ${code ?? "?"}) before the operation completed — ` +
          `verify the provider binary is installed and authenticated`,
      );
    });
    return Promise.race([p, exit as Promise<never>]);
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.opts.onStderr?.(line);
      }
    }
    const tail = buf.trim();
    if (tail) this.opts.onStderr?.(tail);
  }
}

/** Routes SDK client-side callbacks to the transport's option handlers. */
class ClientHandler implements acp.Client {
  constructor(private opts: AcpTransportOptions) {}

  async sessionUpdate(params: schema.SessionNotification): Promise<void> {
    this.opts.onUpdate?.(params);
  }

  async requestPermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    if (this.opts.onPermissionRequest) return this.opts.onPermissionRequest(params);
    return { outcome: { outcome: "cancelled" } };
  }

  async readTextFile(
    params: schema.ReadTextFileRequest,
  ): Promise<schema.ReadTextFileResponse> {
    if (this.opts.onReadTextFile) return this.opts.onReadTextFile(params);
    return { content: "" };
  }

  async writeTextFile(
    params: schema.WriteTextFileRequest,
  ): Promise<schema.WriteTextFileResponse> {
    if (this.opts.onWriteTextFile) return this.opts.onWriteTextFile(params);
    return {};
  }
}
