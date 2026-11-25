# 0038 · OpenCode Go for native inference

OpenCode Go requires stable conversation routing metadata. The native
managed model config adds an explicit `opencode-go` preset backed by the
existing text Chat Completions adapter. The preset fixes the endpoint to Go,
sets the native harness User-Agent, and sends a `ses_` ID derived from the
durable session and channel. Reject redirects and arbitrary headers.

Resolve the configured credential reference at executable open. The default
is `OPENCODE_API_KEY`. Keep secret values and raw upstream errors out of
storage and observations. Report the HTTP status and safe error categories
on the turn outcome. Preserve retry rules.

The preset, fixed source and upstream model participate in checkpoint
identity. Credential rotation preserves compatibility. Managed configs and
archives keep the existing versions. Older strict readers refuse the preset.
See the [amendment](../docs/model-execution/0004-AMENDMENT-opencode-go/SPEC.md).
