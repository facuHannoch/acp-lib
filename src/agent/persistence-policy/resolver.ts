import { resolveConversationAuditConfig, type ResolvedAgentAuditLogConfig } from "../../audit/index.ts";
import type {
  ConversationRecordCaptureConfig,
  ConversationRecordCapturePolicy,
  MeteringRecordRetention,
} from "../../persistence/backend.ts";
import { resolveConversationRecordCapture } from "../../persistence/backend.ts";
import type { ManagerSettings } from "../manager-settings.ts";
import type {
  AgentConversationAuditCaptureConfig,
  AgentConversationPersistenceOverride,
  ConversationPersistenceContext,
  ConversationPersistenceResolver,
} from "./types.ts";

const KNOWN_KEYS = new Set(["capture", "auditLog", "meteringRecords"]);

/** Stable JSON: object keys sorted, so equal overrides share one cache entry. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested);
}

function validMeteringRetention(value: unknown): MeteringRecordRetention {
  if (value === "all" || value === "none") return value;
  const retain = (value as { retain?: unknown } | null)?.retain;
  if (typeof value === "object" && value !== null && Number.isInteger(retain) && (retain as number) >= 1) {
    return { retain: retain as number };
  }
  throw new Error('invalid meteringRecords retention: use "all", "none" or { retain: n } with n >= 1');
}

/**
 * Turns the Agent's settings and the consumer's resolver into the settings one conversation runs with.
 *
 * The resolver is called when a conversation starts (and for writes about a conversation that is not
 * live). A resolver that throws, or returns something invalid, is a caller mistake: the error is
 * thrown as it is, before any write. Identical overrides are validated and resolved once.
 */
export class ConversationSettingsResolver {
  readonly #capture = new Map<string, ConversationRecordCapturePolicy>();
  readonly #audit = new Map<string, ResolvedAgentAuditLogConfig>();

  constructor(
    private readonly base: ManagerSettings,
    private readonly resolver: ConversationPersistenceResolver | undefined,
  ) {}

  settingsFor(context: ConversationPersistenceContext): ManagerSettings {
    if (!this.resolver) return this.base;
    const override = this.resolver(context);
    if (override === undefined) return this.base;
    this.#validateShape(override);

    const capture = override.capture !== undefined && Object.keys(override.capture).length > 0
      ? this.#resolveCapture(override.capture)
      : undefined;
    const auditLog = override.auditLog === undefined ? undefined : this.#resolveAudit(override.auditLog);
    const meteringRecords = override.meteringRecords === undefined
      ? undefined
      : validMeteringRetention(override.meteringRecords);

    if (capture === undefined && auditLog === undefined && meteringRecords === undefined) return this.base;
    return {
      ...this.base,
      ...(capture ? { capture } : {}),
      ...(auditLog !== undefined ? { auditLog } : {}),
      ...(meteringRecords !== undefined ? { meteringRecords } : {}),
    };
  }

  #validateShape(override: AgentConversationPersistenceOverride): void {
    if (override === null || typeof override !== "object" || Array.isArray(override)) {
      throw new Error("conversation persistence resolver must return an object or undefined");
    }
    for (const key of Object.keys(override)) {
      if (!KNOWN_KEYS.has(key)) throw new Error(`unknown conversation persistence override key: ${key}`);
    }
  }

  #resolveCapture(override: ConversationRecordCaptureConfig): ConversationRecordCapturePolicy {
    const key = canonicalJson(override);
    const cached = this.#capture.get(key);
    if (cached) return cached;
    // Per key: the override replaces the Agent's value; `protocol` is one key, so its level and method
    // filters are replaced together.
    const resolved = resolveConversationRecordCapture({ ...this.base.captureConfig, ...override });
    // Checkpoints over messages stored as metadata would summarize empty text, and identity would deliver
    // empty lines. `none` is fine: such a conversation simply has nothing to checkpoint.
    if (this.base.checkpointing?.enabled && resolved.message === "metadata") {
      throw new Error(
        'conversation checkpointing is enabled: message capture "metadata" would checkpoint empty messages',
      );
    }
    this.#capture.set(key, resolved);
    return resolved;
  }

  /** `null` takes the conversation out of the audit stream; a configuration changes what it records there. */
  #resolveAudit(
    override: false | { readonly capture?: AgentConversationAuditCaptureConfig },
  ): ResolvedAgentAuditLogConfig | null | undefined {
    if (override === false) return null;
    if (override === null || typeof override !== "object" || Array.isArray(override)) {
      throw new Error("conversation auditLog override must be false or an object");
    }
    if (!this.base.auditLog) throw new Error("conversation audit capture requires an Agent audit log");
    if (override.capture === undefined || Object.keys(override.capture).length === 0) return undefined;
    const key = canonicalJson(override.capture);
    const cached = this.#audit.get(key);
    if (cached) return cached;
    const resolved = resolveConversationAuditConfig(this.base.auditLog, this.base.auditCaptureConfig, override.capture);
    this.#audit.set(key, resolved);
    return resolved;
  }
}
