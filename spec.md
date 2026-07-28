# Instruct Protocol Specification

Status: early draft. This document defines the intended protocol and is not yet a
claim of conformance by the reference implementation.

Instruct is a family of protocols for allowing capable models to affect sensitive
environments without unnecessarily exposing those environments to the model.
It hosts or composes multiple protocols with different scopes:

- **Instruct Core** defines the model-facing protocol, including lenient
  interpretation, the security boundary, authorization, guarded values,
  disclosure, execution lifecycle, and receipts.
- **Toolring** is a strict, independently usable tool-orchestration protocol for
  expressing a complete multi-step operation.
- **Instruct Lua** is a separate programmatic protocol and API for running
  model-supplied Lua in a constrained environment.

Toolring and Instruct Lua can each be used by Instruct, but neither is the syntax of
the other. Toolring is not a lenient model language, and Lua programs are not
Toolring programs. A Toolring host does not have to implement Instruct. When
Toolring or Lua is used inside Instruct, Instruct adds interpretation, policy,
guarding, and disclosure requirements around that execution.

### Protocol relationships

```mermaid
flowchart LR
    P["Strict program producer"] --> TP["Toolring program"]
    TP --> TE["Toolring executor"]

    M["Model"] --> IC["Instruct Core"]
    IC --> IN["Lenient instruction interpreter"]
    IN -->|"compiles to strict form"| TP
    IC --> LP["Instruct Lua program"]
    LP --> LR["Constrained Lua runtime"]

    TE --> TA["Host tool API"]
    LR -->|"direct programmatic calls"| TA

    IC -.->|"policy, guarded values, budgets, disclosure"| TE
    IC -.->|"policy, guarded values, budgets, disclosure"| LR
```

Toolring remains usable along the top path without Instruct. The lower paths show
how Instruct can use Toolring or Lua while keeping their languages and execution
semantics distinct.

## 1. Conventions and terminology

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to
be interpreted as normative requirements.

- **Model**: the untrusted producer of an instruction.
- **Host**: the trusted software responsible for validation, authorization, and
  execution.
- **Environment**: the tools, data, and sandboxes available to a host.
- **Instruction capsule**: the envelope submitted for execution.
- **Instruction proposal**: a lenient, Instruct-specific model reply that is not
  directly executable.
- **Toolring program**: a strict, validated orchestration graph.
- **Tool**: a host-provided operation with declared inputs, outputs, authority,
  and effects.
- **Capability**: named authority to invoke an operation or class of operations.
- **Effect**: a possible externally observable state change.
- **Grant**: the maximum authority and resource budget available to a run.
- **Guarded value**: a value or local handle accompanied by security metadata.
- **Handle**: an opaque reference to data retained by a trusted environment.
- **Remote**: any destination outside the trusted execution boundary, including
  the model.

## 2. Instruct Core

### 2.1 Goals

Instruct enables a model to request useful work over sensitive data while reducing:

- disclosure of raw and derived sensitive values;
- repeated model/tool round trips;
- accidental authority expansion during interpretation;
- leakage through results, logs, errors, and model context; and
- ambiguity about intended and observed side effects.

Instruct does not assume that model output is correct or benign. Model-generated
instruction proposals, Toolring programs, and Lua programs are hostile input.

### 2.2 Strict execution, lenient interpretation

Instruct exists partly to bridge the mismatch between capable but imperfect model
output and strict execution protocols.

Toolring itself is strict. Instruct MAY accept a more lenient instruction proposal
and interpret, repair, or complete it before producing a Toolring program. This
leniency belongs to Instruct, not Toolring. The resulting Toolring program MUST
satisfy Toolring exactly before it can be executed.

Instruct's interpretation MAY compensate for harmless model-facing variation such
as tool aliases, alternate argument names, omitted defaults, or locally resolvable
references. It MUST NOT guess through security-relevant ambiguity, change material
intent, or expand capabilities, effects, destinations, or budgets.

