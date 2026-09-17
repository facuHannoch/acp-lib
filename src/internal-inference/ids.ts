import { randomUUID } from "node:crypto";
import type { InternalInferenceId } from "./contracts.ts";

export function createInternalInferenceId(): InternalInferenceId {
  return `aii-${randomUUID()}`;
}

export function isInternalInferenceId(value: unknown): value is InternalInferenceId {
  return typeof value === "string" && /^aii-[0-9a-f-]{36}$/i.test(value);
}
