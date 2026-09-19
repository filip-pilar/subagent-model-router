# Subagent Model Router

Route Codex and Claude Code main agents and subagents to different models and
providers from a native Apple Silicon menu-bar app.

For example, keep Claude Code's main agent on its usual model while sending
only its `Explore` subagent to SWE-2 through LLM Local Gateway:

```text
Claude Code main agent ──> original model and provider
           Explore     ──> Subagent Model Router ──> LLM Local Gateway ──> SWE-2
```

Leave the Claude main route unset, add an `Explore` route to
`http://127.0.0.1:4317/claude`, and choose `swe-2-medium`. This requires a
running gateway and a Devin account entitled to SWE-2.
[Complete example and effort limits](#swe-2-through-llm-local-gateway).

Main-agent routing is optional. The router does not translate protocols:
Claude routes need Anthropic Messages; Codex routes need OpenAI Responses.
Codex child identification has additional [compatibility limits](#supported-routing).

## macOS app

Requirements:

- Apple Silicon Mac running macOS 15 or newer
- Claude Code, the Codex CLI, or the Codex desktop app already installed
- A destination that exposes an Anthropic Messages endpoint, an OpenAI Responses endpoint, or both
- For source builds: Node.js 24 and Bun 1.3.14 (the pinned versions are in `.node-version` and `.bun-version`)

Build and open the ad-hoc-signed app:

```sh
git clone https://github.com/filip-pilar/subagent-model-router.git
cd subagent-model-router
npm ci
npm run build:macos
open "dist/Subagent Model Router.app"
```

Then:

1. Add a destination.
2. Add a route for the main agent or a detected or manually entered global subagent type.
3. Test the destination if desired.
4. Click **Set Up Routing** for Claude Code, Codex, or both.

The app never installs Claude Code or Codex. Harness configuration changes only after **Set Up Routing** is clicked, and each harness can be restored independently. See [Using the macOS app](docs/USING_THE_APP.md) for the complete setup, removal, conflict, and troubleshooting guide.

The app owns the gateway on fixed loopback address `127.0.0.1:9476`. Its state and helper live under `~/.local/share/subagent-model-router/`.

## Which repo should I use?

| I want to… | Repo |
| --- | --- |
| Switch ChatGPT accounts behind a stable endpoint for Codex CLI | [codex-account-gateway](https://github.com/filip-pilar/codex-account-gateway) |
| Choose Codex accounts and external models from one experimental Mac app | [codex-switchboard](https://github.com/filip-pilar/codex-switchboard) |
| Expose Devin/Grok CLI access through local OpenAI- and Anthropic-compatible APIs | [llm-local-gateway](https://github.com/filip-pilar/llm-local-gateway) |
| Assign different models to main agents and named subagents in Codex or Claude Code | [subagent-model-router](https://github.com/filip-pilar/subagent-model-router) |

These are separate tools. Switchboard bundles its own gateway; it does not
require the other apps. Subagent Model Router can use LLM Local Gateway as a
destination.

## Supported routing

Main-agent routes are optional and configured independently for Claude Code and Codex. An absent, disabled, or broken main route passes parent requests through to their original model and upstream. Claude identifies child traffic explicitly, so unknown Claude subagents pass through unchanged. Codex can distinguish only subagents carrying router-owned hidden model aliases; other Codex traffic follows the main route as described below. Disabled or broken explicit subagent routes retain their existing fallback behavior. The router does not translate protocols: Claude routes require an Anthropic Messages-compatible endpoint, while Codex routes require an OpenAI Responses-compatible endpoint.

Claude main routes apply only when no child identity is present; identified children continue through their named route or normal pass-through behavior. Codex resolves hidden child aliases before its optional main route. Every request whose model is not a router-owned hidden alias uses the Codex main route when enabled, including an unconfigured subagent that inherits the parent model. Explicit aliased subagent routes retain precedence. Codex uses V1 for stock and dynamic subagents and V2 for valid explicit-model global custom agents. Unsupported configured combinations are blocked instead of silently inheriting the parent model. Discovery is limited to built-in and global user-defined subagents.

The [user guide](docs/USING_THE_APP.md) is the source of truth for setup, compatibility, removal, and troubleshooting. [Architecture](docs/ARCHITECTURE.md) describes the internal request and lifecycle flows.

## SWE-2 through llm-local-gateway

Add a destination with Anthropic base URL `http://127.0.0.1:4317/claude` and
optionally OpenAI base URL `http://127.0.0.1:4317/openai/v1`. **Test Anthropic**
discovers the gateway's models; model discovery alone does not verify inference.
For a selected Claude subagent such as `Explore`, choose `swe-2-medium`,
`swe-2-high`, or `swe-2-max`. Leave the Claude main route absent to preserve the
parent's original upstream. The gateway must be running and authenticated with
a Devin account entitled to SWE-2.

The router already supports arbitrary destination model IDs, so SWE-2 requires
no model registry or protocol changes here. It forwards reasoning options
unchanged: when a child sends an explicit effort, it must match the selected
SWE-2 variant. The gateway rejects conflicting effort, disabled thinking, and
explicit thinking budgets instead of silently changing the model. The gateway's
isolated `claude-swe2.mjs` launcher omits normal router hooks; use normal Claude
with **Set Up Routing** for selected-subagent routing.

A bounded opt-in check uses the actual Claude CLI and router hooks, a scripted
parent, and a real SWE-2 child. It keeps temporary-home isolation and does not
change everyday settings. With the updated gateway already running and the
router source ready (the command builds its helper):

```sh
SMR_LIVE_CLAUDE_UPSTREAM_URL=http://127.0.0.1:4317/claude \
SMR_LIVE_CLAUDE_MODEL=swe-2-medium \
npm run test:live-claude
```

This consumes Devin quota. It verifies the child's streamed response, the
`Explore` routing decision, parent pass-through, and hook cleanup. The gateway's
SWE-2 live verifier additionally checks Devin's returned model metadata; the
model name sent or echoed by the router is not upstream inference evidence.

## Configuration and CLI

The app and CLI share `~/.local/share/subagent-model-router/config.json`. The version 2 schema uses named, reusable destinations. This abridged example shows the route shape; use the app or `init` command to create a complete configuration:

```json
{
  "version": 2,
  "gateway": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 9476,
    "maxBodyBytes": 16777216
  },
  "destinations": {
    "example-provider": {
      "name": "Example Provider",
      "openaiBaseUrl": "https://provider.example/openai/v1",
      "anthropicBaseUrl": "https://provider.example/claude"
    }
  },
  "routes": {
    "claude": {
      "Explore": {
        "enabled": true,
        "model": "example-model",
        "destination": "example-provider"
      }
    },
    "codex": {
      "explorer": {
        "enabled": true,
        "alias": "router-explorer",
        "model": "example-model",
        "destination": "example-provider",
        "requiredMultiAgentVersion": "v1"
      }
    }
  },
  "mainRoutes": {
    "claude": {
      "enabled": true,
      "model": "example-main-model",
      "destination": "example-provider"
    },
    "codex": {
      "enabled": false,
      "model": "example-main-model",
      "destination": "example-provider"
    }
  }
}
```

Because `explorer` is a built-in dynamic agent, the complete configuration must also list at least one `harnesses.codex.parentModels` entry. The app fills that value from the configured Codex parent model when available.

Version 1 inline-upstream configurations migrate automatically. Existing version 2 configurations gain an empty `mainRoutes` section without changing behavior. A deleted destination may leave a visible broken route so the route can be repaired or removed later.

Installations created as Harness Model Router migrate automatically on first launch. The app moves the legacy data directory, rewrites its owned Claude and Codex hooks and provider block, preserves restoration state, and removes the superseded helper after migration.

The app does not store provider secrets. An advanced route may reference an environment variable:

```json
"authorization": {
  "env": "INDEPENDENT_PROVIDER_KEY",
  "header": "Authorization",
  "scheme": "Bearer"
}
```

End-to-end headers are preserved across destinations unless the original Codex provider declared their names in `http_headers` or `env_http_headers`; those provider-bound headers stay on the original upstream origin. A different destination receives credentials only from its environment-variable authorization reference. Transport headers such as `Host`, `Content-Length`, `Connection`, and other hop-by-hop fields are removed or reconstructed.

For direct CLI use:

```sh
npm run build
node dist/cli.js init
node dist/cli.js discover --json
node dist/cli.js validate --json
node dist/cli.js routes --json
node dist/cli.js status --json
node dist/cli.js start
```

The CLI exposes main routes separately from named subagent routes: `main-route set`, `main-route enable`, `main-route disable`, and `main-route remove`.

Run `node dist/cli.js --help` for setup, removal, route, catalog, and lifecycle commands. Discovery is global-only and includes built-in and user-defined agents.

Environment variables use the `SMR_` prefix. The previous `HMR_` names remain accepted as deprecated aliases for compatibility.

## Development and verification

`npm run check` runs version checks, lint, type checking, deterministic tests
(including standalone-helper packaging), and the TypeScript build. `npm test`
excludes `test/live-*.test.ts` even when live flags remain in the environment.
Run a focused file with `npm test -- test/core.test.ts`.

Run native tests for Swift or helper/app contract changes, and the full app
build and signature verification for macOS packaging changes:

```sh
npm run check
npm run test:native
npm run build:macos
codesign --verify --deep --strict --verbose=2 "dist/Subagent Model Router.app"
```

Optional CLI checks build the current helper first, use temporary homes, and
fail if the requested CLI is unavailable. They do not modify real Claude or
Codex configuration. By default, both use scripted loopback responses without
provider inference. For the Claude fixture check, clear any inherited real-child
destination; the real-provider variant is documented below:

```sh
env -u SMR_LIVE_CLAUDE_UPSTREAM_URL -u SMR_LIVE_CLAUDE_MODEL npm run test:live-claude
npm run test:live-codex
```

Hook and configuration schemas were checked against the official [Codex hooks documentation](https://developers.openai.com/codex/hooks), [Codex subagents documentation](https://developers.openai.com/codex/subagents), [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), and [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).