The host SHOULD record material interpretation decisions and SHOULD make the
resolved strict program available for inspection or audit. Failure to produce one
unambiguous, authorized program MUST result in clarification or denial, not partial
or speculative execution.

#### Tool-call instruction lifecycle

```mermaid
sequenceDiagram
    participant M as Model
    participant I as Instruct Core
    participant R as Interpreter
    participant P as Policy engine
    participant T as Toolring executor
    participant H as Host tools

    M->>I: Lenient tool-call instruction proposal
    I->>R: Interpret within declared intent and authority
    R-->>I: Strict Toolring program plus decisions
    I->>T: Validate strict Toolring program
    T-->>I: Valid program and required operations
    I->>P: Authorize capabilities, effects, and disclosure
    alt Denied or unresolved
        P-->>I: Denial
        I-->>M: Sanitized denial or clarification request
    else Authorized
        P-->>I: Bounded grant
        I->>T: Execute with guarded inputs and limits
        loop Toolring control flow
            T->>H: Validated tool invocation
            H-->>T: Result or stable failure
        end
        T-->>I: Local result and execution record
        I-->>M: Remote-safe result and receipt
    end
```

### 2.3 Trust boundary

The host and its policy engine are authoritative. A model, instruction interpreter,
intent resolver, tool, or sandbox MUST NOT grant itself authority.

Before execution, the host MUST:

1. validate the instruction envelope;
2. resolve it to a strict executable representation, if resolution is needed;
3. determine its required capabilities and possible effects;
4. compare those requirements with both its declarations and the active grant;
5. reject the instruction if required authority is undeclared or ungranted; and
6. establish finite resource and disclosure budgets.

The host MUST apply disclosure policy to every value leaving the trusted boundary,
including ordinary results, partial results, events, logs, standard output,
standard error, exception messages, traces, and receipts.

### 2.4 Instruction capsule

An instruction capsule identifies one requested run. It contains at least:

- a protocol version and instruction identifier;
- an instruction kind and human-readable intent;
- declared capabilities and effects;
- a disclosure budget;
- guarded inputs; and
- either an Instruct tool-call proposal, a strict Toolring program, or a program
  for a separately specified programmatic API such as Instruct Lua.

The intent is descriptive. It does not grant authority and MUST NOT override the
machine-readable declarations or host policy.

Unknown protocol versions MUST be rejected unless an explicit compatible-version
rule applies. A host SHOULD preserve or compute a stable digest of the received
capsule before interpretation. If an instruction proposal is compiled to Toolring,
the host SHOULD also digest the resolved Toolring program.

### 2.5 Authorization

Authorization is an intersection, never a union:

```text
effective authority = required authority
                    ∩ declared authority
                    ∩ granted authority
                    ∩ host policy
```

Every operation MUST be permitted by all applicable layers. Missing permission at
any layer is a denial.

A capability names permission to perform an operation. An effect describes a
possible state change, independently of the capability used to produce it. Hosts
MUST authorize both capabilities and effects.

Effects SHOULD state their type, affected resource or resource class, and whether
they are reversible. A broader grant MAY authorize a narrower effect, but a narrow
grant MUST NOT authorize a broader one.

Instruct interpretation MAY repair names, argument shape, or other presentation
ambiguities. It MUST NOT add a capability, effect, disclosure destination, or
resource budget that was not declared and granted.

### 2.6 Guarded values

Every sensitive runtime value MUST be represented as a guarded value. A guard
describes at least:

- sensitivity;
- disclosure labels;
- provenance and contributing source handles;
- transformation history;
- permitted operations and destinations;
- scope and optional expiry; and
- correlation policy.

A guarded value can contain a local value, an opaque handle, or both. Possession of
a handle is not authority to resolve it. A host MUST validate handle scope, expiry,
and applicable policy on every resolution.

#### 2.6.1 Derivation

