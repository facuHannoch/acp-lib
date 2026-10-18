import type { ActivityEvent } from "../types.ts";
export type ProviderOutput =
  | { readonly kind: "update"; readonly sessionId: string | null; readonly activity?: ActivityEvent }
  | { readonly kind: "request" | "permission_started" | "permission_ended"; readonly sessionId: string | null };
export type OutputListener = (output: ProviderOutput) => void;
