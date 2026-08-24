#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { catalogOverlaySummary, type ModelCatalog } from "./catalog.js";
import { appPaths, appState, ensureGlobalConfig, removeHarness, replaceAppConfig, resetEverything, setupHarness } from "./app.js";
import { defaultConfig, defaultGlobalConfig, loadConfig, routeUpstream, saveConfig, validateConfig } from "./config.js";
import { discover } from "./discovery.js";
import { exists } from "./files.js";
import { listenGateway } from "./gateway.js";
import { deliverClaudeHook, runCodexPreToolHook } from "./hooks.js";
import { installIntegration, uninstallIntegration, writeCatalogOverlay } from "./lifecycle.js";
import { safeError } from "./redact.js";
import type { ClaudeHookInput, CodexPreToolInput, Harness, Route, RouterConfig } from "./types.js";
import { ROUTER_VERSION } from "./version.js";

async function main(rawArgs: string[]): Promise<void> {
  const { args, configPath } = globalArguments(rawArgs);
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") return void await printHelp();
  if (command === "--version" || command === "-v") return void console.log(ROUTER_VERSION);
  switch (command) {
    case "init": return void await initialize(configPath, rest.includes("--force"));
    case "validate": return void await validate(configPath, rest.includes("--json"));
    case "discover": return void await runDiscovery(configPath, rest.includes("--json"));
    case "install": return void await install(configPath, rest.includes("--force"));
    case "uninstall":
    case "restore": return void await uninstall(configPath, rest.includes("--force"));
    case "start": return void await start(configPath);
    case "status": return void await status(configPath, rest.includes("--json"));
    case "routes": return void await routes(configPath, rest.includes("--json"));
    case "catalog": return void await catalog(configPath, rest.includes("--json"));
    case "route": return void await routeCommand(configPath, rest);
    case "disable": return void await disableHarness(configPath, rest[0]);
    case "enable": return void await enableHarness(configPath, rest[0]);
    case "hook": return void await hookCommand(configPath, rest[0]);
    case "app-state": return void await printAppState(configPath);
    case "setup": return void await setup(configPath, rest);
    case "remove": return void await remove(configPath, rest);
    case "config": return void await configCommand(configPath, rest);
    case "reset": return void await reset(configPath, rest.includes("--force"));
    case "models": return void await models(configPath, rest);
    default: throw new Error(`Unknown command: ${command}`);
  }
}

function globalArguments(raw: string[]): { args: string[]; configPath: string } {
  const args = [...raw];
  let configPath = process.env.SMR_CONFIG ?? process.env.HMR_CONFIG ?? appPaths(testableHome()).config;
  const index = args.indexOf("--config");
  if (index >= 0) {
    const value = args[index + 1];
    if (!value) throw new Error("--config requires a path");
    configPath = resolve(value);
    args.splice(index, 2);
  }
  return { args, configPath };
}

async function initialize(path: string, force: boolean): Promise<void> {
  if (await exists(path) && !force) throw new Error(`${path} already exists; use --force to replace it`);
  const globalPath = appPaths(testableHome()).config;
  await saveConfig(path, path === globalPath ? defaultGlobalConfig(dirname(path)) : defaultConfig(dirname(dirname(path))));
  console.log(`Initialized ${path}`);
}

async function validate(path: string, json: boolean): Promise<void> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const issues = validateConfig(raw);
  if (json) console.log(JSON.stringify({ valid: issues.length === 0, issues }, null, 2));
  else console.log(issues.length === 0 ? "Configuration is valid." : `Configuration is invalid:\n- ${issues.join("\n- ")}`);
  if (issues.length > 0) process.exitCode = 1;
}

async function runDiscovery(path: string, json: boolean): Promise<void> {
  const config = await optionalConfig(path);
  const result = await discover({ home: testableHome(), ...(config ? { config } : {}) });
  if (json) return void console.log(JSON.stringify(result, null, 2));
  for (const agent of result.agents) console.log(`${agent.harness}\t${agent.kind}\t${agent.name}${agent.explicitModel ? `\tmodel=${agent.explicitModel}` : ""}${agent.path ? `\t${agent.path}` : ""}`);
}

