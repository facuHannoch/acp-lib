import { createHash } from "node:crypto";
import type { ItemPolicy } from "../../contracts/config-permissions.ts";

/** Policy identity includes the caller's actual override, never the resolved
 * policy: a channel edit must not change the signature of an accepted item. */
export interface PolicyInputIdentity {
  kind: string; channelId: string; senderId: string; sourceChannelId?: string;
  text: string; explicitPolicy?: string | null;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function legacyItemSignature(item: PolicyInputIdentity): string {
  return digest([item.kind, item.channelId, item.senderId, item.sourceChannelId ?? null, item.text]);
}
export function policyItemSignature(item: PolicyInputIdentity): string {
  return digest([item.kind, item.channelId, item.senderId, item.sourceChannelId ?? null, item.text, item.explicitPolicy ?? null]);
}
/** The references contributed by a source turn include every earlier notice's
 * inherited restrictions. First occurrence order keeps the record stable. */
export function contributingPolicies(items: readonly ItemPolicy[]): string[] {
  return [...new Set(items.flatMap(item => [item.resolved, ...item.inherited]))];
}
