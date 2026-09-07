// The loopback channel the OpenCode metering plugin reports to.
//
// Deliberately narrow: it accepts telemetry and nothing else. It does not proxy model
// traffic, hold credentials, or see prompt or response content — the plugin sends token
// counts and cost, never message text.
//
// Binds to 127.0.0.1 on an ephemeral port and requires a per-session token, because
// anything on the loopback interface can otherwise post fabricated usage into a billing
// ledger.

import type { TokenUsage } from "../../types.ts";

/** One model inference, as OpenCode itself accounted for it. */
export interface ProviderInference {
  readonly messageID: string;
  readonly sessionID: string;
  readonly providerID: string;
  readonly modelID: string;
  /** True for compaction summaries: an inference no user prompt asked for. */
  readonly summary: boolean;
  readonly completedAt: number;
  /** OpenCode's own cost figure for this inference. */
  readonly cost: number;
  readonly tokens: TokenUsage;
}

export interface ChannelHandshake {
  readonly pid: number;
  readonly directory: string | null;
  readonly at: number;
}

interface RawInference {
  messageID?: unknown;
  sessionID?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  summary?: unknown;
  completedAt?: unknown;
  cost?: unknown;
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Normalize OpenCode's token shape into the library's.
 *
 * The categories are disjoint — measured across five providers, `input + output +
 * reasoning + cache.read + cache.write` equals the reported total exactly — so
 * `totalTokens` is their sum rather than a separately reported figure.
 */
function normalizeInference(raw: RawInference): ProviderInference | null {
  const messageID = typeof raw.messageID === "string" ? raw.messageID : null;
  const sessionID = typeof raw.sessionID === "string" ? raw.sessionID : null;
  const providerID = typeof raw.providerID === "string" ? raw.providerID : null;
  const modelID = typeof raw.modelID === "string" ? raw.modelID : null;
  const completedAt = counter(raw.completedAt);
  if (!messageID || !sessionID || !providerID || !modelID || completedAt === null) return null;

  const input = counter(raw.tokens?.input);
  const output = counter(raw.tokens?.output);
  if (input === null || output === null) return null;
  const reasoning = counter(raw.tokens?.reasoning);
  const cacheRead = counter(raw.tokens?.cache?.read);
  const cacheWrite = counter(raw.tokens?.cache?.write);

  const tokens: TokenUsage = {
    totalTokens: input + output + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead !== null ? { cachedReadTokens: cacheRead } : {}),
    ...(cacheWrite !== null ? { cachedWriteTokens: cacheWrite } : {}),
    ...(reasoning !== null ? { thoughtTokens: reasoning } : {}),
  };

  return Object.freeze({
    messageID,
    sessionID,
    providerID,
    modelID,
    summary: raw.summary === true,
    completedAt,
    cost: typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : 0,
    tokens: Object.freeze(tokens),
  });
}

export interface MeteringChannelOptions {
  /** Emitted on malformed or unauthorized posts; never thrown at the harness. */
  readonly onWarning?: (message: string) => void;
}

/**
 * A loopback endpoint collecting per-inference records from the harness.
 *
 * Attribution is drain-based: `AgentSession` serializes operations, so everything drained
 * at the end of one operation belongs to it. That is simpler and more robust than
 * timestamp windows, which would misattribute an inference that completed while the next
 * operation was already opening.
 */
export class OpencodeMeteringChannel {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly pending = new Map<string, ProviderInference>();
  private _handshake: ChannelHandshake | null = null;
  private _rejected = 0;

  readonly token: string = crypto.randomUUID();

  constructor(private readonly options: MeteringChannelOptions = {}) {}

  /** True once the plugin has announced itself: "loaded" versus "silent" are different. */
  get handshake(): ChannelHandshake | null {
    return this._handshake;
  }
  /** Posts refused for a bad token or malformed body. Non-zero means something is wrong. */
  get rejectedCount(): number {
    return this._rejected;
  }
  get url(): string {
    if (!this.server) throw new Error("metering channel is not started");
    return `http://127.0.0.1:${this.server.port}/inference`;
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (request.headers.get("x-acp-meter-token") !== this.token) {
          this._rejected += 1;
          this.options.onWarning?.("rejected a post with a bad token");
          return new Response("forbidden", { status: 403 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          this._rejected += 1;
          return new Response("bad json", { status: 400 });
        }
        const payload = body as { type?: unknown } & RawInference & Partial<ChannelHandshake>;

        if (payload.type === "hello") {
          this._handshake = Object.freeze({
            pid: typeof payload.pid === "number" ? payload.pid : -1,
            directory: typeof payload.directory === "string" ? payload.directory : null,
            at: typeof payload.at === "number" ? payload.at : Date.now(),
          });
          return new Response("ok");
        }

        if (payload.type === "inference") {
          const inference = normalizeInference(payload);
          if (!inference) {
            this._rejected += 1;
            this.options.onWarning?.("rejected a malformed inference record");
            return new Response("bad record", { status: 400 });
          }
          // Keyed by messageID: a message can be reported more than once, and the same
          // inference counted twice would inflate a bill.
          this.pending.set(inference.messageID, inference);
          return new Response("ok");
        }

        this._rejected += 1;
        return new Response("unknown type", { status: 400 });
      },
    });
  }

  /** Take everything collected since the last drain. */
  drain(): readonly ProviderInference[] {
    const drained = Object.freeze([...this.pending.values()]);
    this.pending.clear();
    return drained;
  }

  /** Records collected but not yet drained. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }
}
