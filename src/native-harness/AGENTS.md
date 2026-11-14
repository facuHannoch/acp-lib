# Native harness contribution rules

These instructions apply to this directory. Read [README.md](README.md) for current
implementation status and [ARCHITECTURE.md](ARCHITECTURE.md) for the agreed design.
Detailed scope and acceptance criteria live in the linked research specs.

## Scope and boundaries

- Implement the requested slice. The current first milestone is a small inner
  loop for learning; do not implement all of v1 without a request.
- Keep this directory independently extractable. Never import acp-client code
  from outside it. Record external dependencies in the README.
- Keep the kernel limited to coordination. Rendering, provider formats, tools,
  permission rules, retries and compaction belong behind contracts.
- Use the grouped `src/` layout in ARCHITECTURE.md. Create folders only as needed;
  do not add feature modules beside the package manifest.
- Entry points assemble and dispatch. Tool behavior, transport handling and
  observation logic belong in their owning modules, not in the CLI entry point.
- `contracts/` imports nothing; `kernel/` imports only contracts. Feature modules
  communicate through contracts, never another module's internals. A small
  `util/` may import only contracts. Assemble implementations at entry points.
- Production library integration belongs in `src/native/` and uses only public
  harness entry points (`index.ts`, `client.ts`, `testing.ts`, and future dedicated
  adapter entry points). Hosts must not import kernel internals.
- A change touches one extension point or the kernel, not both. Split work that
  needs both into a contract decision first and implementation changes afterward.

## Contracts and decisions

- Each extension point has a contract file and shared conformance suite. Document
  guarantees on every public type and extension point.
- Changes to contracts or conformance suites require a decision record under
  `.res/decisions/`, relative to this directory. This overrides the original
  project's top-level `decisions/` location at the owner's request.
- Keep records under a page: problem, options, choice and compatibility impact.
  Use the next available `NNNN-short-name.md` filename; create the directory when
  the first record is needed.
- Contract changes land separately, before implementations that depend on them.
- Keep other working documents and experiments under `.res/`; keep runnable code
  and durable architecture instructions outside it.

## Implementation and verification

- Add comments explaining non-obvious ownership, sequencing and design decisions.
  Do not merely restate function names. Keep comments current when behavior moves.
- Keep data provider-neutral; translate provider shapes only inside model clients.
  Preserve reasoning data unchanged and return it only to its originating provider.
- Enforce rights in code. Tool placement and prompt text do not replace a gate.
- Use typed values for expected failures; return actionable tool errors. Pair every
  tool result with its call and honor abort signals.
- New providers, stages, renderers, compactors, middleware, guards and clients
  belong in their module and must pass the relevant conformance suite.
- New inbox kinds need a renderer and golden scenario in the same change. New
  model clients need ModelClient conformance and golden provider requests.
- Update golden expectations with changes to pipeline, rendering or compaction.
  Reproduce bugs discovered in live runs with scripted scenarios before fixing.
- Automated tests run offline without provider keys. Keep live evals separate.
  Run checks appropriate to the implementation and report what was verified.
- Keep harness tests in `test/`, runnable independently. Add verified development
  commands to the README when the relevant code exists.
- Files over about 400 lines or modules over about 2,000 need a reason in review.
  Automate dependency boundary checks as implementation begins.

## Delegated work

- Each workstream owns its folders; avoid concurrent edits to the same module.
- Pending contract changes block dependent implementation.
- Handoffs identify the extension point, contract version and conformance status.
- Update documentation to reflect implemented behavior; distinguish planned APIs
  from APIs that actually exist.
