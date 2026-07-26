import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { discover } from "./discovery.js";
import { atomicWriteFile, exists } from "./files.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  adoptConfiguredCatalog,
  ensureSourceCatalog,
  installCodexConfig,
  normalizeCustomAgent,
  restoreCustomModel,
  selectCodexAgent,
  uninstallCodexConfig,
  writeCatalogOverlay,
} from "./lifecycle-codex.js";
import {
  hookExists,
  installClaudeSettings,
  installCodexHooks,
  replaceHookCommand,
  uninstallJsonMutation,
} from "./lifecycle-json.js";
import {
  extractOwnedBlock,
  extractOwnedBlockWithMarkers,
  hash,
  installStatePath,
  LEGACY_BLOCK_END,
  LEGACY_BLOCK_START,
  LEGACY_SERVICE_NAME,
  readInstallState,
  SERVICE_NAME,
} from "./lifecycle-state.js";

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
  const state = await readInstallState(statePath);
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
  const state = await readInstallState(installStatePath(configPath));
  return { claude: Boolean(state.claude), codex: Boolean(state.codexHooks || state.codexConfig) };
}

export async function migrateLegacyIntegration(configPath: string, legacyDataDirectory: string, dataDirectory: string): Promise<boolean> {
  if (!await exists(configPath)) return false;
  const config = await loadConfig(configPath);
  const statePath = installStatePath(configPath);
  const state = await readInstallState(statePath);
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

export async function uninstallHarnessIntegration(configPath: string, harness: "claude" | "codex", force = false): Promise<LifecycleResult> {
  const config = await loadConfig(configPath);
  const statePath = installStatePath(configPath);
  const state = await readInstallState(statePath);
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

export async function uninstallIntegration(configPath: string, force = false): Promise<LifecycleResult> {
  const config = await loadConfig(configPath);
  const statePath = installStatePath(configPath);
  const state = await readInstallState(statePath);
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

export { writeCatalogOverlay };
