# Real media and pointer probes

Run from the repository root. These use the installed ACP harness and its configured account;
they submit synthetic media and edit only generated test files. Results go to `measurements/`.
A turn is cancelled after 45 seconds and bounded at 55 seconds.

```sh
bun run smoke-tests/media/real-harness.ts claude
bun run smoke-tests/media/real-harness.ts codex
bun run smoke-tests/media/real-harness.ts opencode
bun run smoke-tests/media/real-harness.ts grok
```

Options are environment variables:

- `ACP_MEDIA_MODEL`: select an advertised model for these sessions, without changing global settings.
- `ACP_MEDIA_RESULT`: report path.
- `ACP_MEDIA_PROBES=paths`: only run direct/symlink read-edit probes.
- `ACP_MEDIA_CASE=undeclared-symlink`: run one path case.
- `ACP_MEDIA_OUTSIDE_ROOT`: generate external targets below this directory instead of `/tmp`.
  Use a directory writable by the tester, outside both the harness cwd and `/tmp`, to distinguish
  workspace scope from the common `/tmp` exception. Generated child directories are removed.

Permission requests are approved once only when their body names a generated test root. Other
requests are cancelled. Reports include these decisions; they are observations of the installed
harness configuration, not guarantees for other sandbox modes or machines.

## 2026-10-24 observations

| Harness | Image copy | Embedded text file | PDF blob copy | Audio | File link |
|---|---|---|---|---|---|
| Claude ACP 0.85.0 | red recognized | marker read | `UNAVAILABLE` | unadvertised | marker read |
| Codex ACP 2.1.1 | red recognized | marker read | marker read | unadvertised | marker read |
| OpenCode 1.18.34, OpenCode Go `gpt-6-luna` | red recognized | marker read | marker read | unadvertised | marker read |

Claude advertises embedded context but did not expose the embedded PDF blob to the model.
The library sent the correct block; there is no protocol receipt proving that a model saw it.
Use a file link or a supported copy form with that adapter. This matches the previously noted
adapter limitation; no harness-specific rewrite was added to the library.

OpenCode's default `opencode/big-pickle` failed because its configured API key was expired.
The already configured OpenCode Go account worked; its results and the default-provider
failures are both retained. No credentials or global settings were changed.

Direct and symlink paths were tested with and without `additionalDirectories`, first with
external files under `/tmp`, then with synthetic repository targets outside both the harness
cwd and `/tmp`. All three harnesses read the external markers. Codex and OpenCode modified all
four external targets. Claude modified three targets in the first external run; its undeclared
symlink target was unchanged despite a completed response. A focused repeat read and modified
that target and preserved the symlink. Both observations are retained rather than treating a
model's completion status as proof of a write.

Claude requested scoped read/edit permissions outside its workspace; declaring the directory
reduced read prompts but did not remove write permissions. Codex issued no ACP permission
requests in this environment. OpenCode requested external-directory permissions even in the
declared run (it does not advertise additional-directory support). Approved requests and actual
file changes are recorded. Symlinks do not establish a portable permission boundary.

These are small acceptance probes. They do not cover large-file/provider limits, all audio
models, strict sandbox variants, remote mounts, image/audio output from real models, or every
MIME type. Deterministic fixture tests cover output parts, replay and storage separately.

## 2026-10-25 rerun: embedded copies with the `attachment:///` uri

Embedded copies now carry `attachment:///<name>` instead of `file:///<name>`. Text-file and PDF copies
only, one throwaway session per harness, deleted afterwards:

| Harness | Embedded text file | PDF blob copy |
|---|---|---|
| Claude (default model) | marker read | `UNAVAILABLE` (as before) |
| Codex (default model) | marker read | marker read |
| OpenCode, `opencode-go/deepseek-v4.1-flash` | marker read | `UNAVAILABLE`: "this model does not support PDF input" |

OpenCode's PDF result is the model's, not the uri's: the same run with the old `file:///` uri gave
the same answer. The 2026-10-24 OpenCode PDF read used `gpt-6-luna`.

## 2026-10-26: Grok Build (grok 1.0.70, `grok-4.7`)

| Image copy | Embedded text file | PDF blob copy | Audio | File link |
|---|---|---|---|---|
| not seen: "too small to view" (the probe's 16x16 PNG; a 256x256 red PNG was read) | marker read | `UNAVAILABLE` | unadvertised | marker read |

Paths: the undeclared direct and symlink targets were read and modified (symlink preserved). The
declared run first failed with `Invalid params`: Grok does not advertise additional directories and
refused the session request that carried them. The client now leaves them out when unadvertised, and
the declared direct case then completed. Grok saves an embedded copy to a file of its own.

