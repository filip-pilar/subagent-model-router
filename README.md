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

## How routing works

### Claude Code

Setup adds owned `SubagentStart` and `SubagentStop` hooks and points `ANTHROPIC_BASE_URL` at the local gateway. Hook events map a Claude session and agent ID to an agent type. Parent traffic has no mapped child identity and passes through; a configured child uses its route.

### Codex

Setup adds an owned `PreToolUse` hook, a local Responses provider, and a generated model-catalog overlay. The hook assigns a hidden route alias to configured subagents; the gateway replaces that alias with the destination model before forwarding.

Global custom Codex agents with an explicit model may have that model normalized to the hidden alias. The exact original model is retained for restoration. Built-in agents and global custom agents without an explicit model use the dynamic hook path. Project-specific agents are intentionally out of scope.

### V1 compatibility

Routes that require readable Codex V1 multi-agent metadata can enable `requiredMultiAgentVersion: "v1"`. Only the route alias and explicitly configured parent models receive the V1 marker. Unrelated catalog entries remain unchanged.

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
    "llm-gateway": {
      "name": "LLM Gateway",
      "openaiBaseUrl": "http://127.0.0.1:4317/openai/v1",
      "anthropicBaseUrl": "http://127.0.0.1:4317/claude"
    }
  },
  "routes": {
    "claude": {
      "Explore": {
        "enabled": true,
        "model": "swe-1-6-slow",
        "destination": "llm-gateway"
      }
    },
    "codex": {
      "explorer": {
        "enabled": true,
        "alias": "router-explorer",
        "model": "swe-1-6-slow",
        "destination": "llm-gateway"
      }
    }
  }
}
```

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

Non-credential end-to-end headers are preserved across destinations. Credential headers are preserved only when a request stays on the original upstream origin. A different destination receives credentials only from its environment-variable authorization reference. Transport headers such as `Host`, `Content-Length`, `Connection`, and other hop-by-hop fields are removed or reconstructed.

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

Run `node dist/cli.js --help` for setup, removal, route, catalog, and lifecycle commands. Discovery used by the app and CLI includes built-in agents, global user agents, and global Claude plugin agents; it does not include project-specific agents.

Environment variables use the `SMR_` prefix. The previous `HMR_` names remain accepted as deprecated aliases for compatibility.

## Restoration and conflicts

Setup is idempotent, avoids duplicate hooks, writes atomically, and preserves unrelated JSON, TOML, agent, and catalog fields. Restoration state records only the router-owned values and hashes required to undo those changes.

Normal removal refuses to overwrite a router-owned value that changed after setup. The app shows every conflict before offering an explicit force action. Force removal is intentionally destructive to the conflicting owned values, so review the listed files first.

**Reset Everything** restores both harnesses, removes destinations and routes, clears app preferences, disables Launch at Login, and stops the gateway. It never uninstalls Claude Code or Codex.

## Development and verification

Internal component boundaries and lifecycle behavior are documented in [Architecture](docs/ARCHITECTURE.md).

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
npm run test:gateway
```

With LLM Gateway already running, the real Claude parent-plus-Explore flow can also be verified through the helper bundled in the built app:

```sh
SMR_LIVE_BUNDLED_HELPER_LLM_GATEWAY=1 \
  npx vitest run test/live-bundled-helper-llm-gateway.test.ts
```

The deterministic tests use local mocks. The opt-in LLM Gateway tests contact the configured local gateway and fail rather than silently passing on authentication, entitlement, or rate-limit errors.

Hook and configuration schemas were checked against the official [Codex hooks documentation](https://developers.openai.com/codex/hooks), [Codex subagents documentation](https://developers.openai.com/codex/subagents), [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), and [Claude Code environment variables](https://code.claude.com/docs/en/env-vars).
