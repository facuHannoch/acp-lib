# Session replay probe

Loads existing sessions with `session/load` and prints what each harness replays: the update kinds, their order,
whether turns can be told apart, and whether tool calls (folded by id, with input, output and final status), thoughts and cancelled turns appear. Loading a session
replays history and does not call the model, so it spends no tokens.

```sh
bun smoke-tests/session-replay-probe/index.ts
ACP_PROBE_SESSIONS=codex:<id>,opencode:<id> ACP_PROBE_LIST=1 bun smoke-tests/session-replay-probe/index.ts
```

By default it loads the sessions the `test11-steerTurn` runs left (control, steer, and mid-tool cancel for Codex;
control, steer and a cancelled story for OpenCode). The raw notifications of each session are written next to the
script as `<adapter>-<id>.json` (git-ignored). It is the evidence behind the "Replay" section of
`.res/somelogs.md/9-22+/10-2-SPEC-adopt-provider-session.md`.
