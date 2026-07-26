# Repository guidance

## Project shape

Subagent Model Router has two layers:

- `src/`: TypeScript router, CLI, configuration, discovery, gateway, and harness lifecycle logic.
- `macos/SubagentModelRouterApp/`: native SwiftUI menu-bar app. Keep it a thin client of the bundled TypeScript helper.
- `test/`: deterministic Vitest tests plus explicitly gated live integration tests.
- `contracts/`: JSON fixtures shared by the TypeScript helper and Swift app.
- `bin/`: helper and macOS application packaging scripts.
- `dist/` and `.build/`: generated artifacts. Do not edit or commit them.

Read `README.md` for product behavior, `docs/USING_THE_APP.md` for user-facing lifecycle behavior, and `docs/ARCHITECTURE.md` for internal boundaries and data flow.

## Product invariants

Preserve these unless the requested change explicitly revises the product design:

- The router preserves protocols; it does not translate between Anthropic Messages and OpenAI Responses.
- The gateway binds only to `127.0.0.1:9476`.
- Parent requests and unknown, disabled, or broken routes pass through unchanged.
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

For TypeScript, CLI, gateway, lifecycle, contract, or packaging changes:

    npm run check

For Swift or helper/app contract changes:

    npm run test:native

For complete macOS packaging changes:

    npm run build:macos
    codesign --verify --deep --strict --verbose=2 \
      "dist/Subagent Model Router.app"

Gateway and packaging tests bind local loopback ports. In restricted environments, obtain loopback permission instead of interpreting `EPERM` timeouts as code failures. Port `9476` must be free for the standalone-helper packaging test.

Live tests are opt-in. Run them only when the relevant CLI or local gateway is available, and preserve their temporary-home isolation:

- `npm run test:live-claude`
- `npm run test:live-codex`
- `npm run test:gateway`

Update `README.md` or `docs/USING_THE_APP.md` when setup, restoration, configuration, compatibility, requirements, or visible app behavior changes.
