# Instruct Protocol Guide

This file extends the workspace-level `AGENTS.md` for this repository.

## Scope and references

- Read `README.md`, `spec.md`, `SECURITY.md`, `TOOLRING.md`, `PRODUCTION.md`, `package.json`, and `tsconfig.json` before changing protocol behavior.
- Source belongs in `src/`, tests in `test/`, examples in `examples/`, and executable support scripts in `scripts/`.
- Do not edit generated output in `dist/`, benchmark results, installed dependencies, local stores, or `.env`.

## Protocol constraints

- Treat the host and policy engine as authoritative. Interpretation must never add undeclared capability, effect, disclosure, or budget.
- Authorization remains an intersection of required, declared, granted, and host-permitted authority. Fail closed on unknown versions, invalid guards, and unsafe disclosure.
- Keep Toolring and Instruct Lua semantics distinct. Update the specification, implementation, examples, and conformance tests together for normative changes.
- Preserve stable denial/failure/completion distinctions and sanitized, bounded receipts and events.

## Verification

- Run a focused Vitest target first, then `pnpm check`.
- Use `pnpm test:security` for authorization, guarded-value, disclosure, sandbox, or production-profile changes.
- Run performance or live benchmark scripts only when relevant; never place credentials or sensitive benchmark payloads in tracked output.

## Issues and agent coordination

- Use the project's external issue tracker (GitHub Issues for GitHub-hosted projects) for issues shared across agents, sessions, or worktrees. Do not use Markdown issue files or repository backlogs for cross-context tracking.
- Track project defects and also agent implementation blockers, tool/integration failures, and understanding gaps. Classify the kind and affected scope; a local agent/tool problem is not automatically a project-wide defect.
- Search for an existing issue before filing; link the affected task/PR and include the evidence, expected behavior, and next action another agent needs.
- Local working notes are temporary and untracked. They are not a shared queue or durable handoff; promote an unresolved issue to the tracker before handing off.