A value derived from guarded inputs MUST remain guarded. Unless a trusted transform
provides a stronger, explicit guarantee, the derived guard MUST be at least as
restrictive as every contributing guard.

For ordinary composition:

- sensitivity is the highest input sensitivity;
- permitted destinations and operations are their intersections;
- provenance, source handles, labels, and transformation records are preserved;
- expiry is no later than the earliest input expiry; and
- correlation MUST NOT become more persistent.

Merely formatting, summarizing, aggregating, templating, encrypting, encoding, or
passing a value through a model does not declassify it. Declassification MUST be an
explicit trusted operation with recorded guarantees and policy authorization.

#### 2.6.2 Remote representation

When a value crosses the trusted boundary, the host MUST choose a policy-approved
representation such as:

- the value itself;
- an opaque handle;
- a scoped pseudonym;
- a non-sensitive summary; or
- a withheld marker.

Raw values MUST NOT be disclosed unless their guard, active grant, disclosure
budget, and destination policy all permit it. If safe representation is impossible,
the host MUST withhold the value rather than fail open.

### 2.7 Contextual handles and tools

Models often need enough context to reason about sensitive data without receiving
the data itself. A host SHOULD provide opaque handles together with bounded,
non-sensitive descriptions of their type, role, provenance, and permitted uses.

Hosts SHOULD expose contextual tools that operate on these handles locally. Such a
tool MUST enforce the same authorization and guard rules as a tool operating on a
raw value.

### 2.8 Resource budgets

Every run MUST have finite limits appropriate to its execution mechanisms. Limits
may include elapsed time, instruction count, memory, output bytes, tool calls,
iteration count, nesting depth, and remote disclosure bytes.

A child execution MUST NOT receive a budget or authority greater than its parent.
Budget exhaustion MUST terminate or safely divert the affected operation and MUST
NOT cause sensitive diagnostic data to cross the trust boundary.

### 2.9 Events and receipts

A host SHOULD emit ordered operational events sufficient to audit normalization,
authorization, execution, recovery, effects, failure, and completion. Event payloads
MUST contain allowlisted operational metadata only; they are part of the disclosure
surface.

A completion receipt SHOULD contain:

- protocol version and status;
- a digest of the original instruction;
- a digest of the resolved Toolring or Lua program, when one exists;
- sanitized ordered events and aggregate metrics;
- observed effects;
- the remote-safe result; and
- integrity and optional chaining information.

Receipt integrity MUST cover every field whose alteration would change the meaning
of the receipt. Hashing requires a specified canonical serialization; ordinary
runtime object serialization is not sufficient for interoperable receipts.

An implementation MUST distinguish at least:

- **denied**: validation or authorization prevented execution;
- **failed**: execution began but did not complete successfully; and
- **completed**: the requested execution reached a terminal result.

A completed status does not imply that the result is remotely disclosable.

## 3. Toolring Protocol

### 3.1 Purpose

Toolring is a DSL for advanced tool calling. It lets a producer, including a model,
describe a complete high-level operation containing multiple tool calls and
control-flow decisions,
instead of requiring the repeated sequence:

```text
model response -> tool call -> model response -> tool call -> ...
```

Reducing round trips preserves execution continuity and reduces the number of times
sensitive context must be exposed to a model. Toolring supports sequencing, nested
execution, branching, bounded iteration, parallel branches, retries, fallback,
recovery, and compensation.

Toolring is deliberately strict. A Toolring executor accepts a valid Toolring
program or rejects it. It does not repair tool names, infer missing control flow,
reinterpret malformed arguments, or guess what its producer meant.

This strictness makes Toolring portable, independently testable, and useful to
producers other than models. An Instruct host MAY place a lenient interpretation
layer in front of Toolring, but that layer is not part of Toolring.

### 3.2 Representation and validation

A Toolring program has one normative, strict representation. A conforming executor
MUST validate that representation before execution and MUST reject invalid input.

