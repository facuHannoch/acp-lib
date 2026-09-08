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

/**
 * Compare a shared secret without leaking length or prefix through timing.
 *
 * The channel is loopback-only with a random token, so this is defence in depth rather
 * than a live threat — but it is an auth check, and auth checks compare in constant time.
 */
function timingSafeEquals(candidate: string | null, expected: string): boolean {
  if (candidate === null || candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
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
  /**
   * Maximum undrained records held. Default 10,000.
   *
   * Reached only when operations stop closing — a stalled session drains nothing. Overflow
   * counts toward lost reports so it cannot pass unnoticed.
   */
  readonly maxPendingRecords?: number;
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
  /**
   * Bounded on purpose. An unbounded buffer is a promise that cannot be kept, and silently
   * dropping on overflow would be the same under-reporting bug in another organ. Overflow
   * is counted as permanently lost, so exceeding capacity degrades attribution to
   * partial rather than losing records quietly.
   */
  private readonly pending = new Map<string, ProviderInference>();
  private readonly capacity: number;
  private _handshake: ChannelHandshake | null = null;
  private _rejected = 0;
  /** Highest sequence seen per session, and how many were skipped. */
  /**
   * Per-session sequence ledger.
   *
   * A high-water mark could say "seen up to N" but never "missing 3 and 7", so it could not
   * RETRACT a loss claim: out-of-order arrival on loopback recorded a permanent phantom
   * gap, which under billing_required blocked a working session. An outstanding set is
   * discharged when the late report lands.
   */
  private readonly sequences = new Map<string, { highest: number; outstanding: Set<number> }>();
  /**
   * Message ids accepted at any point, not just those still pending.
   *
   * `pending` alone is not a dedupe scope: once an operation drains it, a repeat report for
   * the same completed message would be taken as fresh work and charged to the NEXT
   * operation. The plugin suppresses repeats too; this is the defensive half, because a
   * double-charge must not depend on a component running inside the harness.
   */
  private readonly seenMessageIds = new Set<string>();
  /** Refused for capacity — permanently lost, unlike a gap that may still be filled. */
  private _permanentlyLost = 0;
  private _duplicatesRefused = 0;

  readonly token: string = crypto.randomUUID();

  constructor(private readonly options: MeteringChannelOptions = {}) {
    this.capacity = options.maxPendingRecords ?? 10_000;
  }

  /** True once the plugin has announced itself: "loaded" versus "silent" are different. */
  get handshake(): ChannelHandshake | null {
    return this._handshake;
  }
  /**
   * Repeat reports for a message already drained.
   *
   * Non-zero usually means the plugin is loaded twice — harmless now that it is refused,
   * but worth surfacing because it also indicates the harness config has two entries.
   */
  get duplicatesRefusedCount(): number {
    return this._duplicatesRefused;
  }
  /** Posts refused for a bad token or malformed body. Non-zero means something is wrong. */
  get rejectedCount(): number {
    return this._rejected;
  }
  /**
   * Sequence numbers seen skipped and not yet filled, for one session or all of them.
   *
   * RETRACTABLE: a report arriving out of order discharges its own number, so this count
   * FALLS. Treating a gap as permanent is what let a benign reorder block billing.
   *
   * LIMITATION: a gap is only visible once a LATER report arrives, so a lost FINAL report
   * is undetectable. Sequence numbers detect observed discontinuities; they do not prove
   * delivery. Closing that needs a plugin-to-parent finalization fence, which this version
   * does not have.
   */
  outstandingReports(sessionId?: string | null): number {
    if (sessionId) return this.sequences.get(sessionId)?.outstanding.size ?? 0;
    let total = 0;
    for (const ledger of this.sequences.values()) total += ledger.outstanding.size;
    return total;
  }

  /**
   * Records this channel refused and can therefore never receive.
   *
   * Distinct from an outstanding gap: this usage is unaccounted ANYWHERE, which is the one
   * condition that should stop a billing session.
   */
  get permanentlyLostCount(): number {
    return this._permanentlyLost;
  }

  /** Highest sequence recorded for a session, used to recognise a late arrival. */
  sequenceHighWater(sessionId: string | null): number {
    return sessionId ? (this.sequences.get(sessionId)?.highest ?? 0) : 0;
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
        if (!timingSafeEquals(request.headers.get("x-acp-meter-token"), this.token)) {
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
          // Sequence bookkeeping runs BEFORE any refusal below. A duplicate consumes its
          // number whatever we do with the payload, and skipping it left the ledger behind
          // so the next legitimate record looked like a gap.
          if (inference.sequence !== null) this.recordSequence(inference);

          // Keyed by messageID across the channel's whole life, not just what is pending:
          // the same inference counted twice would inflate a bill.
          const everSeen = this.seenMessageIds.has(inference.messageID);
          if (everSeen && !this.pending.has(inference.messageID)) {
            // Already drained into a completed operation. Accepting it again would charge
            // the work twice.
            this._duplicatesRefused += 1;
            return new Response("duplicate", { status: 409 });
          }
          if (!everSeen && this.pending.size >= this.capacity) {
            // Full. Refuse rather than evict: dropping the oldest would silently lose a
            // record already counted as delivered. This one is PERMANENTLY lost — unlike a
            // sequence gap it will never arrive, because we rejected it.
            this._permanentlyLost += 1;
            this.options.onWarning?.(
              `metering channel is full at ${this.capacity} undrained records; ` +
                `refusing further records until an operation closes`,
            );
            return new Response("full", { status: 503 });
          }
          this.pending.set(inference.messageID, inference);
          this.seenMessageIds.add(inference.messageID);
          return new Response("ok");
        }

        this._rejected += 1;
        return new Response("unknown type", { status: 400 });
      },
    });
  }

  /**
   * Fold a sequence number into its session's ledger.
   *
   * Advancing opens gaps for anything skipped; EVERY arrival — in order, late, or a
   * duplicate — discharges its own number, so a reorder resolves itself rather than
   * standing as a permanent loss.
   */
  private recordSequence(inference: ProviderInference): void {
    const sequence = inference.sequence!;
    let ledger = this.sequences.get(inference.sessionID);
    if (!ledger) {
      ledger = { highest: 0, outstanding: new Set<number>() };
      this.sequences.set(inference.sessionID, ledger);
    }
    if (sequence > ledger.highest) {
      for (let missing = ledger.highest + 1; missing < sequence; missing += 1) {
        ledger.outstanding.add(missing);
      }
      ledger.highest = sequence;
    }
    ledger.outstanding.delete(sequence);
    if (ledger.outstanding.size > 0) {
      this.options.onWarning?.(
        `metering channel is missing ${ledger.outstanding.size} report(s) for session ` +
          `${inference.sessionID}; they may still arrive`,
      );
    }
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
