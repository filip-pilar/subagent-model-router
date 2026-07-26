import { access, mkdir, readFile, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { defaultGlobalConfig, loadConfig, parseConfig, saveConfig } from "./config.js";
import { discover } from "./discovery.js";
import { atomicWriteFile, exists } from "./files.js";
import { installIntegration, integrationStatus, migrateLegacyIntegration, uninstallHarnessIntegration, uninstallIntegration, type InstallOptions } from "./lifecycle.js";
import type { Harness, RouterConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const DATA_DIRECTORY_NAME = "subagent-model-router";
const LEGACY_DATA_DIRECTORY_NAME = "harness-model-router";

export interface AppPaths {
  dataDirectory: string;
  config: string;
  helper: string;
  log: string;
}

export interface HarnessDetection {
  detected: boolean;
  version?: string;
  cliPath?: string;
  appPath?: string;
}

export function appPaths(home = homedir()): AppPaths {
  const dataDirectory = resolve(home, ".local/share", DATA_DIRECTORY_NAME);
  return {
    dataDirectory,
    config: resolve(dataDirectory, "config.json"),
    helper: resolve(dataDirectory, "bin/subagent-model-router-helper"),
    log: resolve(dataDirectory, "menu-app.log"),
  };
}

export async function ensureGlobalConfig(path: string, _home = homedir()): Promise<RouterConfig> {
  if (resolve(path) === appPaths(_home).config) {
    const legacyDataDirectory = resolve(_home, ".local/share", LEGACY_DATA_DIRECTORY_NAME);
    const moves: LegacyMove[] = [];
    try {
      await mergeLegacyDataDirectory(legacyDataDirectory, dirname(path), moves);
      await migrateLegacyIntegration(path, legacyDataDirectory, dirname(path));
    } catch (error) {
      await rollbackLegacyMoves(moves);
      throw error;
    }
  }
  if (!await exists(path)) {
    const config = defaultGlobalConfig(dirname(path));
    await saveConfig(path, config);
    return config;
  }
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const config = parseConfig(raw);
  if (isRecordVersion(raw) !== 2) await saveConfig(path, config);
  return config;
}

interface LegacyMove { source: string; target: string }

async function mergeLegacyDataDirectory(source: string, target: string, moves: LegacyMove[]): Promise<void> {
  if (!await exists(source)) return;
  if (!await exists(target)) {
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    moves.push({ source, target });
    return;
  }
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);
    if (!await exists(to)) {
      await rename(from, to);
      moves.push({ source: from, target: to });
    } else if (entry.isDirectory() && (await stat(to)).isDirectory()) {
      await mergeLegacyDataDirectory(from, to, moves);
    } else {
      throw new Error(`Cannot migrate legacy router data because ${to} already exists`);
    }
  }
  await rmdir(source);
}

async function rollbackLegacyMoves(moves: LegacyMove[]): Promise<void> {
  for (const move of [...moves].reverse()) {
    if (!await exists(move.target)) continue;
    await mkdir(dirname(move.source), { recursive: true });
    await rename(move.target, move.source);
  }
}

function isRecordVersion(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).version : undefined;
}

export async function appState(configPath: string, home = homedir()): Promise<Record<string, unknown>> {
  const config = await ensureGlobalConfig(configPath, home);
  const [integration, detection, discovery] = await Promise.all([
    integrationStatus(configPath),
    detectHarnesses(home),
    discover({ home, globalOnly: true, config }),
  ]);
  return { config, integration, detection, agents: discovery.agents, codexCatalog: discovery.codexCatalog, codexParentModel: await configuredCodexParentModel(home, config) };
}

async function configuredCodexParentModel(home: string, config: RouterConfig): Promise<string | undefined> {
  const path = config.harnesses.codex.configPath ?? resolve(home, ".codex/config.toml");
  if (!await exists(path)) return undefined;
  try {
    const parsed = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
    return typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : undefined;
  } catch { return undefined; }
}

