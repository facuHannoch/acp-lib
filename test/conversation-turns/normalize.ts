/**
 * Makes a captured characterization run stable enough to snapshot.
 *
 * - UUIDs, minted operation ids, provider session ids and other identifiers become `<id:N>`,
 *   numbered by first appearance in a depth-first walk with sorted keys. Equal ids get the same
 *   placeholder everywhere, including inside composite strings (`<id:1>:user`,
 *   `message:<id:1>:user`), so relations between them stay visible.
 * - 64-hex digests become `<hash:N>` the same way (they hash timestamps and paths).
 * - Timestamps (ISO strings, epoch milliseconds, `ts`/`*At` fields) become `<ts>`.
 * - Durations, process ids and sequence-free timing fields are dropped.
 * - Temporary directories become `<tmp>`; process ids inside strings become `<pid>`.
 *
 * Normalization never reorders arrays: the order of events and records is part of what is pinned.
 */

/** Keys whose string values are identifiers, whatever their format. */
const ID_KEYS = new Set([
  "id",
  "ids",
  "turnId",
  "operationId",
  "handoffId",
  "transitionId",
  "recordId",
  "messageId",
  "internalSessionId",
  "fromInternalSessionId",
  "toInternalSessionId",
  "sessionId",
  "agentSessionId",
  "agentConversationId",
  "conversationId",
  "providerSessionId",
  "transcriptId",
  "incarnationId",
  "creationId",
  "followedBy",
  "heldBy",
  "failedTurnId",
  "lastSettledOperationId",
  "checkpointId",
  "requestId",
  "permissionId",
  "toolCallId",
  "eventId",
  "notificationId",
]);

/** Keys holding durations, process ids or wall-clock measurements: dropped. */
const DROP_KEYS = new Set(["durationMs", "elapsedMs", "latencyMs", "pid", "processId"]);

/** Keys holding timestamps, whatever their representation. */
const TIME_KEY = /(^ts$|At$|^at$|^time$|Time$|^timestamp$|^updated$|^created$)/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HASH = /\b[0-9a-f]{64}\b/g;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const PID_TEXT = /\bpid=\d+/g;
/** Epoch milliseconds between 2001 and 2286. */
const isEpochMs = (value: number) => Number.isInteger(value) && value > 1e12 && value < 1e13;

export interface NormalizeOptions {
  /** Absolute paths to replace with `<tmp>` (longest first). */
  readonly paths?: readonly string[];
  /** Extra literal strings known to be identifiers (for example a fixture's provider session id). */
  readonly ids?: readonly string[];
}

/**
 * Minted operation ids are `Date.now().toString(36)` plus up to four random base-36 characters.
 * Ids minted during the test share the timestamp's leading characters, which no ordinary word does.
 */
function mintedIdPattern(): RegExp {
  // Three leading characters change every ~17 hours; accept the previous hour's prefix too so a run
  // that straddles a change still matches.
  const now = Date.now();
  const prefixes = new Set([now, now - 3_600_000].map((at) => at.toString(36).slice(0, 3)));
  return new RegExp(`\\b(?:${[...prefixes].join("|")})[0-9a-z]{5,9}\\b`, "g");
}

export function normalize(value: unknown, options: NormalizeOptions = {}): unknown {
  const ids = new Map<string, string>();
  const hashes = new Map<string, string>();
  const minted = mintedIdPattern();
  const paths = [...(options.paths ?? [])].sort((a, b) => b.length - a.length);

  const idFor = (raw: string): string => {
    let placeholder = ids.get(raw);
    if (!placeholder) {
      placeholder = `<id:${ids.size + 1}>`;
      ids.set(raw, placeholder);
    }
    return placeholder;
  };
  const hashFor = (raw: string): string => {
    let placeholder = hashes.get(raw);
    if (!placeholder) {
      placeholder = `<hash:${hashes.size + 1}>`;
      hashes.set(raw, placeholder);
    }
    return placeholder;
  };

  for (const id of options.ids ?? []) if (id) idFor(id);

  // First pass: register identifiers found under id keys, in walk order, so that numbering follows
  // first appearance and composite strings seen later reuse the same placeholder.
  const register = (node: unknown, key: string | null): void => {
    if (typeof node === "string") {
      if (key !== null && ID_KEYS.has(key) && node.length > 0) {
        // Composite ids (`<turn>:user:2`) register their leading part, which is the minted id.
        const head = node.split(":")[0]!;
        if (head.length >= 6 && !/^(message|presentation)$/.test(head)) idFor(head);
        if (!node.includes(":")) idFor(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) register(item, key);
      return;
    }
    if (node && typeof node === "object") {
      for (const name of Object.keys(node).sort()) register((node as Record<string, unknown>)[name], name);
    }
  };
  register(value, null);

  const text = (raw: string): string => {
    let out = raw;
    for (const path of paths) out = out.split(path).join("<tmp>");
    out = out.replace(ISO, "<ts>");
    out = out.replace(HASH, (match) => hashFor(match));
    // Known ids first, longest first so that one id that prefixes another is not split.
    const known = [...ids.keys()].sort((a, b) => b.length - a.length);
    for (const id of known) if (out.includes(id)) out = out.split(id).join(ids.get(id)!);
    out = out.replace(UUID, (match) => idFor(match.toLowerCase()));
    out = out.replace(PID_TEXT, "pid=<pid>");
    out = out.replace(minted, (match) => idFor(match));
    return out;
  };

  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === "string") {
      if (key !== null && TIME_KEY.test(key)) return "<ts>";
      return text(node);
    }
    if (typeof node === "number") {
      if (key !== null && TIME_KEY.test(key)) return "<ts>";
      if (isEpochMs(node)) return "<ts>";
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node instanceof Error) {
      return walk({ name: node.name, message: node.message, ...plain(node) }, key);
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const name of Object.keys(node).sort()) {
        if (DROP_KEYS.has(name)) continue;
        const child = (node as Record<string, unknown>)[name];
        if (child === undefined || typeof child === "function") continue;
        out[name] = walk(child, name);
      }
      return out;
    }
    return node;
  };

  return walk(value, null);
}

/** Own enumerable fields of an error (code, phase, cause...), without the stack. */
function plain(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(error)) {
    if (name === "stack") continue;
    out[name] = value;
  }
  if (error.cause !== undefined && !("cause" in out)) out.cause = error.cause;
  return out;
}
