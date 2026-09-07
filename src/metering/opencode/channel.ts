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
  /** Per-session counter assigned by the plugin, used to detect dropped reports. */
  readonly sequence: number | null;
  readonly messageID: string;
  readonly sessionID: string;
  readonly providerID: string;
  readonly modelID: string;
  /** True for compaction summaries: an inference no user prompt asked for. */
  readonly summary: boolean;
  readonly completedAt: number;
  /** OpenCode's own cost figure, or null when it reported none. Never a fabricated zero. */
  readonly cost: number | null;
  readonly tokens: TokenUsage;
}

export interface ChannelHandshake {
  readonly pid: number;
  readonly directory: string | null;
  readonly at: number;
}

interface RawInference {
  sequence?: unknown;
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

  // A malformed cost is NOT zero. Coercing it would put a fabricated zero into a billing
  // ledger, which is the exact failure this design refuses everywhere else.
  if (raw.cost !== undefined && raw.cost !== null) {
    if (typeof raw.cost !== "number" || !Number.isFinite(raw.cost) || raw.cost < 0) return null;
  }

  return Object.freeze({
    sequence: counter(raw.sequence),
    messageID,
    sessionID,
    providerID,
    modelID,
    summary: raw.summary === true,
    completedAt,
    // Absent cost is genuinely unknown; the record still carries its tokens.
    cost: typeof raw.cost === "number" ? raw.cost : null,
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
  /** Highest sequence seen per session, and how many were skipped. */
  private readonly highestSequence = new Map<string, number>();
  private _lostReports = 0;

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
  /**
   * Reports the plugin sent that never arrived, detected by gaps in its sequence.
   *
   * Non-zero means measurement is incomplete, and any operation covering that span must
   * not claim complete attribution.
   *
   * LIMITATION: gaps are only visible once a LATER report arrives. A lost final report —
   * including the last of a session — is undetectable this way, so an operation can claim
   * complete attribution despite having lost its final inference. Sequence numbers detect
   * observed discontinuities; they do not prove delivery. Closing that gap needs a
   * plugin-to-parent finalization fence, which this version does not have.
   */
  get lostReportCount(): number {
    return this._lostReports;
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
          const firstSighting = !this.pending.has(inference.messageID);
          this.pending.set(inference.messageID, inference);
          if (firstSighting && inference.sequence !== null) {
            // A gap means a POST was lost. Silence and loss look identical without this,
            // and an operation would still claim complete attribution.
            const previous = this.highestSequence.get(inference.sessionID) ?? 0;
            if (inference.sequence > previous + 1) {
              this._lostReports += inference.sequence - previous - 1;
              this.options.onWarning?.(
                `metering channel lost ${inference.sequence - previous - 1} report(s)`,
              );
            }
            if (inference.sequence > previous) {
              this.highestSequence.set(inference.sessionID, inference.sequence);
            }
          }
          return new Response("ok");
        }

        this._rejected += 1;
        return new Response("unknown type", { status: 400 });
      },
    });
  }

  /**
   * Take the records collected for one provider thread since the last drain.
   *
   * Scoped deliberately. An unscoped drain charges the next operation for anything the
   * harness did elsewhere — background work, or a late inference from a thread a handoff
   * already replaced. Records for other threads stay pending and surface through
   * `drainAll()` as unallocated rather than being attributed to work that did not cause
   * them.
   */
  drain(sessionId?: string | null): readonly ProviderInference[] {
    const drained: ProviderInference[] = [];
    for (const [messageId, inference] of this.pending) {
      if (sessionId && inference.sessionID !== sessionId) continue;
      drained.push(inference);
      this.pending.delete(messageId);
    }
    return Object.freeze(drained);
  }

  /** Take records belonging to any thread OTHER than the one named. */
  drainForeign(sessionId: string | null): readonly ProviderInference[] {
    if (!sessionId) return Object.freeze([]);
    const drained: ProviderInference[] = [];
    for (const [messageId, inference] of this.pending) {
      if (inference.sessionID === sessionId) continue;
      drained.push(inference);
      this.pending.delete(messageId);
    }
    return Object.freeze(drained);
  }

  /** Take everything still pending, whatever thread it belongs to. */
  drainAll(): readonly ProviderInference[] {
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