Other systems MAY compile their own languages or proposals into Toolring. Instruct,
for example, can compile a lenient model-facing instruction proposal into a strict
Toolring program. Such source languages, compilers, repairs, and interpretation
decisions belong to those systems and are outside the Toolring protocol.

Two Toolring programs that are to be compared or hashed require a specified
canonical encoding. Canonical encoding does not make an invalid program valid and
does not perform intent resolution.

### 3.3 Program graph

A Toolring program contains:

- a Toolring version;
- one entry node;
- a map of unique node identifiers to nodes; and
- any strict execution limits required by the program.

A host or integration profile MAY attach authority and effect declarations. They
are not interpreted as security grants by Toolring itself.

Every control-flow target MUST name an existing node. Every node reachable through
normal flow, branches, loop bodies, recovery, or compensation is part of static
analysis. Unreachable nodes SHOULD produce a diagnostic and MAY be rejected by a
strict host.

The initial environment contains the program's inputs. Nodes MAY bind
outputs to names. Reading an unknown binding MUST fail before the consuming
operation is invoked.

### 3.4 Value expressions

A value expression is one of:

- a literal value;
- a reference to a named value; or
- a template or other explicitly defined transform over values.

Toolring preserves values according to its value model but does not define
sensitivity or disclosure policy. An integration such as Instruct MAY associate
opaque security metadata with values and define propagation rules for expressions.

Evaluation of expressions MUST be side-effect-free.

### 3.5 Node semantics

#### 3.5.1 Tool node

A tool node names a tool, provides argument expressions, optionally binds its
result, and selects a successor.

Before invocation, the host MUST:

1. resolve and evaluate every argument;
2. validate the tool's input contract; and
3. charge the applicable Toolring execution limits.

The tool result is bound before execution proceeds. Toolring does not itself decide
whether a caller is authorized to invoke a tool; that is the responsibility of the
host or an integration protocol such as Instruct.

#### 3.5.2 Condition node

A condition node evaluates a side-effect-free predicate and selects exactly one of
two targets.

The core comparison set includes equality, inequality, existence, truthiness, and
ordered comparison. Profiles MAY add operators only with explicit semantics.

#### 3.5.3 Loop node

A loop node evaluates a finite collection, binds each item, executes its body, and
then continues to an `after` target. Every loop MUST declare a positive maximum
iteration count. Execution MUST fail or follow a configured recovery
path if the collection exceeds that bound.

#### 3.5.4 Parallel node and join

A parallel node starts two or more logical branches and names a join point. A host
MAY schedule branches concurrently or deterministically in sequence; observable
semantics MUST NOT depend on scheduling unless the profile explicitly permits it.

Branches MUST NOT create conflicting bindings at the join. Conflicting writes MUST
be rejected statically when detectable and otherwise fail at runtime. Hosts MUST
reject unsafe combinations of irreversible effects whose ordering or duplication
could change the outcome.

A join continues only after every required branch completes successfully or its
failure has been handled.

#### 3.5.5 Terminal node

A terminal node evaluates named result expressions and ends its current execution
path. Toolring returns the resulting values without defining their disclosure
policy. An Instruct host independently derives their guarded and remote-safe
representations.

### 3.6 Failure handling

Toolring distinguishes an **attempt failure** from an unhandled **path failure**.
Operations MUST expose stable error codes suitable for programmatic control. A
security integration such as Instruct is responsible for sanitizing error details
before disclosure.

An action MAY define a failure policy containing:

- **retry**: repeat the same action up to a finite total attempt count;
- **fallback**: try a different operation intended to produce a compatible result;
- **recover**: transfer control to a named recovery path;
- **compensate**: attempt to mitigate effects already produced; and
- **propagate**: fail the enclosing path.

Retries MUST be bounded. Each attempt consumes budgets and MAY produce effects.
Hosts SHOULD restrict retries of non-idempotent or irreversible operations unless
the tool declares an idempotency mechanism or safe retry contract.

