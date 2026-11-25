# 0039 · Trusted inference relay

Keep decision 0034's ordinary endpoint and credential rules. Add an explicit
relay credential mode and a runtime-only executable-open grant for one
canonical URL, credential and expiry. Use the same canonical URL for comparison
and dispatch. Bypass ambient proxies and refuse redirects. Relay mode never
resolves an upstream key from the environment.

The grant is authority on a trusted native control connection. The embedding
application owns workload authorization and plaintext deployment isolation.
Grant material is excluded from storage, inspection and checkpoint identity.
Changes to the execution credential mode fence a checkpoint. Reopen acquires
fresh material and expiry is checked before each dispatch. Existing archive
formats carry the portable declaration.

See the [trusted inference relay specification](../docs/model-execution/0005-AMENDMENT-trusted-http-inference/SPEC.md).
