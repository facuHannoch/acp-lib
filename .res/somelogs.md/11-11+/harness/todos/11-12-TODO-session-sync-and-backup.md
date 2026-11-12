# TODO: keeping a durable copy of a harness session (sync and backup)

Related: `../11-11-SPEC-harness-v1.md` (storage, export and import), `../../library/11-11-SPEC-native-harness-integration.md`
(where the session lives). Written 2026-11-12. Out of scope for v1: there is no simple harness yet, and v1 accepts the
limitations below.

## v1 limitations, accepted

- The harness writes its session (timeline, positions, shared state, usage, channel snapshots) to its home. The home
  is settable (`AgentConfig.harness.home`, `harness --home`); acp-client's data location is the default when it
  hosts.
- **A path the harness can't reach just fails.** acp-client can't tell whether the harness runs isolated (the launcher
  is opaque: it may wrap the harness in a container or only set an environment variable), so pointing the home at a
  place that exists only on acp-client's side is the consumer's mistake to avoid.
- **An isolated harness on an ephemeral home loses the entity when its environment goes away,** unless the consumer
  mounts a durable volume or exports.
- **Backup is manual:** `session/export` returns the whole entity as a bundle (acp-client: `agent.harness.export()`),
  and a session can be created from a bundle (`agent.harness.import(bundle)` before the first start). A consumer may
  export on close, for example.

## Options for later

- **Continuous copy in acp-client.** The harness sends new timeline events as they are appended and channel snapshots
  on idle and close; acp-client stores them opaque, keyed by session, kind and sequence. On start the harness reports
  the last sequence it has; if its copy is missing or behind, acp-client imports. Always on, so nothing has to detect
  isolation. Storage: a persistence extension in acp-client's SQLite (transactional with the records, one file per
  `Agent`; needs a runtime read/write handle for extensions, which don't have one today) or plain files (simpler, not
  transactional).
- **Delegated writing.** A mode in which the harness writes its session through the host (a store callback over the
  protocol) instead of to its home. The timeline would then live in acp-client, which may make sense if the timeline
  becomes central to acp-client itself.
- **Periodic export** by acp-client, as a cheap middle ground.
