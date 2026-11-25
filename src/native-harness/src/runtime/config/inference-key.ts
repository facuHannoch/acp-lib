import { createHash } from "node:crypto";
import { OPENCODE_GO_BASE_URL, type CompatibleModel } from "../../contracts/config-permissions.ts";

export function compatibleInferenceKey(model: CompatibleModel,
  system: string, tools: readonly string[]): string {
  const source = model.protocol === "opencode-go" ? ["opencode-go", OPENCODE_GO_BASE_URL]
    : [model.protocol, model.providerId, model.baseUrl];
  return createHash("sha256").update(JSON.stringify([...source, model.model, system, tools])).digest("hex");
}
