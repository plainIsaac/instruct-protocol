# Reference production profile

This profile turns the reference library's production-facing controls on. It does
not grant an operating system sandbox to the host process. The deployer must still
apply the controls in `SECURITY.md` to the actual identities and infrastructure.

## Admission requirements

A run using `options.production` fails closed unless it has:

- a receipt signer with a non-empty profile and key identifier;
- a security audit observer; and
- process isolation for every effectful Toolring tool.

Read-only tools may remain in-process because they cannot produce declared effects.
Deployments may impose a stricter rule and isolate those tools as well.

```ts
const result = await run(capsule, {
  grant,
  tools,
  production: {
    receiptSigner,
    auditObserver,
  },
});
```

## Receipt authentication

`ReceiptSigner` and `ReceiptSignatureVerifier` allow deployment-managed signing,
verification, key rotation, and algorithm profiles. `Ed25519ReceiptSigner` is the
reference profile. It accepts an existing Node `KeyObject`; it deliberately does
not read a key from disk or an environment variable. Production code should obtain
that key through its platform keystore or HSM adapter.

`verifyReceipt()` verifies deterministic receipt content. It does not authenticate
the producer. Use `verifyReceiptSignature()` for authenticity.

## Process-isolated tools

`processTool()` starts one child process per invocation with `shell: false`, an
explicit environment, bounded stdout/stderr, and forced termination on cancellation
or deadline. Requests and guarded responses use JSON over standard input/output.

The child receives:

```json
{ "arguments": { "name": { "kind": "guarded" } }, "simulate": false }
```

It must write exactly one guarded-value JSON document to stdout. Diagnostic stderr
is never copied into protocol events or receipts.

Use an absolute, pinned executable path. Run it under a separately constrained OS
identity or container. The adapter can terminate a process, but it cannot itself
define filesystem, network, device, or child-process policy.

## Audit and incident signals

`SecurityAuditObserver` writes sanitized events and raises alerts for denial and
failure events. Its `LogWriter` and `AlertSink` should target append-only storage
and an incident-management system outside the execution identity.

Before release, exercise receipt-key rotation, audit-sink failure, process-tool
timeout, irreversible-effect recovery, and suspected-disclosure procedures. Run:

```sh
pnpm check
pnpm test:security
pnpm audit --prod
```
