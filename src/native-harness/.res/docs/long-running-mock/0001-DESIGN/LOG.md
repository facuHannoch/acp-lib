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

## Gate 1 review follow-up

Clad declined `779a200f97b5b5c44f19d6be71f13c33cf84acb6` after passing both
typechecks. This revision pins the boundary evidence and storage check
ordering, and completes the loader inventory. The exact model-boundary IDs
are separate from the existing receipt set. Gate 2 will include a golden
provider request that omits them.

`interfaces/cli/start.ts` (`bun run start --script`) passes the selected
script into `openDevelopment`. The shared JSONL loader belongs at that
development assembly point so explicit paths and saved configuration both
reach one read and validation.

| Remaining harness test user | Script source |
| --- | --- |
| approval-gate, model-channel-double, owner-config, tools-catalog | Inline model doubles with placeholder paths. They never open script files. |
| model-crash, crash, e2e | Checked-in crash and hold fixtures, converted to JSONL. |
| model-e2e | Checked-in model-e2e and echo fixtures, converted to JSONL. |
| permissions-e2e | Checked-in approval fixture, converted to JSONL. |
| persistence, protocol, suspension | Checked-in crash, echo or hold fixture for public tests, plus inline model doubles for direct session tests. |
| startup-channel-changes | Checked-in hold fixture, converted to JSONL. |
| session-file | Config path string only, deliberately absent for portability tests. No file is read. |

The contract-only follow-up passed both package typechecks. Independent
re-review is pending.

Clad approved Gate 1 at `53d99b827978b8c22600dff9862b6f27793fdf54`. Both
typechecks passed independently on a clean checkout.

## Gate 2

Managed stdio, development startup (including saved config), and the scenario
command now share the JSONL loader. The checked-in and generated file
fixtures use JSONL. Some unit tests still inject inline model doubles or
use the in-memory scripted helper. Those paths do not read files.

The selected scenario loads once per open and uses the index reserved by
storage for each attempt. Scripted attempts send accepted before their
terminal response, so the converted tests check both delivered and seen
milestones. The receipt-crash fixture now kills after the second confirmation
to retain its original Seen coverage. Full request capture is opt-in.
The lightweight attempt log includes the reserved step, attempt ordinal,
and inputs first included at the boundary. The OpenRouter golden request
omits the input IDs.

Both adapters reject untagged, malformed and changed scripted keys before
application recovery. The real stdio crash fixture leaves accepted input
pending with no checkpoint, compares the complete database bytes after a
changed-script rejection, and reopens with the original script at step zero.
Separate coverage checks per-channel selection, retry consumption, usage,
streaming, delayed cancellation, and exhaustion. The existing real-stdio
notice case runs through the JSONL adapter and ordinary tool dispatch.

Verification passed both package typechecks, all 343 harness tests with
`bun test ./test --timeout 30000`, and all 76 native tests with
`bun test ./test/native`. The final exact-key conformance rerun passed on
both adapters. Removing the redundant test-only file wrapper was followed
by a 13-test scripted, JSONL and provider adapter rerun. The stand-alone echo
command returned the expected result and captured no requests by default.
Independent review of this submission is pending.
