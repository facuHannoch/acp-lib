# A2: corrected turn-event wording

Beta `fcd1fd49b6bf844724fb86a3040b0866e0ec4488` corrects the exclusivity contradiction raised in `.plan-execution/status/11-12-ISSUE-A2-turn-events.md`: the controller reports `turn_started` and, for backend-scheduled controllers, `turn_took`, never the end of a turn. The same commit contains an unrelated typo `subscgentribe`; it has no contract effect and is noted for the spec owner.

Both implementer and reviewer bring this beta commit into their respective existing branches and document the update. Preserve all work. Each sends bob-b a pointer to a committed report. A2 steps 2–4 remain held until bob-b confirms both branches contain the correction. The implementer's A2 step 1 was completed at `0383681`, reported in `db3d979`.
