# Subagent Model Router

Subagent Model Router is a native Apple Silicon menu-bar app and localhost gateway for routing Claude Code and Codex subagents to different protocol-compatible models and endpoints.

Parent requests, unknown agents, disabled routes, and routes without a usable destination pass through to their original model and upstream. The router does not translate protocols: Claude routes require an Anthropic Messages-compatible endpoint, while Codex routes require an OpenAI Responses-compatible endpoint.

## macOS app

Requirements:

- Apple Silicon Mac running macOS 15 or newer
- Claude Code, the Codex CLI, or the Codex desktop app already installed
- A destination that exposes an Anthropic Messages endpoint, an OpenAI Responses endpoint, or both
- For source builds: Node.js 24 and Bun 1.3.14 (the pinned versions are in `.node-version` and `.bun-version`)

Build and open the ad-hoc-signed app:

```sh
npm ci
npm run build:macos
open "dist/Subagent Model Router.app"
```

Then:

1. Add a destination.
2. Add a route for a detected or manually entered global agent type.
3. Test the destination if desired.
4. Click **Set Up Routing** for Claude Code, Codex, or both.

The app never installs Claude Code or Codex. Harness configuration changes only after **Set Up Routing** is clicked, and each harness can be restored independently. See [Using the macOS app](docs/USING_THE_APP.md) for the complete setup, removal, conflict, and troubleshooting guide.

The app owns the gateway on fixed loopback address `127.0.0.1:9476`. Its state and helper live under `~/.local/share/subagent-model-router/`.

## Supported routing

Claude routes use hook-provided child identity. Codex uses V1 for stock and dynamic agents and V2 for valid explicit-model global custom agents. Unsupported Codex combinations are blocked instead of silently inheriting the parent model. Discovery is limited to built-in and global user-defined agents.

The [user guide](docs/USING_THE_APP.md) is the source of truth for setup, compatibility, removal, and troubleshooting. [Architecture](docs/ARCHITECTURE.md) describes the internal request and lifecycle flows.

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
  }
}
```

Because `explorer` is a built-in dynamic agent, the complete configuration must also list at least one `harnesses.codex.parentModels` entry. The app fills that value from the configured Codex parent model when available.

Version 1 inline-upstream configurations migrate automatically. A deleted destination may leave a visible broken route so the route can be repaired or removed later.

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

Run `node dist/cli.js --help` for setup, removal, route, catalog, and lifecycle commands. Discovery is global-only and includes built-in and user-defined agents.

Environment variables use the `SMR_` prefix. The previous `HMR_` names remain accepted as deprecated aliases for compatibility.

## Development and verification

Run deterministic TypeScript, packaging, and native checks:

```sh
npm run check
npm run test:native
npm run build:macos
codesign --verify --deep --strict --verbose=2 "dist/Subagent Model Router.app"
```

Optional live CLI checks use temporary homes and do not modify real Claude or Codex configuration:

```sh
npm run test:live-claude
npm run test:live-codex
```

Hook and configuration schemas were checked against the official [Codex hooks documentation](https://developers.openai.com/codex/hooks), [Codex subagents documentation](https://developers.openai.com/codex/subagents), [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), and [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).