Fallback and recovery are not synonyms. A fallback substitutes another means of
performing the failed operation. Recovery handles the failure and may return a
degraded result, skip work, or terminate deliberately.

Compensation is not rollback. It is a separate effectful operation that MAY fail.
A Toolring executor MUST preserve the outcome of both the original operation and
the compensation attempt. An integration MAY additionally require separate
authorization. Compensation MUST NOT erase evidence that an effect occurred.

If all configured handling is exhausted, failure propagates to the enclosing path.
An unhandled failure at the root produces a failed run.

#### Toolring action and failure flow

```mermaid
flowchart TD
    E["Enter action node"] --> V["Evaluate and validate arguments"]
    V --> A["Invoke tool"]
    A -->|"success"| B["Bind result"]
    B --> N["Continue to next node"]

    A -->|"attempt failure"| C{"Attempts remaining?"}
    C -->|"yes"| A
    C -->|"no"| F{"Failure policy"}
    F -->|"fallback"| FB["Invoke compatible substitute"]
    F -->|"recover"| RP["Transfer to recovery path"]
    F -->|"compensate"| CP["Attempt compensating operation"]
    F -->|"propagate"| PF["Fail enclosing path"]

    FB -->|"success"| B
    FB -->|"failure"| PF
    CP -->|"then recover"| RP
    CP -->|"then propagate"| PF
```

Retry repeats the same action. Fallback substitutes another action, recovery moves
control to another path, and compensation attempts to mitigate an already produced
effect; none of these terms are interchangeable.

### 3.7 Nesting

A node or tool MAY invoke a child Toolring program only when the host explicitly
supports nested execution. Nesting increments call depth and receives a portion of
the parent's remaining execution limits.

The parent MUST define how child outputs are bound and how child failures propagate.
Cycles caused by nesting are permitted only under an independently enforced finite
depth and execution budget.

### 3.8 Cancellation and termination

The host MAY cancel a run because of caller cancellation, policy change, budget
exhaustion, shutdown, or safety enforcement. Tools and child executions SHOULD
receive cancellation signals and SHOULD stop promptly.

Cancellation does not imply rollback. The host MUST preserve observed effects and
MAY invoke explicitly declared compensation when policy and remaining budget allow.

A Toolring program terminates when its root path reaches a terminal node, suffers
an unhandled failure, or is cancelled. Invalid Toolring input is rejected before
execution. Authorization denial, when applicable, belongs to the integrating host.
Infinite implicit waiting is not valid execution behavior.

### 3.9 Static analysis

Before execution, a conforming Toolring host MUST reject a program with:

- a missing entry or control-flow target;
- duplicate node identifiers;
- an unknown node kind or tool;
- an unbounded loop, retry policy, or recursive expansion;
- an invalid nested program; or
- a statically evident unsafe parallel effect conflict.

Hosts SHOULD also diagnose unreachable nodes, incompatible fallback results,
references that cannot be bound on every incoming path, and compensation that is
not valid for the corresponding tool or effect.

### 3.10 Host extensions

Extensions MUST be namespaced and versioned. A host MUST reject an unknown extension
that affects execution or security semantics. It MAY ignore unknown purely
descriptive metadata.

An extension MUST NOT weaken Instruct requirements when executed inside an Instruct
host.

### 3.11 Instruct integration

When Instruct executes a Toolring program, Instruct supplies responsibilities that
Toolring deliberately does not define:

- lenient interpretation of the model's instruction proposal;
- resolution of tool aliases, arguments, defaults, and contextual handles;
- capability, effect, destination, and policy authorization;
- guarded-value propagation and disclosure control;
- child-authority and budget restriction;
- sanitization of events, errors, and results; and
- receipts and security auditing.

These checks occur before and around strict Toolring validation and execution. They
do not relax Toolring's syntax or execution semantics. Interpretation succeeds only
when it produces a valid Toolring program.

## 4. Instruct Lua Programmatic Protocol

