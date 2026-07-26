import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { overlayCatalog, type ModelCatalog } from "./catalog.js";
import { atomicWriteFile, exists } from "./files.js";
import { discover } from "./discovery.js";
import { loadConfig, saveConfig } from "./config.js";
import type { DiscoveredAgent, RouterConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const BLOCK_START = "# subagent-model-router:start";
const BLOCK_END = "# subagent-model-router:end";
const LEGACY_BLOCK_START = "# harness-model-router:start";
const LEGACY_BLOCK_END = "# harness-model-router:end";
const LEGACY_SERVICE_NAME = "harness-model-router";
const SERVICE_NAME = "subagent-model-router";

interface ScalarMutation { key: string; originalLine?: string; installedLine: string }
interface JsonMutation {
  path: string;
  existed: boolean;
  priorBaseUrl?: string;
  installedBaseUrl?: string;
  hookCommands: string[];
}
interface CodexMutation {
  path: string;
  existed: boolean;
  scalars: ScalarMutation[];
  blockHash: string;
}
interface InstallState {
  version: 1;
  claude?: JsonMutation;
  codexHooks?: JsonMutation;
  codexConfig?: CodexMutation;
}

export interface InstallOptions {
  home: string;
  project?: string;
  cliPath?: string;
  nodePath?: string;
  helperPath?: string;
  force?: boolean;
  codexBinary?: string;
}

export interface LifecycleResult { changed: string[]; conflicts: string[] }

export interface IntegrationStatus { claude: boolean; codex: boolean }

export async function installIntegration(configPath: string, options: InstallOptions): Promise<LifecycleResult> {
  const config = await loadConfig(configPath);
  const changed: string[] = [];
  const conflicts: string[] = [];
  const statePath = installStatePath(configPath);
  const state = await readState(statePath);
  const quote = (value: string): string => JSON.stringify(value);
  const hookPrefix = options.helperPath
    ? quote(options.helperPath)
    : `${quote(options.nodePath ?? process.execPath)} ${quote(options.cliPath ?? fileURLPathFallback())}`;
  if (config.harnesses.claude.enabled) {
    const path = config.harnesses.claude.settingsPath ?? resolve(options.home, ".claude/settings.json");
    const base = `http://${config.gateway.host}:${config.gateway.port}/claude`;
    const commands = [
      `${hookPrefix} --config ${quote(configPath)} hook claude-start`,
      `${hookPrefix} --config ${quote(configPath)} hook claude-stop`,
    ];
    state.claude = await installClaudeSettings(path, base, commands, state.claude, options.force ?? false, conflicts);
    if (conflicts.length === 0) changed.push(path);
  }
  if (config.harnesses.codex.enabled) {
    const hooksPath = config.harnesses.codex.hooksPath ?? resolve(options.home, ".codex/hooks.json");
    const codexConfigPath = config.harnesses.codex.configPath ?? resolve(options.home, ".codex/config.toml");
    const hookCommand = `${hookPrefix} --config ${quote(configPath)} hook codex-pretool`;
    await adoptConfiguredCatalog(config, codexConfigPath);
    await ensureSourceCatalog(config, configPath, options.codexBinary, options.home);
    await writeCatalogOverlay(config);
    if (config.harnesses.codex.overlayCatalogPath) changed.push(config.harnesses.codex.overlayCatalogPath);
    state.codexHooks = await installCodexHooks(hooksPath, hookCommand, Math.ceil(config.harnesses.codex.hookTimeoutMs / 1000), state.codexHooks, options.force ?? false, conflicts);
    if (conflicts.length === 0) changed.push(hooksPath);
    state.codexConfig = await installCodexConfig(codexConfigPath, config, state.codexConfig, options.force ?? false, conflicts);
    if (conflicts.length === 0) changed.push(codexConfigPath);
    for (const [path, preserved] of Object.entries(config.preserved.customCodexAgents)) {
      if (config.routes.codex[preserved.agentType]) continue;
      if (!await exists(path)) { conflicts.push(`${path}: normalized custom agent is missing`); continue; }
      const current = await readFile(path, "utf8");
      if (hash(current) !== preserved.installedContentHash && !options.force) { conflicts.push(`${path}: custom agent changed after installation`); continue; }
      await atomicWriteFile(path, restoreCustomModel(current, preserved, options.force ?? false));
      delete config.preserved.customCodexAgents[path];
      changed.push(path);
    }
    const found = await discover({ home: options.home, globalOnly: true, config });
    for (const routeAgent of Object.keys(config.routes.codex)) {
      const agent = selectCodexAgent(found.agents, routeAgent);
      if (agent?.path && agent.explicitModel) {
        const normalized = await normalizeCustomAgent(config, agent, options.force ?? false, conflicts);
        if (normalized) changed.push(agent.path);
      }
    }
    await writeCatalogOverlay(config);
  }
  if (conflicts.length === 0) {
    await saveConfig(configPath, config);
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }
  return { changed: [...new Set(changed)], conflicts };
}

function fileURLPathFallback(): string {
  throw new Error("installIntegration requires cliPath unless helperPath is provided");
}

export async function integrationStatus(configPath: string): Promise<IntegrationStatus> {
  const state = await readState(installStatePath(configPath));
  return { claude: Boolean(state.claude), codex: Boolean(state.codexHooks || state.codexConfig) };
}

export async function migrateLegacyIntegration(configPath: string, legacyDataDirectory: string, dataDirectory: string): Promise<boolean> {
  if (!await exists(configPath)) return false;
  const config = await loadConfig(configPath);
  const statePath = installStatePath(configPath);
  const state = await readState(statePath);
  const writes = new Map<string, { original: string; migrated: string }>();
  let configChanged = false;
  let stateChanged = false;

  const migrateDataPath = (value: string | undefined): string | undefined => {
    if (!value) return value;
    const migrated = value.replaceAll(legacyDataDirectory, dataDirectory);
    if (migrated !== value) configChanged = true;
    return migrated;
  };
  const sourceCatalogPath = migrateDataPath(config.harnesses.codex.sourceCatalogPath);
  const overlayCatalogPath = migrateDataPath(config.harnesses.codex.overlayCatalogPath);
  if (sourceCatalogPath) config.harnesses.codex.sourceCatalogPath = sourceCatalogPath;
  else delete config.harnesses.codex.sourceCatalogPath;
  if (overlayCatalogPath) config.harnesses.codex.overlayCatalogPath = overlayCatalogPath;
  else delete config.harnesses.codex.overlayCatalogPath;

  const migrateHookValue = (value: string): string => value
    .replaceAll(legacyDataDirectory, dataDirectory)
    .replaceAll(`${LEGACY_SERVICE_NAME}-helper`, `${SERVICE_NAME}-helper`);
  const migrateOwnedValue = (value: string): string => migrateHookValue(value)
    .replaceAll(LEGACY_SERVICE_NAME, SERVICE_NAME);

  for (const mutation of [state.claude, state.codexHooks]) {
    if (!mutation) continue;
    const original = await readFile(mutation.path, "utf8");
    const document = JSON.parse(original) as Record<string, any>;
    const migratedCommands = mutation.hookCommands.map(migrateHookValue);
    let documentChanged = false;
    for (let index = 0; index < mutation.hookCommands.length; index += 1) {
      const legacyCommand = mutation.hookCommands[index]!;
      const migratedCommand = migratedCommands[index]!;
      if (legacyCommand === migratedCommand) continue;
      if (replaceHookCommand(document.hooks, legacyCommand, migratedCommand)) {
        documentChanged = true;
      } else if (!hookExists(document.hooks ?? {}, migratedCommand)) {
        throw new Error(`${mutation.path}: legacy router hook changed before it could be migrated`);
      }
    }
    if (documentChanged) writes.set(mutation.path, { original, migrated: `${JSON.stringify(document, null, 2)}\n` });
    if (migratedCommands.some((command, index) => command !== mutation.hookCommands[index])) {
      mutation.hookCommands = migratedCommands;
      stateChanged = true;
    }
  }

  if (state.codexConfig) {
    const mutation = state.codexConfig;
    const original = await readFile(mutation.path, "utf8");
    let migrated = original;
    const legacyBlock = extractOwnedBlockWithMarkers(migrated, LEGACY_BLOCK_START, LEGACY_BLOCK_END);
    if (legacyBlock) {
      if (hash(legacyBlock) !== mutation.blockHash) {
        throw new Error(`${mutation.path}: legacy Codex provider block changed before it could be migrated`);
      }
      const migratedBlock = migrateOwnedValue(legacyBlock);
      migrated = migrated.replace(legacyBlock, migratedBlock);
      mutation.blockHash = hash(migratedBlock);
      stateChanged = true;
    } else {
      const currentBlock = extractOwnedBlock(migrated);
      if (!currentBlock || hash(currentBlock) !== mutation.blockHash) {
        throw new Error(`${mutation.path}: owned Codex provider block is missing or changed`);
      }
    }
    for (const scalar of mutation.scalars) {
      const installedLine = scalar.key === "model_provider"
        ? migrateOwnedValue(scalar.installedLine)
        : migrateHookValue(scalar.installedLine);
      const originalLine = scalar.originalLine?.replaceAll(legacyDataDirectory, dataDirectory);
      if (installedLine !== scalar.installedLine) {
        const lines = migrated.split(/\r?\n/);
        const legacyIndex = lines.findIndex((line) => line.trim() === scalar.installedLine.trim());
        const currentIndex = lines.findIndex((line) => line.trim() === installedLine.trim());
        if (legacyIndex >= 0) lines[legacyIndex] = installedLine;
        else if (currentIndex < 0) throw new Error(`${mutation.path}: ${scalar.key} changed before it could be migrated`);
        migrated = lines.join("\n");
        scalar.installedLine = installedLine;
        stateChanged = true;
      }
      if (originalLine !== scalar.originalLine) {
        if (originalLine === undefined) delete scalar.originalLine;
        else scalar.originalLine = originalLine;
        stateChanged = true;
      }
    }
    if (migrated !== original) writes.set(mutation.path, { original, migrated });
  }

  if (configChanged) {
    writes.set(configPath, {
      original: await readFile(configPath, "utf8"),
      migrated: `${JSON.stringify(config, null, 2)}\n`,
    });
  }
  if (stateChanged && await exists(statePath)) {
    writes.set(statePath, {
      original: await readFile(statePath, "utf8"),
      migrated: `${JSON.stringify(state, null, 2)}\n`,
    });
  }

  const applied: Array<[string, string]> = [];
  try {
    for (const [path, contents] of writes) {
      await atomicWriteFile(path, contents.migrated, 0o600);
      applied.push([path, contents.original]);
    }
  } catch (error) {
    for (const [path, original] of applied.reverse()) await atomicWriteFile(path, original, 0o600);
    throw error;
  }

  const legacyHelper = resolve(dataDirectory, "bin", `${LEGACY_SERVICE_NAME}-helper`);
  if (await exists(legacyHelper)) await unlink(legacyHelper);
  return writes.size > 0;
}

function replaceHookCommand(hooks: Record<string, any> | undefined, legacyCommand: string, migratedCommand: string): boolean {
  if (!hooks) return false;
  let changed = false;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook?.command === legacyCommand) {
          hook.command = migratedCommand;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export async function uninstallHarnessIntegration(configPath: string, harness: "claude" | "codex", force = false): Promise<LifecycleResult> {
  const config = await loadConfig(configPath);
  const statePath = installStatePath(configPath);
  const state = await readState(statePath);
  const changed: string[] = [];
  const conflicts: string[] = [];
  if (harness === "claude") {
    if (state.claude && await uninstallJsonMutation(state.claude, force, conflicts, "claude")) {
      changed.push(state.claude.path);
      delete state.claude;
    }
    if (conflicts.length === 0 || force) config.harnesses.claude.enabled = false;
  } else {
    if (state.codexHooks && await uninstallJsonMutation(state.codexHooks, force, conflicts, "codex")) {
      changed.push(state.codexHooks.path);
      delete state.codexHooks;
    }
    if (state.codexConfig && await uninstallCodexConfig(state.codexConfig, force, conflicts)) {
      changed.push(state.codexConfig.path);
      delete state.codexConfig;
    }
    for (const [path, preserved] of Object.entries(config.preserved.customCodexAgents)) {
      if (!await exists(path)) { conflicts.push(`${path}: normalized custom agent is missing`); continue; }
      const current = await readFile(path, "utf8");
      if (hash(current) !== preserved.installedContentHash && !force) { conflicts.push(`${path}: custom agent changed after installation`); continue; }
      const restored = restoreCustomModel(current, preserved, force);
      await atomicWriteFile(path, restored);
      delete config.preserved.customCodexAgents[path];
      changed.push(path);
    }
    if (conflicts.length === 0 || force) {
      config.harnesses.codex.enabled = false;
      const overlay = config.harnesses.codex.overlayCatalogPath;
      if (overlay && await exists(overlay)) { await unlink(overlay); changed.push(overlay); }
    }
  }
  if (conflicts.length === 0 || force) {
    await saveConfig(configPath, config);
    if (state.claude || state.codexHooks || state.codexConfig) await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    else if (await exists(statePath)) await unlink(statePath);
  }
  return { changed: [...new Set(changed)], conflicts };
}

async function adoptConfiguredCatalog(config: RouterConfig, codexConfigPath: string): Promise<void> {
  if (config.harnesses.codex.sourceCatalogPath || !await exists(codexConfigPath)) return;
  const parsed = parseToml(await readFile(codexConfigPath, "utf8")) as Record<string, unknown>;
  if (typeof parsed.model_catalog_json === "string") {
    config.harnesses.codex.sourceCatalogPath = resolve(dirname(codexConfigPath), parsed.model_catalog_json);
  }
}

export async function uninstallIntegration(configPath: string, force = false): Promise<LifecycleResult> {
  const config = await loadConfig(configPath);
  const statePath = installStatePath(configPath);
  const state = await readState(statePath);
  const changed: string[] = [];
  const conflicts: string[] = [];
  if (state.claude && await uninstallJsonMutation(state.claude, force, conflicts, "claude")) changed.push(state.claude.path);
  if (state.codexHooks && await uninstallJsonMutation(state.codexHooks, force, conflicts, "codex")) changed.push(state.codexHooks.path);
  if (state.codexConfig && await uninstallCodexConfig(state.codexConfig, force, conflicts)) changed.push(state.codexConfig.path);
  for (const [path, preserved] of Object.entries(config.preserved.customCodexAgents)) {
    if (!await exists(path)) {
      conflicts.push(`${path}: normalized custom agent is missing`);
      continue;
    }
    const current = await readFile(path, "utf8");
    if (hash(current) !== preserved.installedContentHash && !force) {
      conflicts.push(`${path}: custom agent changed after installation`);
      continue;
    }
    const restored = restoreCustomModel(current, preserved, force);
    if (!force && hash(restored) !== preserved.originalContentHash) {
      conflicts.push(`${path}: exact custom agent restoration check failed`);
      continue;
    }
    await atomicWriteFile(path, restored);
    delete config.preserved.customCodexAgents[path];
    changed.push(path);
  }
  if (conflicts.length === 0 || force) {
    await saveConfig(configPath, config);
    if (await exists(statePath)) await unlink(statePath);
    const overlay = config.harnesses.codex.overlayCatalogPath;
    if (overlay && await exists(overlay)) {
      await unlink(overlay);
      changed.push(overlay);
    }
  }
  return { changed: [...new Set(changed)], conflicts };
}

export async function writeCatalogOverlay(config: RouterConfig): Promise<void> {
  const sourcePath = config.harnesses.codex.sourceCatalogPath;
  const targetPath = config.harnesses.codex.overlayCatalogPath;
  if (!sourcePath || !targetPath) throw new Error("Codex sourceCatalogPath and overlayCatalogPath are required");
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as ModelCatalog;
  const result = overlayCatalog(source, config);
  await atomicWriteFile(targetPath, `${JSON.stringify(result, null, 2)}\n`, 0o600);
}

async function ensureSourceCatalog(config: RouterConfig, configPath: string, codexBinary: string | undefined, home: string): Promise<void> {
  if (config.harnesses.codex.sourceCatalogPath && await exists(config.harnesses.codex.sourceCatalogPath)) return;
  const target = resolve(dirname(configPath), "codex-source-catalog.json");
  const failures: string[] = [];
  if (codexBinary) try {
    const { stdout } = await execFileAsync(codexBinary, ["debug", "models", "--bundled"], { maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as ModelCatalog;
    if (!Array.isArray(parsed.models)) throw new Error("catalog has no models array");
    await atomicWriteFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
    config.harnesses.codex.sourceCatalogPath = target;
    return;
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  const cachePath = resolve(home, ".codex/models_cache.json");
  if (await exists(cachePath)) try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as ModelCatalog;
    if (!Array.isArray(parsed.models)) throw new Error("model cache has no models array");
    await atomicWriteFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
    config.harnesses.codex.sourceCatalogPath = target;
    return;
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  throw new Error(`Unable to capture the installed Codex catalog${failures.length ? `: ${failures.join("; ")}` : ". Open Codex once or install its CLI so a model catalog is available."}`);
}

async function installClaudeSettings(path: string, baseUrl: string, commands: string[], prior: JsonMutation | undefined, force: boolean, conflicts: string[]): Promise<JsonMutation> {
  const existed = await exists(path);
  const document = existed ? JSON.parse(await readFile(path, "utf8")) as Record<string, any> : {};
  document.env ??= {};
  const existingBase = document.env.ANTHROPIC_BASE_URL;
  if (typeof existingBase === "string") assertCredentialFreeUrl(existingBase, `${path} ANTHROPIC_BASE_URL`);
  if (prior?.installedBaseUrl && existingBase !== prior.installedBaseUrl && existingBase !== baseUrl && !force) {
    conflicts.push(`${path}: ANTHROPIC_BASE_URL changed after installation`);
    return prior;
  }
  const priorBaseUrl = prior ? prior.priorBaseUrl : (typeof existingBase === "string" ? existingBase : undefined);
  document.env.ANTHROPIC_BASE_URL = baseUrl;
  document.hooks ??= {};
  addHook(document.hooks, "SubagentStart", commands[0]!, "Registering subagent route");
  addHook(document.hooks, "SubagentStop", commands[1]!, "Removing subagent route");
  await atomicWriteFile(path, `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return { path, existed: prior?.existed ?? existed, ...(priorBaseUrl ? { priorBaseUrl } : {}), installedBaseUrl: baseUrl, hookCommands: commands };
}

async function installCodexHooks(path: string, command: string, timeoutSeconds: number, prior: JsonMutation | undefined, force: boolean, conflicts: string[]): Promise<JsonMutation> {
  const existed = await exists(path);
  const document = existed ? JSON.parse(await readFile(path, "utf8")) as Record<string, any> : {};
  document.hooks ??= {};
  if (prior && !hookExists(document.hooks, command) && !force) {
    conflicts.push(`${path}: owned Codex hook changed after installation`);
    return prior;
  }
  addHook(document.hooks, "PreToolUse", command, "Selecting subagent route", "^(Agent|spawn_agent|collaborationspawn_agent|multi_agent_v1\\.spawn_agent|functions\\.spawn_agent)$", timeoutSeconds);
  await atomicWriteFile(path, `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return { path, existed: prior?.existed ?? existed, hookCommands: [command] };
}

function addHook(hooks: Record<string, any>, event: string, command: string, statusMessage: string, matcher = "*", timeout = 2): void {
  hooks[event] ??= [];
  if (hookExists({ [event]: hooks[event] }, command)) return;
  hooks[event].push({ matcher, hooks: [{ type: "command", command, timeout, statusMessage }] });
}

function hookExists(hooks: Record<string, any>, command: string): boolean {
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook: any) => hook?.command === command)));
}

async function uninstallJsonMutation(mutation: JsonMutation, force: boolean, conflicts: string[], kind: "claude" | "codex"): Promise<boolean> {
  if (!await exists(mutation.path)) return false;
  const document = JSON.parse(await readFile(mutation.path, "utf8")) as Record<string, any>;
  if (kind === "claude" && mutation.installedBaseUrl && document.env?.ANTHROPIC_BASE_URL !== mutation.installedBaseUrl && !force) {
    conflicts.push(`${mutation.path}: ANTHROPIC_BASE_URL changed after installation`);
    return false;
  }
  for (const command of mutation.hookCommands) removeHook(document.hooks, command);
  if (kind === "claude" && document.env) {
    if (mutation.priorBaseUrl !== undefined) document.env.ANTHROPIC_BASE_URL = mutation.priorBaseUrl;
    else delete document.env.ANTHROPIC_BASE_URL;
    if (Object.keys(document.env).length === 0) delete document.env;
  }
  if (document.hooks && Object.keys(document.hooks).length === 0) delete document.hooks;
  if (!mutation.existed && Object.keys(document).length === 0) await unlink(mutation.path);
  else await atomicWriteFile(mutation.path, `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return true;
}

function removeHook(hooks: Record<string, any> | undefined, command: string): void {
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].map((group: any) => ({ ...group, hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook: any) => hook?.command !== command) : group.hooks })).filter((group: any) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
}

async function installCodexConfig(path: string, config: RouterConfig, prior: CodexMutation | undefined, force: boolean, conflicts: string[]): Promise<CodexMutation> {
  const existed = await exists(path);
  let content = existed ? await readFile(path, "utf8") : "";
  if (prior) {
    const block = extractOwnedBlock(content);
    if (!block || hash(block) !== prior.blockHash) {
      if (!force) {
        conflicts.push(`${path}: owned Codex provider block changed after installation`);
        return prior;
      }
      content = removeOwnedBlock(content);
    } else content = removeOwnedBlock(content);
  }
  const parsed = content.trim() ? parseToml(content) as Record<string, any> : {};
  const originalProviderName = typeof parsed.model_provider === "string" ? parsed.model_provider : "openai";
  const provider = structuredClone(parsed.model_providers?.[originalProviderName] ?? {});
  assertNoStaticProviderCredentials(provider, path, originalProviderName);
  const originalBase = typeof provider.base_url === "string" ? provider.base_url : config.harnesses.codex.originalUpstream.baseUrl;
  assertCredentialFreeUrl(originalBase, `${path} provider ${originalProviderName} base_url`);
  config.harnesses.codex.originalUpstream.baseUrl = originalBase;
  provider.name = "subagent-model-router";
  provider.base_url = `http://${config.gateway.host}:${config.gateway.port}/codex/v1`;
  provider.wire_api = "responses";
  const scalars = prior?.scalars ?? [];
  const modelProvider = setTopLevelScalar(content, "model_provider", 'model_provider = "subagent-model-router"', scalars);
  content = modelProvider.content;
  const catalogPath = config.harnesses.codex.overlayCatalogPath!;
  const catalog = setTopLevelScalar(content, "model_catalog_json", `model_catalog_json = ${JSON.stringify(catalogPath)}`, scalars);
  content = catalog.content;
  const serialized = stringifyToml({ model_providers: { "subagent-model-router": provider } }).trim();
  const block = `${BLOCK_START}\n${serialized}\n${BLOCK_END}`;
  content = `${content.trimEnd()}\n\n${block}\n`;
  await atomicWriteFile(path, content, 0o600);
  return { path, existed: prior?.existed ?? existed, scalars, blockHash: hash(block) };
}

function setTopLevelScalar(content: string, key: string, installedLine: string, mutations: ScalarMutation[]): { content: string } {
  const existingMutation = mutations.find((item) => item.key === key);
  const lines = content.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable === -1 ? lines.length : firstTable;
  const index = lines.slice(0, limit).findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (!existingMutation) mutations.push({ key, ...(index >= 0 ? { originalLine: lines[index] } : {}), installedLine });
  if (index >= 0) lines[index] = installedLine;
  else lines.splice(0, 0, installedLine);
  return { content: lines.join("\n") };
}

async function uninstallCodexConfig(mutation: CodexMutation, force: boolean, conflicts: string[]): Promise<boolean> {
  if (!await exists(mutation.path)) return false;
  let content = await readFile(mutation.path, "utf8");
  const block = extractOwnedBlock(content);
  if (block && hash(block) !== mutation.blockHash && !force) {
    conflicts.push(`${mutation.path}: owned Codex provider block changed after installation`);
    return false;
  }
  content = removeOwnedBlock(content);
  for (const scalar of mutation.scalars) {
    const lines = content.split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() === scalar.installedLine.trim());
    if (index < 0) {
      if (!force) {
        conflicts.push(`${mutation.path}: ${scalar.key} changed after installation`);
        return false;
      }
      const loose = lines.findIndex((line) => new RegExp(`^\\s*${scalar.key}\\s*=`).test(line));
      if (loose >= 0) lines.splice(loose, 1);
    } else if (scalar.originalLine !== undefined) lines[index] = scalar.originalLine;
    else lines.splice(index, 1);
    content = lines.join("\n");
  }
  if (!mutation.existed && !content.trim()) await unlink(mutation.path);
  else await atomicWriteFile(mutation.path, `${content.trimEnd()}\n`, 0o600);
  return true;
}

async function normalizeCustomAgent(config: RouterConfig, agent: DiscoveredAgent, force: boolean, conflicts: string[]): Promise<boolean> {
  const path = agent.path!;
  const route = config.routes.codex[agent.name];
  if (!route?.alias) return false;
  const preserved = config.preserved.customCodexAgents[path];
  const current = await readFile(path, "utf8");
  if (preserved) {
    if (preserved.alias !== route.alias) {
      conflicts.push(`${path}: route alias changed from ${preserved.alias} to ${route.alias}; uninstall before changing a normalized alias`);
      return false;
    }
    if (hash(current) !== preserved.installedContentHash && !force) {
      conflicts.push(`${path}: custom agent changed after normalization`);
      return false;
    }
    if (hash(current) !== preserved.installedContentHash && force) {
      const rewritten = replaceTopLevelModel(current, route.alias);
      preserved.installedContentHash = hash(rewritten.content);
      if (rewritten.installedModelLine) preserved.installedModelLine = rewritten.installedModelLine;
      if (rewritten.modelOffset !== undefined) preserved.modelOffset = rewritten.modelOffset;
      await atomicWriteFile(path, rewritten.content);
      return true;
    }
    return false;
  }
  const replacement = replaceTopLevelModel(current, route.alias);
  if (!replacement.originalModel) return false;
  const installed = replacement.content;
  config.preserved.customCodexAgents[path] = {
    agentType: agent.name,
    path,
    alias: route.alias,
    originalModel: replacement.originalModel,
    originalModelLine: replacement.originalModelLine!,
    installedModelLine: replacement.installedModelLine!,
    modelOffset: replacement.modelOffset!,
    originalContentHash: hash(current),
    installedContentHash: hash(installed),
  };
  await atomicWriteFile(path, installed);
  return true;
}

function replaceTopLevelModel(content: string, alias: string): { content: string; originalModel?: string; originalModelLine?: string; installedModelLine?: string; modelOffset?: number } {
  const firstTable = content.search(/^\s*\[/m);
  const limit = firstTable < 0 ? content.length : firstTable;
  const prefix = content.slice(0, limit);
  const match = /^([ \t]*model[ \t]*=[ \t]*)(["'])([^\r\n"']+)\2[ \t]*$/m.exec(prefix);
  if (!match) return { content };
  const installedModelLine = `${match[1]}${match[2]}${alias}${match[2]}`;
  return {
    content: `${content.slice(0, match.index)}${installedModelLine}${content.slice(match.index + match[0].length)}`,
    originalModel: match[3]!,
    originalModelLine: match[0],
    installedModelLine,
    modelOffset: match.index,
  };
}

function restoreCustomModel(current: string, preserved: RouterConfig["preserved"]["customCodexAgents"][string], force: boolean): string {
  if (current.slice(preserved.modelOffset, preserved.modelOffset + preserved.installedModelLine.length) === preserved.installedModelLine) {
    return `${current.slice(0, preserved.modelOffset)}${preserved.originalModelLine}${current.slice(preserved.modelOffset + preserved.installedModelLine.length)}`;
  }
  if (!force) return current;
  const firstTable = current.search(/^\s*\[/m);
  const limit = firstTable < 0 ? current.length : firstTable;
  const match = /^[ \t]*model[ \t]*=[^\r\n]*$/m.exec(current.slice(0, limit));
  if (!match) return current;
  return `${current.slice(0, match.index)}${preserved.originalModelLine}${current.slice(match.index + match[0].length)}`;
}

function selectCodexAgent(agents: DiscoveredAgent[], name: string): DiscoveredAgent | undefined {
  return agents.find((agent) => agent.harness === "codex" && agent.name === name && agent.kind === "project")
    ?? agents.find((agent) => agent.harness === "codex" && agent.name === name && agent.kind === "user");
}

function extractOwnedBlock(content: string): string | undefined {
  return extractOwnedBlockWithMarkers(content, BLOCK_START, BLOCK_END);
}

function extractOwnedBlockWithMarkers(content: string, start: string, end: string): string | undefined {
  return new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`).exec(content)?.[0];
}

function removeOwnedBlock(content: string): string {
  return content.replace(new RegExp(`\\n?${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\n?`), "\n");
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function installStatePath(configPath: string): string { return resolve(dirname(configPath), "install-state.json"); }
async function readState(path: string): Promise<InstallState> { return await exists(path) ? JSON.parse(await readFile(path, "utf8")) as InstallState : { version: 1 }; }

function assertCredentialFreeUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => /key|token|secret|password/i.test(key))) {
    throw new Error(`${label} contains inline credentials; move them to an environment-variable reference before installing`);
  }
}

function assertNoStaticProviderCredentials(provider: Record<string, any>, path: string, providerName: string): void {
  const staticHeaders = provider.http_headers;
  if (staticHeaders && typeof staticHeaders === "object" && Object.keys(staticHeaders).some((name) => /authorization|api[-_]?key|token|secret|password/i.test(name))) {
    throw new Error(`${path} provider ${providerName} contains a static credential header; use env_key or env_http_headers before installing`);
  }
  if (Object.keys(provider).some((name) => /bearer_token|access_token|api_key|password|secret/i.test(name) && name !== "env_key")) {
    throw new Error(`${path} provider ${providerName} contains a static credential field; use an environment-backed provider field before installing`);
  }
}
