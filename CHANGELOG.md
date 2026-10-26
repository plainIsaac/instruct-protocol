# Changelog

All notable changes to this project are recorded here. The project follows
[Semantic Versioning](https://semver.org/). Until 1.0.0, minor releases may change
the protocol, wire format, and public API.

## [Unreleased]

## [0.1.0-alpha.0]

First pre-release of the Instruct protocol drafts and TypeScript reference
implementation. This release is for evaluation. It is not a production security
boundary; see `SECURITY.md` for the release gates that remain open.

### Added

- Instruct Core and Instruct Lua specification draft (`spec.md`) and the
  independent Toolring specification draft (`TOOLRING.md`).
- `run()` with workflow normalization, static analysis, and authorization as the
  intersection of required, declared, granted, and host-permitted authority.
- Constrained Lua execution in a WebAssembly VM (wasmoon) with instruction, memory,
  output, tool-call, and call-depth budgets.
- Guarded values with sensitivity, disclosure labels, provenance, scope, expiry,
  and fail-closed remote representation.
- Scoped, expiring, single-use opaque handles.
- Deterministic, chained receipts with sanitized events and metrics, plus
  pluggable receipt signing with an Ed25519 reference profile.
- Reference production profile (`PRODUCTION.md`): required receipt signer, audit
  observer, and process isolation for effectful tools via `processTool()`.
- Observers: `BufferedObserver`, `JsonLogObserver`, `CompositeObserver`, and
  `SecurityAuditObserver`.
- Structural validation of untrusted capsules and guards; JSON schemas exported
  from `instruct-protocol/schemas`.
- Confidential file-search example and live model benchmarks.
- Instruct Lua tool API: `instruct.tool(name, args)` is authorized against declared
  and granted capabilities and effects, propagates guards, records observed
  effects, and accepts only handles the run has received.
- `ToolDefinition.idempotent`, and the `ProtocolError` and `errorCode` exports.

### Security

Fixed before this pre-release, relative to the earlier development commits:

- A Lua program could hang the host indefinitely. The instruction hook never applied
  to the program's coroutine, and the JavaScript timeout cannot interrupt
  synchronous WebAssembly. Lua now runs in a worker thread that is terminated at its
  deadline.
- Tool and Lua error text, which can contain guarded values, was copied into event
  codes, audit logs, and receipts. Only stable codes now cross the boundary.
- The grant's `disclosureDestinations` was never enforced, so raw values could be
  disclosed remotely when the grant permitted only local disclosure.
- A code capsule's program ran with the full grant rather than its declared
  capabilities and effects.
- `math.random`, `print`, `string.dump`, and `coroutine` were reachable from Lua.
- Inputs reached Lua as live JavaScript proxies that exposed host functions such
  as `Object`. Host values are now copied into plain Lua tables.
- `__gc` finalizers run with hooks disabled, so they could do unmetered work.
  `setmetatable` now refuses metatables with `__gc`.
- Program events reported instruction counts and output sizes, which depend on
  guarded data.
- Merged guards could keep a later expiry when timestamps used different offsets.
- Expired guarded values could still be disclosed remotely.

### Changed

- `run()` and `executeWorkflow()` return a receipt with status `denied` for
  authorization and interpretation denials, rather than throwing. A failed code
  capsule returns a `failed` receipt.
- `retry.compensate` now runs the named compensation path and records its outcome.
  `ToolDefinition.compensate` is removed.
- Analysis rejects retrying an irreversible effect on a non-idempotent tool,
  including tools a code node may call (`UNSAFE_RETRY`); compensation paths that
  re-enter normal flow or terminate (`INVALID_COMPENSATION`); and unknown condition
  operators (`INVALID_CONDITION`). Compensation runs only if a tool was invoked.
- A workflow code node receives only the parent's remaining time and tool calls.
- Colliding remote result names receive positional names instead of overwriting
  each other.

[Unreleased]: https://github.com/plainIsaac/instruct-protocol/compare/v0.1.0-alpha.0...HEAD
[0.1.0-alpha.0]: https://github.com/plainIsaac/instruct-protocol/releases/tag/v0.1.0-alpha.0
