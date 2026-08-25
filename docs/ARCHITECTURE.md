# Architecture

Subagent Model Router is a native macOS controller around a protocol-preserving TypeScript gateway. The Swift app owns presentation and helper-process lifecycle; the helper owns routing, configuration validation, harness integration, and restoration.

## Components

| Area | Responsibility |
| --- | --- |
| `src/gateway.ts` | Loopback HTTP server, request decoding, forwarding, streaming, and readiness |
| `src/routing.ts`, `src/adapters.ts` | Route decisions and protocol-specific model replacement |
| `src/config.ts`, `src/types.ts` | Versioned configuration schema, migration, validation, and persistence |
| `src/lifecycle.ts` | High-level setup, removal, reset, and migration orchestration |
| `src/lifecycle-*.ts` | JSON hook mutation, Codex configuration, and install-state helpers |
| `src/discovery.ts`, `src/catalog.ts` | Global agent discovery and Codex model-catalog overlays |
| `src/cli.ts` | Command-line and Swift-helper JSON interface |
| `macos/SubagentModelRouterApp` | Menu-bar UI, helper installation, process ownership, and config watching |

The helper/app JSON boundary is represented by `contracts/app-state-v2.json`. TypeScript validates its configuration and Swift decodes the same fixture.

## Request flow

### Claude Code

1. Global `SubagentStart` and `SubagentStop` hooks register and remove `(session, agent ID) → agent type` mappings.
2. Claude sends Anthropic Messages traffic to `127.0.0.1:9476/claude`.
3. Requests without a mapped child identity use the enabled, usable Claude main route; otherwise they pass through unchanged.
4. Identified children use only their matching subagent route. Unknown, disabled, or broken child routes pass through and never fall back to the main route.
5. Enabled routes replace only the wire model and upstream destination.

### Codex

1. Dynamic stock, manual, and no-model custom agents use Codex V1; a global `PreToolUse` hook assigns their hidden model alias from readable agent metadata.
2. Codex-loadable explicit-model global custom agents use Codex V2; setup normalizes their model to the hidden alias and records the original value for restoration.
3. A generated model-catalog overlay advertises aliases and V1 metadata only for dynamic routes and their configured parent models.
4. Codex sends OpenAI Responses traffic to the local provider.
5. The gateway resolves hidden subagent aliases first, restores their configured wire model, and forwards to their selected destination.
6. A request whose model is not a hidden subagent alias uses the enabled, usable Codex main route; otherwise it retains its requested model and original upstream. This includes unconfigured subagents that inherit the parent model: the Responses request has no reliable child identity, so the gateway cannot distinguish that traffic from the parent without an alias.

The gateway never translates between the two protocols. Main routes are stored in the first-class `mainRoutes.claude` and `mainRoutes.codex` configuration fields; they do not participate in agent discovery, Codex alias catalogs, custom-agent normalization, or restoration metadata.

## Configuration lifecycle

Setup mutates only router-owned values:

- Claude settings: `ANTHROPIC_BASE_URL` and two lifecycle hooks.
- Codex hooks: one `PreToolUse` command.
- Codex TOML: two top-level scalars and a marked provider block.
- Explicit global Codex agent models: normalized only when required, with exact restoration metadata.

Writes are atomic. Install state records original values, installed values, and content hashes. Normal removal stops on later edits; force removal is the explicit destructive path. First-time desktop setup snapshots all affected files so a partial failure can be rolled back.

## Security boundaries

- The listener is fixed to loopback and a fixed port.
- URLs cannot contain inline credentials or credential-like query parameters.
- Stored authorization contains environment-variable references, never secret values.
- Main and subagent routes share the same origin-aware header filtering and environment-backed destination authorization path.
- Logs pass through recursive credential redaction.
- Headers declared by the original Codex provider in `http_headers` or `env_http_headers` are preserved only when the target has the same origin. Cross-origin routes receive only explicitly configured environment-backed authorization.
- The local hook and readiness endpoints are unauthenticated. The trust boundary is the current macOS user account and its global Claude/Codex configuration.

## Generated artifacts and releases

`dist/` and `.build/` are disposable build output. The standalone helper is compiled by Bun and bundled with the Swift executable into an ad-hoc-signed application.

`npm run check:versions` enforces the shared release version in the npm manifests, TypeScript runtime, and application plist. `npm run check` covers deterministic TypeScript and helper checks; native tests and full application packaging remain separate commands.
