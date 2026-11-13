# TODO: `billing_required` for native conversations

Status: **moved into integration stage 2a** (`../11-11-SPEC-native-harness-integration.md`, Billing-grade metering;
brief N10), decided 2026-11-13: the library must know native costs as precisely as the OpenCode plugin's. Written
2026-11-12 from review 3 of the integration spec; kept for the history of the decision.

## Why native can meet it

`billing_required` today is only satisfiable by the certified OpenCode plugin (`src/metering/certification.ts`),
which reports each model call with its own cost; plain ACP reports one usage per prompt and was measured undercounting
a tool-using turn 3.43x. The native harness reports usage per model call, with its purpose (integration spec,
Usage), which is what billing-grade metering needs.

## What it takes

- **A certification entry,** for example `native-harness@1`, whose inference source is fed from the harness's
  per-call usage events; supported versions are harness protocol versions.
- **Lookup by adapter kind:** certifications are found by adapter id today (`certificationFor("opencode")`), but
  native adapter ids are consumer-chosen (`"main"`); native needs lookup by kind.
- **"Live" with lazy start:** `billing_required` requires a live inference source presenting its certification, but
  a native harness isn't running at open. Proposal: check statically at open (installed package version and
  `describe`), confirm at the start handshake; if the harness can't confirm, the first turn fails before running
  rather than metering wrongly.
- **Cost:** from the harness when the provider reports it; otherwise priced by acp-client's catalog, as today.
- **What it guarantees for native:** accurate measurement, not refusal. A spending cap is deferred
  (`11-13-TODO-spending-cap.md`).

## Questions

- [ ] Whether compaction and other non-turn calls count toward billing records the same way.
- [ ] What the harness must prove at the handshake (version, model client, a metering capability flag).