export async function detectHarnesses(home = homedir()): Promise<{ claude: HarnessDetection; codex: HarnessDetection }> {
  const [claudePath, pathCodex, codexApp] = await Promise.all([
    findExecutable("claude", home),
    findExecutable("codex", home),
    findApplication("Codex.app", home),
  ]);
  const codexPath = pathCodex ?? (codexApp ? await findBundledCodex(codexApp) : undefined);
  const [claudeVersion, codexVersion, appVersion] = await Promise.all([
    claudePath ? executableVersion(claudePath) : undefined,
    codexPath ? executableVersion(codexPath) : undefined,
    codexApp ? applicationVersion(codexApp) : undefined,
  ]);
  const effectiveCodexVersion = codexVersion ?? appVersion;
  return {
    claude: { detected: Boolean(claudePath), ...(claudePath ? { cliPath: claudePath } : {}), ...(claudeVersion ? { version: claudeVersion } : {}) },
    codex: { detected: Boolean(codexPath || codexApp), ...(codexPath ? { cliPath: codexPath } : {}), ...(codexApp ? { appPath: codexApp } : {}), ...(effectiveCodexVersion ? { version: effectiveCodexVersion } : {}) },
  };
}

async function findBundledCodex(app: string): Promise<string | undefined> {
  const known = [
    resolve(app, "Contents/Resources/codex"),
    resolve(app, "Contents/Resources/bin/codex"),
    resolve(app, "Contents/MacOS/codex"),
  ];
  for (const candidate of known) try { await access(candidate, constants.X_OK); return candidate; } catch { /* search below */ }
  return findExecutableNamed(resolve(app, "Contents/Resources"), "codex", 5);
}

async function findExecutableNamed(directory: string, name: string, depth: number): Promise<string | undefined> {
  if (depth < 0 || !await exists(directory)) return undefined;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isFile() && entry.name === name) try { await access(path, constants.X_OK); return path; } catch { /* continue */ }
    if (entry.isDirectory()) { const nested = await findExecutableNamed(path, name, depth - 1); if (nested) return nested; }
  }
  return undefined;
}

export async function setupHarness(configPath: string, harness: Harness, helperPath: string, home = homedir(), force = false): Promise<unknown> {
  const detection = await detectHarnesses(home);
  if (!detection[harness].detected) throw new Error(`${harness === "claude" ? "Claude Code" : "Codex"} is not detected`);
  const previous = await ensureGlobalConfig(configPath, home);
  const snapshots = await snapshotFiles(await setupTransactionPaths(configPath, home, harness, previous));
  const config = structuredClone(previous);
  config.harnesses[harness].enabled = true;
  await saveConfig(configPath, config);
  const options: InstallOptions = { home, helperPath, force, ...(detection.codex.cliPath ? { codexBinary: detection.codex.cliPath } : {}) };
  try {
    const result = await installIntegration(configPath, options);
    if (result.conflicts.length > 0) throw new Error(result.conflicts.join("\n"));
    return result;
  } catch (error) {
    await restoreSnapshots(snapshots);
    throw error;
  }
}

interface FileSnapshot { path: string; content?: Buffer; mode?: number }

async function setupTransactionPaths(configPath: string, home: string, harness: Harness, config: RouterConfig): Promise<string[]> {
  const paths = [configPath, resolve(dirname(configPath), "install-state.json")];
  if (harness === "claude") paths.push(config.harnesses.claude.settingsPath ?? resolve(home, ".claude/settings.json"));
  else {
    paths.push(
      config.harnesses.codex.hooksPath ?? resolve(home, ".codex/hooks.json"),
      config.harnesses.codex.configPath ?? resolve(home, ".codex/config.toml"),
      config.harnesses.codex.overlayCatalogPath ?? resolve(dirname(configPath), "codex-model-catalog.json"),
      resolve(dirname(configPath), "codex-source-catalog.json"),
    );
    const discovered = await discover({ home, globalOnly: true, config });
    for (const agent of discovered.agents) if (agent.harness === "codex" && agent.kind === "user" && agent.path) paths.push(agent.path);
  }
  return [...new Set(paths)];
}

