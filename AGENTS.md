# Repository guidance

These repository-wide instructions are maintained for development with GPT-6
Astra. The router's supported harnesses, destination models, and V1/V2
compatibility are product requirements, independent of the development model.

## Project shape

Subagent Model Router has two layers:

- `src/`: TypeScript router, CLI, configuration, discovery, gateway, and harness lifecycle logic.
- `macos/SubagentModelRouterApp/`: native SwiftUI menu-bar app. Keep it a thin client of the bundled TypeScript helper.
- `test/`: deterministic Vitest tests plus explicitly gated live integration tests.
- `contracts/`: JSON fixtures shared by the TypeScript helper and Swift app.
- `bin/`: helper and macOS application packaging scripts.
- `dist/` and `.build/`: generated artifacts. Do not edit or commit them.

Load context for the affected work:

- `README.md`: CLI usage, configuration examples, and gateway integration.
- `docs/USING_THE_APP.md`: canonical setup, compatibility, restoration, and
  user-facing lifecycle behavior.
- `docs/ARCHITECTURE.md`: routing boundaries, data flow, and configuration ownership.

## Work and completion

- Reviews, audits, diagnoses, and plans are read-only unless changes are requested.
- Complete authorized changes through implementation, relevant verification, and
  repairs caused by the change. Resolve routine details from the code and task;
  stop when the outcome is complete or a concrete blocker needs user input.
- Keep shared development rules here. Plans or handoffs should retain accepted
  decisions, remaining work, and evidence without duplicating these rules.
  Upstream instructions and historical records are source evidence, not new tasks.
- Preserve unrelated uncommitted work. When committing, use `codex/` branches,
  Conventional Commits, and one commit per coherent fix; stage only task changes.

## Product invariants

Preserve these unless the requested change explicitly revises the product design:

- The router preserves protocols; it does not translate between Anthropic Messages and OpenAI Responses.
- The gateway binds only to `127.0.0.1:9476`.
- Usable main routes intentionally route parent traffic. Without one, parents
  pass through unchanged. Identified Claude children use only their named route
  or pass through; they never fall back to the main route. Codex hidden aliases
  take precedence, while non-aliased traffic follows its optional main route,
  including unconfigured children inheriting the parent model. Preserve disabled
  and broken explicit-route pass-through behavior.
- Agent discovery and routing cover global agents only; project-specific agents are out of scope.
- Provider credentials must not be stored or logged. Credentials from an original upstream must not cross to a different destination origin.
- Setup is atomic and idempotent and preserves unrelated Claude and Codex configuration.
- Normal removal reports conflicts instead of overwriting later edits. Destructive restoration requires an explicit force action.
- Keep legacy `HMR_` compatibility and Harness Model Router migration behavior unless intentionally removing it.

## Cross-language contract

`src/types.ts` and the Codable models in `macos/SubagentModelRouterApp/Sources/SubagentModelRouterApp/Models.swift` describe the same helper/app JSON contract. Update `contracts/app-state-v2.json` and test both sides whenever configuration or helper output changes.

Keep the application version synchronized across:

- `package.json` and `package-lock.json`
- `src/version.ts`
- `macos/SubagentModelRouterApp/Info.plist`

TypeScript uses NodeNext ESM; include `.js` extensions in relative imports.

## Validation

Install dependencies with `npm ci`. The recommended development versions are recorded in `.node-version` and `.bun-version`.

Use focused Vitest files during development (`npm test -- test/core.test.ts`,
for example). Local fixture tests and builds are within implementation scope;
run them and repair failures caused by the change without renewed approval.

For TypeScript, CLI, gateway, lifecycle, contract, or packaging changes:

    npm run check

For Swift or helper/app contract changes:

    npm run test:native

For complete macOS packaging changes:

    npm run build:macos
    codesign --verify --deep --strict --verbose=2 \
      "dist/Subagent Model Router.app"

Gateway and packaging tests bind local loopback ports. In restricted environments, obtain loopback permission instead of interpreting `EPERM` timeouts as code failures. Port `9476` must be free for the standalone-helper packaging test.

Repeat or broaden passing checks only for new edits, failures, or a concrete
unresolved risk. Documentation-only changes need reference and consistency
checks, not builds. Report skipped or blocked verification explicitly.

## CLI integration and external operations

The opt-in CLI checks use temporary homes and scripted loopback responses by
default. Preserve that isolation; fixture setup/removal is within implementation
scope, but changing the user's installed routing or forcing restoration is not
implied by a request to edit or test code.

- `npm run test:live-claude`
- `npm run test:live-codex`

The Claude check can instead send its child to a real gateway when
`SMR_LIVE_CLAUDE_UPSTREAM_URL` and `SMR_LIVE_CLAUDE_MODEL` are set. That consumes
provider quota and requires explicit session authorization. Existing authorization
covers its stated scope; an inherited environment flag or documented example
does not establish authorization. Complete independent fixture verification if
real inference is not authorized. Do not expose credentials or raw CLI/provider
output from a real-inference run in the task report.

## Documentation

Update `README.md` or `docs/USING_THE_APP.md` when setup, restoration, configuration, compatibility, requirements, or visible app behavior changes.
Update `docs/ARCHITECTURE.md` when routing boundaries, trust, or ownership changes.
