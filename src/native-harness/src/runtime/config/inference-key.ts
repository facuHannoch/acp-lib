import { createHash } from "node:crypto";
import type { ManagedModel } from "../../contracts/config-permissions.ts";

export function compatibleInferenceKey(model: Extract<ManagedModel, { protocol: "openai-compatible" }>,
  system: string, tools: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([model.protocol, model.providerId, model.baseUrl, model.model, system, tools])).digest("hex");
}
