# Instruct Protocol

Instruct is an experimental model-context protocol for running frontier-model instructions in sensitive local environments. It supports two distinct, composable instruction families:

- a lenient model-facing workflow proposal normalized into a strict, deterministic orchestration graph;
- constrained Lua code executed by a WebAssembly-hosted VM.

Both paths use capability grants, declared effects, bounded execution, guarded values, local-only handles, and tamper-evident remote-safe receipts.

## Security boundary

Frontier-generated workflows and programs are hostile input. A workflow proposal is never executable: it must first be normalized, statically analyzed, and authorized. Local intent resolution may repair names or arguments, but cannot add a capability or effect. Lua receives no filesystem, network, package loader, clock, or process APIs. The local policy engine—not a local model—is authoritative.

This is a v0.1 reference prototype, not a production sandbox. WASM isolates the Lua VM from the TypeScript host, while OS process isolation, attestation, hardened key storage, and independently audited policy implementations remain future work.

## Install and verify

```sh
pnpm install
pnpm test
pnpm build
```

The primary API is `run(capsule, options)`. Lower-level entry points include `normalizeWorkflow`, `analyzeWorkflow`, `executeWorkflow`, `analyzeProgram`, and `executeProgram`. See `examples/private-workflow.ts` for an orchestration graph containing a sandboxed code node.

## Live events, logs, and performance

Pass a `ProtocolObserver` to `run()` to receive normalization, analysis, node, tool, program, recovery, failure, and completion events while a run is active. `BufferedObserver` retains events for test assertions, `JsonLogObserver` emits sanitized JSON Lines, and `CompositeObserver` fans out to multiple destinations.

```ts
const observer = new CompositeObserver([
  new BufferedObserver(),
  new JsonLogObserver(),
]);
const result = await run(capsule, { tools, grant, observer });
console.log(result.receipt.metrics);
```

Receipts contain event timestamps, elapsed and operation durations, plus aggregate normalization, analysis, execution, receipt, node, tool, code, retry, recovery, failure, and call-depth metrics. Event details are allowlisted operational metadata; common data-bearing fields are redacted before reaching observers.

Run `pnpm test:live` for a persistent watch session or `pnpm test:performance` for focused telemetry tests.

## Value guards

Every value carries sensitivity, disclosure labels, provenance, contributing handles, transformation history, permitted operations and destinations, scope, expiry, and correlation policy. Composite values inherit the strictest contributing guard. Trusted transforms may explicitly record a declassification guarantee; merely modifying or summarizing a value does not make it public.