Instruct Lua is a separate way to express advanced operations. It is not Toolring
syntax, a serialization of a Toolring graph, or a Toolring execution profile.

The distinction is structural:

- a Toolring program describes orchestration using Toolring nodes and edges;
- a Lua program describes computation and control flow using Lua; and
- Instruct can interpret and secure either form using the same tools, grants,
  guarded values, budgets, and disclosure policy.

```mermaid
flowchart TB
    subgraph TR["Toolring execution"]
        TG["Strict node graph"] --> TC["Toolring control flow"]
        TC --> TI["Tool node invocation"]
    end

    subgraph LU["Instruct Lua execution"]
        LS["Lua source"] --> LC["Lua language control flow"]
        LC --> LA["Programmatic tool API call"]
    end

    TI --> HT["Same host tool registry"]
    LA --> HT
    IP["Instruct policy and guarded-value layer"] -.->|"applies around"| TR
    IP -.->|"applies around"| LU
```

An implementation MAY translate between representations as a private optimization,
but conformance and observable semantics remain those of the protocol originally
submitted. Such translation MUST NOT make Toolring or Lua features implicitly part
of the other protocol.

### 4.1 Programmatic API

The Lua environment exposes a small, capability-mediated API for reading explicit
inputs, invoking host tools, and returning a result. Tool invocation from Lua is a
programmatic API call. It is not a nested Toolring node or Toolring program.

The API specification MUST define:

- the program entry point and input context;
- conversion between guarded host values and Lua values;
- tool lookup, argument passing, and result conversion;
- synchronous or asynchronous call behavior;
- stable failure values or error codes;
- cancellation and resource accounting; and
- propagation of guards through Lua operations and tool results.

Calls through the Lua API remain subject to Instruct authorization. The program
MUST NOT obtain a capability, tool, value, destination, or budget merely by naming
or constructing it in Lua.

### 4.2 Sandbox boundary

The Lua runtime MUST NOT expose filesystem, network, process, package loading,
clocks, randomness, environment variables, native modules, debug facilities, or
other ambient authority unless each facility is explicitly granted and mediated by
the Instruct host.

Only capsule inputs and explicitly exposed APIs are available to the program. A
child tool call receives no more authority or remaining budget than the Lua run.

Standard output, standard error, exceptions, traces, and API errors are disclosure
surfaces. Sensitive values in them MUST be replaced with safe handles or withheld
markers before leaving the trusted boundary.

### 4.3 Language-level control flow

Lua conditionals, loops, functions, and error handling belong to Lua execution,
not Toolring. Their limits are enforced by the Lua sandbox's instruction, memory,
time, call-depth, output, and tool-call budgets.

Toolring retry, recovery, compensation, parallel, and join semantics do not apply
to Lua code unless the Lua API defines an explicit, separately named equivalent.
Ordinary Lua exception handling MUST NOT be described as Toolring recovery.

## 5. Conformance and open issues

Conformance is assessed separately for:

- Instruct Core hosts;
- Instruct instruction interpreters;
- Toolring executors;
- tools; and
- Instruct Lua runtimes and APIs.

Conformance tests SHOULD include both accepted examples and required rejections.
Security invariants MUST be tested across success, failure, retry, recovery,
compensation, cancellation, and budget exhaustion.

The following matters remain intentionally unsettled in this draft:

- canonical wire encoding and digest algorithm;
- a complete schema for capsules, guards, Toolring programs, events, and receipts;
- lexical rules for names, capabilities, effects, and extensions;
- precise scope and correlation semantics for handles and pseudonyms;
- fallback syntax and result compatibility;
- transaction and idempotency contracts for tools;
- parallel scheduling and merge rules;
- recovery behavior for Toolring condition, loop, and parallel nodes;
- the exact Instruct Lua API and guarded-value conversion rules;
- receipt chaining and signature profiles; and
- negotiation of compatible protocol and extension versions.

These issues MUST be resolved before a stable 1.0 specification.
