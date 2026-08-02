# Security and production-readiness requirements

Instruct is a security-oriented reference implementation, not a production
security boundary. WebAssembly isolates the Lua runtime from the TypeScript host,
but the host process and every registered tool remain trusted computing base.

## Implemented controls

- strict capability and effect intersection before workflow execution;
- guarded-value propagation and fail-closed remote representation;
- scoped, expiring opaque handles;
- finite workflow, Lua, tool-call, output, and call-depth budgets;
- allowlisted observer/event details and deterministic receipt digests;
- deterministic SHA-256 digests in the TypeScript reference profile;
- security-relevant structural validation of untrusted capsules, guards, effects,
  handles, transformations, programs, and budgets;
- stored handle expiry, metadata validation, and single-use replay prevention;
- fail-closed tool output and receipt verification; and
- pluggable authenticated receipts with an Ed25519 reference profile;
- enforced process boundaries for effectful tools in production mode;
- sanitized audit streaming and security alert hooks; and
- positive, required-rejection, and adversarial boundary tests.

The reference receipt digest detects accidental corruption and supports deterministic
chaining. Production mode additionally requires an independently versioned receipt
signer. The included Ed25519 adapter consumes a deployment-provided key and does not
load or store signing material itself.

## Required deployment controls

A production profile MUST add controls outside this package:

1. Run the host and each high-risk tool in a least-privilege OS identity or
   container with deny-by-default filesystem, network, process, and device access.
2. Place irreversible tools behind independent policy enforcement, idempotency
   keys, explicit user authorization where appropriate, and durable effect logs.
3. Store receipt-signing keys in a platform keystore or HSM. Do not keep signing
   material in environment variables or the JavaScript heap longer than needed.
4. Authenticate tool definitions and policy bundles by digest. Pin the runtime,
   WASM module, local models, and policy version in deployment attestations.
5. Send sanitized audit records to append-only storage outside the execution
   identity's write authority, with retention and access policy.
6. Enforce process-level memory, CPU, wall-clock, output, and network limits in
   addition to the library's cooperative budgets.
7. Operate an incident response path for policy denial spikes, integrity failures,
   sandbox escapes, and suspected disclosure.

## Deployment acceptance checklist

Before exposing a deployment to hostile instructions, its owner MUST document and
test all of the following:

- the exact runtime, WASM artifact, tool definitions, policy bundle, and integrity
  profile are pinned and authenticated;
- the host and effectful tools run in separately constrained OS identities;
- every effectful tool honors cancellation or is terminated by its process boundary;
- receipt authenticity is provided by a managed signing or MAC key;
- audit output is sanitized and written outside the execution identity;
- resource limits are enforced by both the library and the operating environment;
- recovery, rollback, key rotation, and incident-response procedures are exercised;
  and
- `pnpm check`, `pnpm test:security`, and a production dependency audit pass for
  the exact release artifact.

## Release gates

The project must not claim production readiness until all of these are complete:

- the remaining open protocol semantics in `spec.md` and `TOOLRING.md` are resolved and versioned;
- normative schemas cover capsules, guards, Toolring, events, and receipts;
- cross-implementation conformance vectors pass;
- fuzzing covers parsers, normalization, expressions, receipt decoding, and Lua;
- an adversarial security review and an independent penetration test are complete;
- a supported isolated deployment profile and key-management profile exist; and
- compatibility, vulnerability response, and security-update policies are published.

Security reports should avoid public disclosure until a private reporting channel
and response policy are published.