async function install(path: string, force: boolean): Promise<void> {
  const result = await installIntegration(path, { home: testableHome(), cliPath: fileURLToPath(import.meta.url), force });
  printLifecycle(result);
}

async function uninstall(path: string, force: boolean): Promise<void> {
  const result = await uninstallIntegration(path, force);
  printLifecycle(result);
}

function printLifecycle(result: { changed: string[]; conflicts: string[] }): void {
  for (const path of result.changed) console.log(`changed\t${path}`);
  for (const conflict of result.conflicts) console.error(`conflict\t${conflict}`);
  if (result.conflicts.length > 0) process.exitCode = 2;
}

async function start(path: string): Promise<void> {
  await ensureGlobalConfig(path, testableHome());
  const server = await listenGateway({ configPath: path, logger: (record) => console.error(JSON.stringify(record)) });
  const address = server.address();
  console.log(`Gateway listening on ${typeof address === "object" && address ? `${address.address}:${address.port}` : String(address)}`);
  const shutdown = (): void => { server.close(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (process.argv.includes("--parent-lifeline")) {
    process.stdin.resume();
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
  }
}

async function status(path: string, json: boolean): Promise<void> {
  const config = await loadConfig(path);
  let gateway: unknown = { reachable: false };
  try {
    const response = await fetch(`http://${config.gateway.host}:${config.gateway.port}/__router/status`, { signal: AbortSignal.timeout(700) });
    gateway = { reachable: response.ok, ...(response.ok ? await response.json() as object : { status: response.status }) };
  } catch { /* an unavailable gateway is a normal status */ }
  const value = { gateway, harnesses: { claude: config.harnesses.claude.enabled, codex: config.harnesses.codex.enabled }, routeCount: { claude: Object.keys(config.routes.claude).length, codex: Object.keys(config.routes.codex).length } };
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(`gateway=${(gateway as any).reachable ? "running" : "stopped"} claude=${config.harnesses.claude.enabled ? "enabled" : "disabled"} codex=${config.harnesses.codex.enabled ? "enabled" : "disabled"}`);
}

async function routes(path: string, json: boolean): Promise<void> {
  const config = await loadConfig(path);
  const effective = (Object.entries(config.routes) as Array<[Harness, Record<string, Route>]>).flatMap(([harness, entries]) => Object.entries(entries).map(([agent, route]) => {
    const upstream = routeUpstream(config, harness, route);
    return { harness, agent, enabled: route.enabled && config.harnesses[harness].enabled && Boolean(upstream), broken: !upstream, destination: route.destination, alias: route.alias, wireModel: route.model, endpoint: upstream?.baseUrl, protocol: upstream?.protocol, requiredMultiAgentVersion: route.requiredMultiAgentVersion };
  }));
  if (json) console.log(JSON.stringify(effective, null, 2));
  else for (const route of effective) console.log(`${route.harness}\t${route.agent}\t${route.enabled ? "enabled" : "disabled"}\t${route.alias ?? "-"}\t${route.wireModel}\t${route.endpoint}`);
}

async function catalog(path: string, json: boolean): Promise<void> {
  const config = await loadConfig(path);
  const sourcePath = config.harnesses.codex.sourceCatalogPath;
  const overlayPath = config.harnesses.codex.overlayCatalogPath;
  if (!sourcePath || !overlayPath || !await exists(overlayPath)) throw new Error("Catalog overlay is not installed");
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as ModelCatalog;
  const overlay = JSON.parse(await readFile(overlayPath, "utf8")) as ModelCatalog;
  const summary = catalogOverlaySummary(source, overlay);
  if (json) console.log(JSON.stringify(summary, null, 2));
  else for (const item of summary) console.log(`${item.kind}\t${item.slug}\t${item.multiAgentVersion ?? "-"}`);
}

async function routeCommand(path: string, args: string[]): Promise<void> {
  const [action, harnessValue, agent] = args;
  if (action !== "set" && action !== "enable" && action !== "disable") throw new Error("route action must be set, enable, or disable");
  if (harnessValue !== "claude" && harnessValue !== "codex") throw new Error("route harness must be claude or codex");
  if (!agent) throw new Error("route requires an agent type");
  const config = await loadConfig(path);
  if (action === "enable" || action === "disable") {
    const route = config.routes[harnessValue][agent];
    if (!route) throw new Error(`No ${harnessValue} route exists for ${agent}`);
    route.enabled = action === "enable";
  } else {
    const model = option(args, "--model");
    const endpoint = option(args, "--endpoint");
    if (!model || !endpoint) throw new Error("route set requires --model and --endpoint");
    const alias = harnessValue === "codex" ? option(args, "--alias") ?? `router-${agent.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}` : undefined;
    const authorizationEnv = option(args, "--auth-env");
    const destination = option(args, "--destination") ?? `${harnessValue}-${agent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    config.destinations[destination] ??= {
      name: `${harnessValue === "claude" ? "Claude" : "Codex"} · ${agent}`,
      ...(harnessValue === "claude" ? { anthropicBaseUrl: endpoint } : { openaiBaseUrl: endpoint }),
    };
    config.routes[harnessValue][agent] = {
      enabled: !args.includes("--disabled"),
      ...(alias ? { alias } : {}),
      model,
      destination,
      ...(authorizationEnv ? { authorization: { env: authorizationEnv, ...(option(args, "--auth-header") ? { header: option(args, "--auth-header")! } : {}), ...(option(args, "--auth-scheme") ? { scheme: option(args, "--auth-scheme")! } : {}) } } : {}),
      ...(option(args, "--multi-agent-version") === "v1" ? { requiredMultiAgentVersion: "v1" as const } : {}),
    };
  }
  await saveConfig(path, config);
  if (config.harnesses.codex.sourceCatalogPath && config.harnesses.codex.overlayCatalogPath && await exists(config.harnesses.codex.sourceCatalogPath)) await writeCatalogOverlay(config);
  console.log(`${action} ${harnessValue} route ${agent}`);
}

async function disableHarness(path: string, value: string | undefined): Promise<void> {
  if (value !== "claude" && value !== "codex" && value !== "all") throw new Error("disable requires claude, codex, or all");
  const config = await loadConfig(path);
  if (value === "claude" || value === "all") config.harnesses.claude.enabled = false;
  if (value === "codex" || value === "all") config.harnesses.codex.enabled = false;
  await saveConfig(path, config);
  if (config.harnesses.codex.sourceCatalogPath && config.harnesses.codex.overlayCatalogPath && await exists(config.harnesses.codex.sourceCatalogPath)) await writeCatalogOverlay(config);
  console.log(`Disabled ${value}`);
}

async function enableHarness(path: string, value: string | undefined): Promise<void> {
  if (value !== "claude" && value !== "codex" && value !== "all") throw new Error("enable requires claude, codex, or all");
  const config = await loadConfig(path);
  if (value === "claude" || value === "all") config.harnesses.claude.enabled = true;
  if (value === "codex" || value === "all") config.harnesses.codex.enabled = true;
  await saveConfig(path, config);
  if (config.harnesses.codex.sourceCatalogPath && config.harnesses.codex.overlayCatalogPath && await exists(config.harnesses.codex.sourceCatalogPath)) await writeCatalogOverlay(config);
  console.log(`Enabled ${value}`);
}

async function hookCommand(path: string, kind: string | undefined): Promise<void> {
  const config = await loadConfig(path);
  const input = JSON.parse(await readStdin()) as ClaudeHookInput | CodexPreToolInput;
  if (kind === "claude-start" || kind === "claude-stop") {
    await deliverClaudeHook(config, input as ClaudeHookInput);
    return;
  }
  if (kind === "codex-pretool") {
    const output = runCodexPreToolHook(config, input as CodexPreToolInput);
    if (output) process.stdout.write(JSON.stringify(output));
    return;
  }
  throw new Error("Unknown hook command");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function optionalConfig(path: string): Promise<RouterConfig | undefined> { return await exists(path) ? loadConfig(path) : undefined; }
function testableHome(): string {
  const configured = process.env.SMR_HOME ?? process.env.HMR_HOME;
  return configured ? resolve(configured) : homedir();
}
async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }

async function printHelp(): Promise<void> {
  console.log(`subagent-model-router ${ROUTER_VERSION}\n\nCommands:\n  app-state --json\n  setup <claude|codex> --helper-path <path>\n  remove <claude|codex> [--force]\n  config get|replace\n  reset [--force]\n  models <destination> <claude|codex>\n  init [--force]\n  discover [--json]\n  install [--force]\n  validate [--json]\n  route set <claude|codex> <agent> --model <slug> --endpoint <url> [--alias <alias>]\n  route enable|disable <claude|codex> <agent>\n  routes [--json]\n  catalog [--json]\n  status [--json]\n  start [--parent-lifeline]\n  enable|disable <claude|codex|all>\n  restore|uninstall [--force]\n\nGlobal:\n  --config <path>`);
}

async function printAppState(path: string): Promise<void> { console.log(JSON.stringify(await appState(path, testableHome()), null, 2)); }

async function setup(path: string, args: string[]): Promise<void> {
  const harness = harnessArgument(args[0]);
  const helperPath = option(args, "--helper-path") ?? appPaths(testableHome()).helper;
  console.log(JSON.stringify(await setupHarness(path, harness, helperPath, testableHome(), args.includes("--force")), null, 2));
}

async function remove(path: string, args: string[]): Promise<void> {
  const harness = harnessArgument(args[0]);
  console.log(JSON.stringify(await removeHarness(path, harness, args.includes("--force")), null, 2));
}

async function configCommand(path: string, args: string[]): Promise<void> {
  if (args[0] === "get") return void console.log(JSON.stringify(await ensureGlobalConfig(path, testableHome()), null, 2));
  if (args[0] !== "replace") throw new Error("config requires get or replace");
  const raw = JSON.parse(await readStdin()) as unknown;
  const helperPath = option(args, "--helper-path") ?? appPaths(testableHome()).helper;
  console.log(JSON.stringify(await replaceAppConfig(path, raw, helperPath, testableHome()), null, 2));
}

async function reset(path: string, force: boolean): Promise<void> { console.log(JSON.stringify(await resetEverything(path, testableHome(), force), null, 2)); }

async function models(path: string, args: string[]): Promise<void> {
  const destinationId = args[0];
  const harness = harnessArgument(args[1]);
  if (!destinationId) throw new Error("models requires a destination id");
  const config = await loadConfig(path);
  const destination = config.destinations[destinationId];
  if (!destination) throw new Error(`Unknown destination ${destinationId}`);
  const base = harness === "claude" ? destination.anthropicBaseUrl : destination.openaiBaseUrl;
  if (!base) throw new Error(`Destination ${destinationId} does not support ${harness}`);
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${url.pathname.replace(/\/$/, "").endsWith("/v1") ? "" : "/v1"}/models`;
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Models endpoint returned HTTP ${response.status}`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; slug?: unknown }> };
  const values = [...(payload.data ?? []), ...(payload.models ?? [])].map((item) => typeof item.id === "string" ? item.id : typeof (item as any).slug === "string" ? (item as any).slug as string : undefined).filter((item): item is string => Boolean(item));
  console.log(JSON.stringify({ reachable: true, models: [...new Set(values)].sort() }, null, 2));
}

function harnessArgument(value: string | undefined): Harness {
  if (value !== "claude" && value !== "codex") throw new Error("expected claude or codex");
  return value;
}

main(process.argv.slice(2)).catch((error) => {
  const message = safeError(error);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`subagent-model-router: ${message}`);
  process.exitCode = 1;
});
