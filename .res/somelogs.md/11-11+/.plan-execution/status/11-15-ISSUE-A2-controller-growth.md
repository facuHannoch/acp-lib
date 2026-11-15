# A2: controller file growth versus updated execution plan

On `controller-interface` A1 `9de0ca3`, `src/controller.ts` is 756 lines; at A2 `6619cfa`, 825 lines. A2 step 3 directs `AgentController` to gain `send`, `subscribeTurns`, `prepareTurn`, `prepareInternalPrompt`, and `abandonTurn`. Current beta `5e01135` execution plan, updated while A2 was underway, says listed large files including `src/controller.ts` do not grow and code needed there is extracted first. The reviewer has not explicitly dispositioned this specific updated-plan requirement.

Ask spec owner via user whether A2 must extract the additions so the file does not grow, or whether to explicitly accept an exception for this in-progress A2. A2's numerical independent gate has passed but overall acceptance remains pending this and checkpoint triage. No further source change or exception inferred.
