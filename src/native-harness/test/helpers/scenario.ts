import type { ScenarioModelRecord } from "../../src/contracts/scenario.ts";

export function modelScenario(responses: readonly (Partial<ScenarioModelRecord> & { content: string | null })[], name = "test"): string {
  return [{ type: "scenario", version: 1, name }, ...responses.map(response => ({ type: "model", ...response }))]
    .map(record => JSON.stringify(record)).join("\n") + "\n";
}
