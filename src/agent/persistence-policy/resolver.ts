import type { ConversationRecordCaptureConfig, ConversationRecordCapturePolicy } from "../../persistence/backend.ts";
import { resolveConversationRecordCapture } from "../../persistence/backend.ts";
import type { ManagerSettings } from "../manager-settings.ts";
import type {
  AgentConversationPersistenceOverride,
  ConversationPersistenceContext,
  ConversationPersistenceResolver,
} from "./types.ts";

const SUPPORTED_KEYS = new Set(["capture"]);
const NOT_YET_SUPPORTED = new Set(["auditLog", "meteringRecords"]);

/** Stable JSON: object keys sorted, so equal overrides share one cache entry. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested);
}

/**
 * Turns the Agent's settings and the consumer's resolver into the settings one conversation runs with.
 *
 * The resolver is called when a conversation starts (and for writes about a conversation that is not
 * live). A resolver that throws, or returns something invalid, is a caller mistake: the error is
 * thrown as it is, before any write. Identical overrides are validated and resolved once.
 */
export class ConversationSettingsResolver {
  readonly #cache = new Map<string, ConversationRecordCapturePolicy>();

  constructor(
    private readonly base: ManagerSettings,
    private readonly resolver: ConversationPersistenceResolver | undefined,
  ) {}

  settingsFor(context: ConversationPersistenceContext): ManagerSettings {
    if (!this.resolver) return this.base;
    const override = this.resolver(context);
    if (override === undefined) return this.base;
    this.#validateShape(override);
    const captureOverride = override.capture;
    if (captureOverride === undefined || Object.keys(captureOverride).length === 0) return this.base;
    return { ...this.base, capture: this.#capture(captureOverride) };
  }

  #validateShape(override: AgentConversationPersistenceOverride): void {
    if (override === null || typeof override !== "object" || Array.isArray(override)) {
      throw new Error("conversation persistence resolver must return an object or undefined");
    }
    for (const key of Object.keys(override)) {
      if (NOT_YET_SUPPORTED.has(key)) {
        throw new Error(`conversation persistence override "${key}" is not supported yet`);
      }
      if (!SUPPORTED_KEYS.has(key)) throw new Error(`unknown conversation persistence override key: ${key}`);
    }
  }

  #capture(override: ConversationRecordCaptureConfig): ConversationRecordCapturePolicy {
    const key = canonicalJson(override);
    const cached = this.#cache.get(key);
    if (cached) return cached;
    // Per key: the override replaces the Agent's value; `protocol` is one key, so its level and method
    // filters are replaced together.
    const resolved = resolveConversationRecordCapture({ ...this.base.captureConfig, ...override });
    if (this.base.checkpointing && resolved.message === "metadata") {
      throw new Error(
        'conversation checkpointing is enabled: message capture "metadata" would checkpoint empty messages',
      );
    }
    this.#cache.set(key, resolved);
    return resolved;
  }
}
