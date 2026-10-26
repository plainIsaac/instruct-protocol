# Instruct Protocol

Instruct is an experimental model-context protocol for running frontier-model instructions in sensitive local environments. It supports two distinct, composable instruction families:

- a lenient model-facing workflow proposal normalized into a strict, deterministic orchestration graph;
- constrained Lua code executed by a WebAssembly-hosted VM.

Both paths use capability grants, declared effects, bounded execution, guarded values, local-only handles, and tamper-evident remote-safe receipts.

The protocols have separate specifications: [Instruct Core and Instruct Lua](./spec.md)
and the independently usable [Toolring protocol](./TOOLRING.md).

## Security boundary

Frontier-generated workflows and programs are hostile input. A workflow proposal is never executable: it must first be normalized, statically analyzed, and authorized. Local intent resolution may repair names or arguments, but cannot add a capability or effect. Lua runs in a dedicated worker thread with no filesystem, network, package loader, clock, randomness, debug, coroutine, or process APIs, and the host terminates the worker when its time budget expires. The local policy engine—not a local model—is authoritative.

This is a pre-release (`0.1.0-alpha`) reference prototype, not a production sandbox. WASM isolates the Lua VM from the TypeScript host, and production mode can run effectful tools in child processes. OS-level sandboxing of those processes, attestation, hardened key storage, and independently audited policy implementations remain the deployer's responsibility or future work.

The TypeScript reference implementation uses deterministic JSON and SHA-256 for
its local instruction and receipt digests. These are implementation choices, not
mandatory Instruct or Toolring wire formats. The protocol treats map member order
as non-semantic and permits independently specified serialization and integrity
profiles. The public API also performs partial structural validation of untrusted
capsules and guards. See `SECURITY.md` for remaining schema work, deployment
controls, and release gates.

## Install and verify

Requires Node.js 22 or newer. Pre-releases are published under the `next` tag:

```sh
pnpm add instruct-protocol@next
```

To work on the repository:

```sh
pnpm install
pnpm check
pnpm test:security
```

`pnpm release:check` runs type checking, the complete test suite, focused
security tests, a production dependency audit, and package checks. Its
`pnpm test:consumer` step packs the library, installs that tarball in a fresh
consumer, and exercises the public API without importing repository sources.
It tests filesystem-backed retrieval and local presentation, authenticated
receipts and tamper rejection, authorization and guard denial, Lua execution,
process-tool execution, sanitized failures, cancellation, and process timeout.
These checks run on Node 22 and 24 in CI. Changes are listed in `CHANGELOG.md`.

This is an exercised reference integration, not a live-model quality benchmark,
an operating-system sandbox, or evidence of complete information-flow isolation.
Search quality still depends on the supplied embedder and intent interpreter.

The library includes hardened application boundaries, but production readiness is
a property of a specific deployment. In particular, effectful tools need OS-level
isolation and enforceable cancellation, and receipts need a deployment-selected
signature or MAC profile when authenticity is required. See `SECURITY.md` for the
acceptance checklist and external release gates, and `PRODUCTION.md` for the
enforced reference production profile.

The primary API is `run(capsule, options)`. Lower-level entry points include `normalizeWorkflow`, `analyzeWorkflow`, `executeWorkflow`, `analyzeProgram`, and `executeProgram`. See `examples/private-workflow.ts` for an orchestration graph containing a sandboxed code node.

`run()` throws only for malformed input: an invalid capsule or grant, an unsupported protocol version, or incomplete production options. Every other outcome returns a receipt with one of three statuses:

- `denied`: authorization or interpretation prevented execution. A `run.denied`, `workflow.denied`, or `program.denied` event carries the stable code.
- `failed`: execution started but did not complete.
- `completed`: execution reached a terminal result. The result may still be withheld from the remote representation.

Events and receipts carry only stable error codes. Error text from tools, intent resolvers, and Lua never leaves the host, because it can contain guarded values.

### Instruct Lua reference API

A code capsule or code node defines `function main(instruct)`. Its return value must be JSON-representable.

- `instruct.inputs` holds the evaluated inputs. A handle-only value appears as `{ ["$handle"] = id, type = type }`.
- `instruct.tool(name, args)` calls a registered tool by exact name and returns its value or handle. The call succeeds only if the tool's capability and every one of its effects are both declared and granted. On failure it raises a stable code string, such as `TOOL_CAPABILITY_DENIED`, that the program can catch with `pcall`. A handle passed back as an argument resolves only if this run received that handle.
- Lua values carry no guards. Every tool argument, and the program result, therefore inherits the merged guard of all inputs and tool results the program has seen.
- Instructions, produced JSON output, and tool calls use one cumulative workflow/Lua budget across children, loops, retries, and recovery. The deadline includes VM startup. Lua memory is a peak-live per-worker allocation limit, not a limit on host or tool-process memory. `setmetatable` refuses `__gc`, because finalizers would run unmetered.

### Toolring failure handling

`retry.attempts` repeats an action. When the attempts are exhausted, `retry.compensate` names a compensation path, which runs as ordinary authorized nodes, and `retry.recover` names where control continues. The compensation outcome is recorded as `node.compensated` or `node.compensation.failed` and never masks the original failure. Analysis rejects retrying a tool with an irreversible effect unless the tool sets `idempotent: true`.

The current strict profile rejects terminal nodes reachable inside a loop before
its loop boundary, inside a parallel branch before its join, or in compensation.
Root terminal and root recovery results remain valid; nested results are never
silently discarded. `observedEffects` conservatively records the declared possible
effects of calls that entered execution, including failed or timed-out calls.
It is not a claim that every declared effect occurred or that compensation undid it.

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

Every value carries sensitivity, disclosure labels, provenance, contributing handles, transformation history, permitted operations and destinations, scope, expiry, and correlation policy. Composite values inherit the strictest contributing guard.

- A tool declares `operations` (default: its capability). Each argument and implicit
  dependency must permit every operation and its `tool:<registered-name>` destination.
  `local` permits local registered tools; `tool:<name>` narrows that authority.
- Empty permissions deny. `defaultGuard(scope)` for a public value explicitly grants
  `*` operations; sensitive defaults grant none. Wildcard intersections retain the
  narrower permission. Expired guards and handles fail before tool execution.
  Retrieval persists inherited deadlines in its authoritative handle store, so a
  caller cannot extend a handle's life by editing returned metadata.
- `HandleStore` snapshots stored values, returned descriptors, and resolved values;
  payloads must support `structuredClone` (protocol JSON payloads do). Mutating a
  returned object does not change the stored value or deadline.
- Ordinary tool outputs inherit input restrictions. Declassification requires an
  audited, host-registered `outputTransform` with explicit guarantees; a returned
  guard cannot authorize its own declassification. The retrieval example declares
  trusted handle-creation and fixed-status transforms explicitly.
- Conditions and loops conservatively retain control dependencies for subsequent
  outputs and tool calls, including no-argument calls and child Lua programs.
  This can intentionally withhold results that a more precise analysis could allow.
- Lua checks all-seen dependencies even for empty argument tables and known handles.
  Its static analyzer ignores data in strings/comments and property names. It is
  advisory, not a full Lua parser or the security boundary. Local bindings that
  shadow forbidden global names (for example `local os`) are still conservatively
  rejected; use another local name.

Timing, event/control-flow metadata, and completion/failure signaling remain
observable. This profile does not promise complete information-flow isolation;
see `SECURITY.md` before using it with sensitive workloads.