async function snapshotFiles(paths: string[]): Promise<FileSnapshot[]> {
  return Promise.all(paths.map(async (path): Promise<FileSnapshot> => {
    if (!await exists(path)) return { path };
    const metadata = await stat(path);
    return { path, content: await readFile(path), mode: metadata.mode & 0o777 };
  }));
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.content) await atomicWriteFile(snapshot.path, snapshot.content.toString("utf8"), snapshot.mode ?? 0o600);
    else if (await exists(snapshot.path)) await unlink(snapshot.path);
  }
}

export async function removeHarness(configPath: string, harness: Harness, force = false): Promise<unknown> {
  return uninstallHarnessIntegration(configPath, harness, force);
}

export async function replaceAppConfig(configPath: string, raw: unknown, helperPath: string, home = homedir()): Promise<RouterConfig> {
  const previous = await ensureGlobalConfig(configPath, home);
  const next = parseConfig(raw);
  next.gateway.host = "127.0.0.1";
  next.gateway.port = 9476;
  const status = await integrationStatus(configPath);
  await saveConfig(configPath, next);
  try {
    if (status.claude || status.codex) {
      const detection = await detectHarnesses(home);
      const result = await installIntegration(configPath, { home, helperPath, ...(detection.codex.cliPath ? { codexBinary: detection.codex.cliPath } : {}) });
      if (result.conflicts.length > 0) throw new Error(result.conflicts.join("\n"));
    }
    return await loadConfig(configPath);
  } catch (error) {
    await saveConfig(configPath, previous);
    try {
      const detection = await detectHarnesses(home);
      await installIntegration(configPath, { home, helperPath, ...(detection.codex.cliPath ? { codexBinary: detection.codex.cliPath } : {}) });
    } catch { /* preserve the original application error */ }
    throw error;
  }
}

export async function resetEverything(configPath: string, _home = homedir(), force = false): Promise<unknown> {
  void _home;
  const result = await uninstallIntegration(configPath, force);
  if (result.conflicts.length > 0 && !force) return result;
  await saveConfig(configPath, defaultGlobalConfig(dirname(configPath)));
  return result;
}

async function findExecutable(name: string, home: string): Promise<string | undefined> {
  const pathCandidates = (process.env.PATH ?? "").split(":").filter(Boolean).map((directory) => resolve(directory, name));
  const homeCandidate = resolve(home, ".local/bin", name);
  const testHomeOnly = process.env.SMR_TEST_HOME_ONLY ?? process.env.HMR_TEST_HOME_ONLY;
  const candidates = testHomeOnly === "1" ? [homeCandidate] : [homeCandidate, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, ...pathCandidates];
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

async function findApplication(name: string, home: string): Promise<string | undefined> {
  const homeCandidate = resolve(home, "Applications", name);
  const testHomeOnly = process.env.SMR_TEST_HOME_ONLY ?? process.env.HMR_TEST_HOME_ONLY;
  const candidates = testHomeOnly === "1" ? [homeCandidate] : [`/Applications/${name}`, homeCandidate];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return undefined;
}

async function executableVersion(path: string): Promise<string | undefined> {
  try { return (await execFileAsync(path, ["--version"], { timeout: 3_000 })).stdout.trim(); } catch { return undefined; }
}

async function applicationVersion(path: string): Promise<string | undefined> {
  try {
    const plist = resolve(path, "Contents/Info.plist");
    return (await execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist], { timeout: 3_000 })).stdout.trim();
  } catch {
    try {
      const raw = await readFile(resolve(path, "Contents/Info.plist"), "utf8");
      return raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    } catch { return undefined; }
  }
}
