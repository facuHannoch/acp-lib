import { Fail } from "./engine.ts";

export function checkScriptIdentity(key: string, required: string | undefined): void {
  if (required === undefined) return;
  const tagged = /^scripted-jsonl-v1:([a-f0-9]{64}):[a-f0-9]{64}$/.exec(key);
  if (tagged?.[0] !== key || tagged[1] !== required) throw new Fail("incompatible", "Scripted model sequences differ or the stored script identity is missing");
}
