# Instruct Protocol

Instruct is an experimental model-context protocol for running frontier-model instructions in sensitive local environments. It supports two distinct, composable instruction families:

- a lenient model-facing workflow proposal normalized into a strict, deterministic orchestration graph;
- constrained Lua code executed by a WebAssembly-hosted VM.

Both paths use capability grants, declared effects, bounded execution, guarded values, local-only handles, and tamper-evident remote-safe receipts.

## Security boundary

Frontier-generated workflows and programs are hostile input. A workflow proposal is never executable: it must first be normalized, statically analyzed, and authorized. Local intent resolution may repair names or arguments, but cannot add a capability or effect. Lua receives no filesystem, network, package loader, clock, or process APIs. The local policy engine—not a local model—is authoritative.

This is a v0.1 reference prototype, not a production sandbox. WASM isolates the Lua VM from the TypeScript host, while OS process isolation, attestation, hardened key storage, and independently audited policy implementations remain future work.

The current implementation now uses deterministic canonical JSON for protocol and receipt SHA-256 digests, validates untrusted capsule and guard structure at the public boundary, and includes required-rejection conformance tests. See `SECURITY.md` for the deployment controls and release gates that remain outside the library.

## Install and verify

```sh
pnpm install
pnpm test
pnpm build
```

The primary API is `run(capsule, options)`. Lower-level entry points include `normalizeWorkflow`, `analyzeWorkflow`, `executeWorkflow`, `analyzeProgram`, and `executeProgram`. See `examples/private-workflow.ts` for an orchestration graph containing a sandboxed code node.

`examples/confidential-file-search.ts` is a concrete protocol benchmark for finding a vaguely remembered file on a confidential workstation. The model-facing workflow receives only the user's description, an opaque scoped search handle, and a public presentation receipt. Filenames, content, similarity scores, and vectors remain inside a trusted local retrieval service. `HashingEmbedder` makes the example deterministic and offline; the `TrustedEmbedder` and `TrustedIntentInterpreter` interfaces are intended to be replaced by pinned, audited local models.

Run the same scenario against a real model with `pnpm bench:live`. Copy `.env.example` to `.env` and set either `OPENAI_API_KEY` or `OPENROUTER_API_KEY`; `.env` is ignored by Git. When only one key is configured the provider is selected automatically. If both exist, set `INSTRUCT_BENCH_PROVIDER=openai` or `openrouter`. OpenRouter defaults to `openai/gpt-5.6`, while direct OpenAI defaults to `gpt-5.6-sol`; `INSTRUCT_BENCH_MODEL` and `INSTRUCT_BENCH_REASONING` override either default. The runner stores timestamped, git-ignored JSON reports in `benchmark-results/` containing provider, model, task success, canary leakage, protocol calls and depth, latency, token usage, model response IDs, and hashes of model-proposed workflows. It never stores raw model output, credentials, or confidential fixture contents in the report.

Use `pnpm bench:warning` for the matched warning-only control. This deliberately sends the raw synthetic file index to the model with a strong instruction not to disclose it. Its report distinguishes secrets exposed in model input from canaries repeated in model output, while measuring retrieval success on the same cases.

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
