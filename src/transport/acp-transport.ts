/// <reference types="bun" />
// The ONLY module that touches the SDK or spawns a process. Wraps
// @agentclientprotocol/sdk: spawn → ndjson stream → ClientSideConnection. Everything
// above this layer is protocol-plumbing-agnostic. See SPEC.md "Architecture".

import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { ProcessCrashError } from "../errors.ts";
import type { WireEntry } from "../types.ts";

/** The five `terminal/*` methods a client that advertises `terminal: true` must serve. */
export interface TerminalHandlers {
  create(params: schema.CreateTerminalRequest): Promise<schema.CreateTerminalResponse>;
  output(params: schema.TerminalOutputRequest): Promise<schema.TerminalOutputResponse>;
  waitForExit(
    params: schema.WaitForTerminalExitRequest,
  ): Promise<schema.WaitForTerminalExitResponse>;
  kill(params: schema.KillTerminalRequest): Promise<void>;
  release(params: schema.ReleaseTerminalRequest): Promise<void>;
}

export interface AcpTransportOptions {
  /** Full command to spawn: [...execPrefix, ...adapter.command]. */
  command: string[];
  /** cwd for the spawned process. Omit for `docker exec` (host path won't resolve in-container). */
  cwd?: string;
  env?: Record<string, string>;

  /**
   * A session/update notification arrived, exactly as the agent sent it — the transport
   * takes these off the wire itself rather than going through the SDK. See
   * `interceptUpdates` for why.
   */
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
  /**
   * `terminal/*`. Supplied together or not at all — the SDK answers an unimplemented
   * terminal method with a null result rather than an error, which reads to the agent
   * as a malformed response, so a partial implementation is worse than none.
   */
  terminals?: TerminalHandlers;
  /** A line of stderr from the process. */
  onStderr?: (line: string) => void;
  /**
   * Every raw line in either direction, for debugging. This is the ONLY view of the
   * traffic that is complete: `onUpdate` sees notifications after mapping, the logger sees
   * our interpretation, and the SDK sees neither the lines we intercept nor what it wrote.
   */
  onWire?: (entry: WireEntry) => void;
  /** The process exited unexpectedly (not via stop()). */
  onCrash?: (code: number | null) => void;
}

export class AcpTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private stopping = false;
  private tap?: (dir: WireEntry["dir"], line: string) => void;

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

    const wire = this.opts.onWire;
    const tap = wire ? (dir: WireEntry["dir"], line: string) => wire({ dir, ts: Date.now(), line }) : undefined;

    const stream = acp.ndJsonStream(
      // Outgoing bytes are forwarded untouched; the tap only reads them on the way past.
      tap ? tapOutgoing(stdinTransform.writable, (line) => tap("out", line)) : stdinTransform.writable,
      interceptUpdates(
        proc.stdout as ReadableStream<Uint8Array>,
        (m) => this.opts.onUpdate?.(m.params as schema.SessionNotification),
        tap && ((line) => tap("in", line)),
      ),
    );
    this.tap = tap;
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
        if (line) this.emitStderr(line);
      }
    }
    const tail = buf.trim();
    if (tail) this.emitStderr(tail);
  }

  private emitStderr(line: string): void {
    this.tap?.("err", line);
    this.opts.onStderr?.(line);
  }
}

/**
 * Wrap a writable so every line written through it is reported, then forwarded BYTE FOR
 * BYTE. The SDK owns serialization; this only looks.
 */
function tapOutgoing(
  target: WritableStream<Uint8Array>,
  onLine: (line: string) => void,
): WritableStream<Uint8Array> {
  const writer = target.getWriter();
  const dec = new TextDecoder();
  let buf = "";
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
      await writer.write(chunk);
    },
    async close() {
      await writer.close();
    },
    async abort(reason) {
      await writer.abort(reason);
    },
  });
}

/**
 * Split the agent's ndjson into `session/update` (ours) and everything else (the SDK's).
 *
 * Updates are handed to `onMessage` verbatim and NOT forwarded downstream: the SDK
 * validates them against a zod copy of the update union, so anything newer than the
 * installed SDK is rejected outright with a console.error, and unmodelled fields on
 * known updates are stripped. Notifications carry no response, so intercepting them is
 * invisible to the agent — every request/response line still flows through untouched.
 */
function interceptUpdates(
  source: ReadableStream<Uint8Array>,
  onMessage: (message: Record<string, any>) => void,
  onLine?: (line: string) => void,
): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";

  // Re-emits the ORIGINAL line text — reserializing risks mangling numbers we never read.
  const handle = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!line) return;
    // Before the split, so the debug view includes what we take off the wire ourselves.
    onLine?.(line);
    let message: Record<string, any> | undefined;
    try {
      message = JSON.parse(line);
    } catch {
      /* not JSON — let the SDK report it */
    }
    if (message?.method === "session/update" && message.id === undefined) {
      onMessage(message);
      return;
    }
    controller.enqueue(enc.encode(`${line}\n`));
  };

  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          handle(line, controller);
        }
      },
      flush(controller) {
        buf += dec.decode();
        handle(buf.trim(), controller);
        buf = "";
      },
    }),
  );
}

/**
 * Routes SDK client-side callbacks to the transport's option handlers.
 *
 * Methods are attached in the CONSTRUCTOR rather than declared, because the SDK probes
 * `client.method?.()` — a declared-but-stubbed method makes us look capable while
 * answering with nonsense. Absent is the honest signal for "not implemented".
 */
class ClientHandler implements acp.Client {
  createTerminal?: acp.Client["createTerminal"];
  terminalOutput?: acp.Client["terminalOutput"];
  waitForTerminalExit?: acp.Client["waitForTerminalExit"];
  killTerminal?: acp.Client["killTerminal"];
  releaseTerminal?: acp.Client["releaseTerminal"];
  readTextFile?: acp.Client["readTextFile"];
  writeTextFile?: acp.Client["writeTextFile"];

  constructor(private opts: AcpTransportOptions) {
    if (opts.onReadTextFile) this.readTextFile = (p) => opts.onReadTextFile!(p);
    if (opts.onWriteTextFile) this.writeTextFile = (p) => opts.onWriteTextFile!(p);

    const terminals = opts.terminals;
    if (terminals) {
      this.createTerminal = (p) => terminals.create(p);
      this.terminalOutput = (p) => terminals.output(p);
      this.waitForTerminalExit = (p) => terminals.waitForExit(p);
      this.killTerminal = (p) => terminals.kill(p);
      this.releaseTerminal = (p) => terminals.release(p);
    }
  }

  /** Safety net: `interceptUpdates` normally takes these before the SDK sees them. */
  async sessionUpdate(params: schema.SessionNotification): Promise<void> {
    this.opts.onUpdate?.(params);
  }

  async requestPermission(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    if (this.opts.onPermissionRequest) return this.opts.onPermissionRequest(params);
    return { outcome: { outcome: "cancelled" } };
  }
}
