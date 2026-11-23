import type { ScenarioModelRecord } from "../../src/contracts/scenario.ts";

type WithoutType<Record> = Record extends ScenarioModelRecord ? Omit<Record, "type"> : never;
export type ModelScenarioStep = WithoutType<ScenarioModelRecord>;

export function modelScenario(responses: readonly ModelScenarioStep[], name = "test"): string {
  return [{ type: "scenario", version: 1, name }, ...responses.map(response => ({ type: "model", ...response }))]
    .map(record => JSON.stringify(record)).join("\n") + "\n";
}
