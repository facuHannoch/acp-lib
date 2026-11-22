# Long-running mock implementation log

Base `da59a6c8734baabf911b98014e3fc080e90ca91b`, including approved
operator behavior `95670a2` and closure `8f2a139`. Work is on
`aiagent/cod1a-long-running-mock`. Clad reviews each gate.

## Gate 1 fixture and loader inventory

- Managed stdio uses `src/testing.ts`, which currently parses configuration's
  script file as JSON and validates again when it creates a channel model.
  `interfaces/cli/serve.ts` assembles that path.
- Development startup in `interfaces/cli/development.ts` reads the script
  twice and currently accepts a named-channel wrapper and fallback.
  `interfaces/cli/scenario.ts` and `test:scenario` use `loadScriptedModel`.
  The JSONL loader will replace all three paths.
- Checked-in files to convert under `test/fixtures/`: `approval-e2e.json`,
  `crash-scenario.json`, `development-scenario.json`, `echo-scenario.json`,
  `hold-scenario.json`, and `model-e2e.json`.
- Generated files to convert: harness `config-policy`, `model-large-reply`,
  `operator-controls`, `portability`, `scripted`, and `tools-protocol`
  tests, plus root `test/native/support.ts` and `host.test.ts`. Inline
  model-runner and stream-adapter fixtures should use validated scenario
  sequences when they exercise scripted playback. Unrelated persistence and
  provider JSON fixtures stay in their current formats.

## Review examples

Model-only, channel override and timed sends can share one fixture:

```jsonl
{"type":"scenario","version":1,"name":"mixed"}
{"type":"model","content":"Default reply"}
{"type":"send","atMs":0,"channelId":"alice","participantId":"operator","inputId":"a1","text":"Start"}
{"type":"model","channelId":"alice","delayMs":10,"chunks":[{"afterMs":5,"text":"One"}],"content":"One","usage":{"outputTokens":1}}
{"type":"send","atMs":0,"channelId":"bob","participantId":"operator","inputId":"b1","text":"Overlap"}
{"type":"model","channelId":"alice","failure":{"kind":"transient","message":"fixture transient"}}
{"type":"model","channelId":"alice","content":"Retry reply"}
```

Removing both sends makes this a model-only fixture. Alice uses only her
three records. Bob and any other channel independently use the default.
Appending a line with both `content` and `wait`, an invalid version, or a
duplicate input ID fails at that line. Equal offsets send Alice before Bob
without waiting for Alice's turn. After a crash with Alice's second position
reserved, subsequent work uses her third position; reopening with
changed model content fails before any recovery write. Editing only sends or
formatting preserves the model digest and changes the independent file digest.

The existing status, reconcile and bounded history path can establish the
final revision by comparing settled status again after paging. No protocol
method is added. Contract details are pinned in decision 0023.

Gate 1 submission passed `bun run typecheck --pretty false` in the root
and harness package. No loader, playback, storage runtime or fixture
conversion is in this revision. Independent review is pending.
