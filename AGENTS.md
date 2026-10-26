# Instruct Protocol Guide

This guide applies to this repository. Follow any applicable higher-level
`AGENTS.md` as well; this file does not depend on a parent guide being present.

## Scope and product authority

- Read `README.md`, `spec.md`, `SECURITY.md`, `TOOLRING.md`, `PRODUCTION.md`, `package.json`, `tsconfig.json`, and `tsconfig.check.json` before changing protocol behavior.
- Preserve human-authored product intent. Derive implementation decisions from it; do not silently narrow the product to match a milestone or the current implementation.
- Keep protocol requirements, proposed decisions, working hypotheses, verified behavior, and unresolved questions distinct. A release plan is a proposal until accepted; a passing test suite is not a production-readiness claim.
- Keep Instruct Core, Instruct Lua, and independently usable Toolring distinct. Update specifications, implementation, examples, and conformance tests together for normative changes.
- Source belongs in `src/`, tests in `test/`, examples in `examples/`, and executable support scripts in `scripts/`.

## Design constraints

- Use idiomatic code, established APIs, and standard formats. Names, structure, documentation, and usage should be intuitive.
- Make common behavior the default, with granular control where needed. Avoid unnecessary API rigidity without weakening authorization, validation, or resource limits.
- Keep files and modules readable; do not over-engineer their structure.
- Develop the product and major features in usable stages, from MVP toward production. Do not accumulate advanced features before the preceding stage is usable.
- Treat the host and policy engine as authoritative. Interpretation must never add undeclared capability, effect, disclosure, or budget.
- Authorization remains an intersection of required, declared, granted, and host-permitted authority. Fail closed on unknown versions, invalid guards, and unsafe disclosure.
- Preserve stable denied/failed/completed distinctions and sanitized, bounded receipts and events. Never expose credentials, guarded data, or raw tool/program error text through logs, diagnostics, or remote output.
- Keep useful, traceable diagnostics available locally without turning them into another disclosure channel.

## Verification and live tests

- Reproduce a defect with a failing regression test before changing behavior. Run the narrowest relevant Vitest target first, then `pnpm check`.
- Run `pnpm test:security` for authorization, guarded-value, disclosure, sandbox, or production-profile changes.
- For packaging or release changes, run `pnpm release:check`, install the packed artifact in a clean consumer, and exercise the affected public API. An import alone does not prove the Lua worker or a process tool works.
- Test features as consumers use them, including failure, cancellation, denial, recovery, and resource exhaustion where relevant. Use live debugging and inspectable state when a test result does not explain the behavior.
- Run performance or live model benchmarks only when relevant and authorized. Keep credentials, private data, and sensitive benchmark payloads out of tracked output.
- Report what was actually exercised, the runtime used, and any checks blocked or not run. Historical test results are not current verification; green local tests are not green CI.

## Source control

- Use semantic/standard commit messages and focused commits. Inspect the worktree before editing and preserve unrelated user or agent work.
- Fetch and inspect upstream before publishing. Integrate changes without overwriting another worktree or force-pushing shared history.
- Commit and push completed, verified work before handing it off; do not stop merely to ask whether to commit. Follow an explicit user instruction to keep work local or uncommitted when given.
- Use a branch and pull request for feature work and substantial fixes. Verify the remote commit, PR, and CI state after publishing. Do not merge without explicit user approval.
- If work cannot be safely committed or pushed, preserve it and report the exact blocker and location. Do not label an uncommitted or unpushed task complete.
- Keep tracked and untracked files organized. Treat `dist/`, dependencies, local stores, benchmark results, builds, logs, caches, smoke-test artifacts, virtual environments, and `.env` as local or generated state; do not commit them. Regenerate build outputs through the documented commands rather than editing them by hand.

## Issues, features, and coordination

- Use the project's external issue tracker (GitHub Issues for GitHub-hosted projects) for issues shared across agents, sessions, or worktrees. Do not use Markdown issue files or repository backlogs for cross-context tracking.
- Track project defects and also agent implementation blockers, tool/integration failures, and understanding gaps. Classify the kind and affected scope; a local agent/tool problem is not automatically a project-wide defect.
- Search for an existing issue before filing; link the affected task/PR and include the evidence, expected behavior, and next action another agent needs. Report suspected vulnerabilities privately using `SECURITY.md`, not in a public issue.
- Local working notes are temporary and untracked. They are not a shared queue or durable handoff; promote an unresolved issue to the tracker before handing off.
- Specs, plans, decisions, and runbooks may remain Markdown. Existing Markdown issue/backlog entries are historical evidence, not an active tracker: move or link unresolved entries to the tracker when working on them, preserving context. Do not silently delete or mark them resolved.
- Reserve shared names, namespaces, or version identifiers in the tracker before changes likely to conflict with concurrent work.
- Keep experimental work isolated and clearly labeled. A branch name or a planning draft does not establish implemented functionality.

## Peer projects and dependencies

- Read a peer project's public product, protocol, and compatibility documents before changing an integration contract. Keep protocol/package versions and compatibility expectations explicit.
- Distinguish this project's defects from dependency or integration failures. File and link the issue in the owning project instead of drifting into unrelated implementation work.
- Temporary workarounds must remain visible and tracked. Propose changes to another product's direction; do not implement them there without authorization.

## Handoff

- Lead with the current implementation and product state, then blockers or decisions needed. Keep the account of individual edits brief.
- Distinguish default-branch behavior, proposed PR changes, and planning-only feature branches. Include the PR and verification status; state clearly what remains unmerged or unverified.
