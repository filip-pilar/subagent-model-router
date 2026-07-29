# Using Subagent Model Router

Subagent Model Router changes which model a configured Claude Code or Codex subagent uses. Parent requests and unconfigured agents continue to use their original model and endpoint.

The app uses one global configuration for the Mac. It discovers built-in agents, global user agents, and global Claude plugin agents. Project-specific agents are intentionally ignored.

## Before you start

You need at least one supported harness already installed:

- Claude Code; or
- the Codex CLI or Codex desktop app.

You also need a protocol-compatible destination. A destination can expose:

- an Anthropic Messages base URL for Claude routes;
- an OpenAI Responses base URL for Codex routes; or
- both.

The app does not install harnesses, scan local ports, discover services, or manage API keys.

## 1. Add a destination

Open **Manage…**, select **Destinations**, and click **Add Destination**.

Enter a name, identifier, and at least one endpoint URL. URLs must use `http://` or `https://`. Saving does not require the service to be reachable, so a temporarily offline destination remains configurable.

After saving, use **Test OpenAI** or **Test Anthropic**. A successful model query makes the advertised models available for routes using that exact destination and protocol. Manual model entry always remains available.

Example destination:

```text
Name: Example Provider
OpenAI Responses URL: https://provider.example/openai/v1
Anthropic Messages URL: https://provider.example/claude
```

## 2. Add a route

Select **Routes** and click **Add Route**.

Choose:

- Claude Code or Codex;
- a detected global agent, or enter its agent type manually;
- a destination supporting that harness protocol;
- the model slug the destination should receive; and
- whether the route is enabled.

Codex routes receive a hidden internal alias. Advanced options also expose V1 multi-agent compatibility, parent models, and environment-variable authorization references.

Deleting a destination does not silently delete routes that reference it. Those routes remain visible as broken until repaired or removed.

## 3. Set up routing

Return to the menu and click **Set Up Routing** for each harness you want to use. Claude Code and Codex are independent; either one is sufficient.

The app starts the gateway after the first successful setup and enables Launch at Login by default. You can turn Launch at Login off without removing routing setup.

### What Claude Code setup changes

The app surgically updates the global Claude settings file, normally `~/.claude/settings.json`:

- `ANTHROPIC_BASE_URL` points to `http://127.0.0.1:9476/claude`;
- one owned `SubagentStart` hook is added; and
- one owned `SubagentStop` hook is added.

Unrelated settings and hooks are preserved. The hooks call the helper at its stable private path under `~/.local/share/subagent-model-router/`.

### What Codex setup changes

The app updates global Codex configuration under `~/.codex`:

- an owned `PreToolUse` hook is added;
- an owned localhost model provider is added;
- `model_provider` and `model_catalog_json` point at the router-owned provider and generated overlay; and
- a global custom agent with an explicit model may have that model normalized to its hidden route alias.

The original provider, catalog setting, scalar values, and normalized agent model are recorded for restoration. Unrelated configuration remains untouched.

## Running and stopping

The fixed gateway address is `127.0.0.1:9476`. The app owns the helper process: starting the app starts the helper when routing is configured, and quitting the app stops it.

Stopping or quitting the app does not remove hooks or restore harness configuration. Requests will fail while a harness points at the stopped gateway. Restart the app or remove routing setup.

## Removing routing setup

Use **Remove** beside Claude Code or Codex to restore only that harness. Saved destinations and routes remain available if you want to set it up again later.

Normal removal restores only router-owned values. If one of those values changed after setup, the app stops and lists every conflict instead of overwriting the later edit.

After reviewing the list, **Review…** offers explicit force removal. Force removal may overwrite the listed later edits to router-owned values. It does not overwrite unrelated settings.

## Reset Everything

**Reset Everything**:

- restores both harnesses;
- removes all routes and destinations;
- clears app preferences;
- disables Launch at Login; and
- stops the gateway.

If restoration conflicts exist, the Advanced tab lists them before offering **Review Force Reset…**. Reset never uninstalls Claude Code or Codex.

## Troubleshooting

### Destination is currently unreachable

Confirm the service is running and that the saved URL is its protocol base URL. An unreachable destination can still be saved and does not affect unrelated routes.

### The gateway does not start

Port `9476` may already be occupied. Stop the other process, then start the router again. Use **Log** in the menu for the helper startup error.

### A newly created agent is missing

Quit and reopen Subagent Model Router to refresh global agent discovery. Project-specific agents are not supported.

### An external config edit is invalid

The app reports the validation error and leaves the file untouched. Fix the JSON and save it again. The gateway continues using its last valid configuration.

### Removal reports a conflict

Read the complete conflict list before forcing restoration. If you want to preserve the later edit, cancel and update the affected file manually. Use force only when restoring the router-owned value is intentional.

### Reveal the configuration

Open **Manage… → Advanced → Reveal Config in Finder**. The default path is `~/.local/share/subagent-model-router/config.json`.
