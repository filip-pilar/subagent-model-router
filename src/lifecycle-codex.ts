import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { overlayCatalog, type ModelCatalog } from "./catalog.js";
import { atomicWriteFile, exists } from "./files.js";
import {
  assertCredentialFreeUrl,
  assertNoStaticProviderCredentials,
  BLOCK_END,
  BLOCK_START,
  extractOwnedBlock,
  hash,
  removeOwnedBlock,
  type CodexMutation,
  type ScalarMutation,
} from "./lifecycle-state.js";
import type { DiscoveredAgent, RouterConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export async function adoptConfiguredCatalog(config: RouterConfig, codexConfigPath: string): Promise<void> {
  if (config.harnesses.codex.sourceCatalogPath || !await exists(codexConfigPath)) return;
  const parsed = parseToml(await readFile(codexConfigPath, "utf8")) as Record<string, unknown>;
  if (typeof parsed.model_catalog_json === "string") {
    config.harnesses.codex.sourceCatalogPath = resolve(dirname(codexConfigPath), parsed.model_catalog_json);
  }
}

export async function writeCatalogOverlay(config: RouterConfig): Promise<void> {
  const sourcePath = config.harnesses.codex.sourceCatalogPath;
  const targetPath = config.harnesses.codex.overlayCatalogPath;
  if (!sourcePath || !targetPath) throw new Error("Codex sourceCatalogPath and overlayCatalogPath are required");
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as ModelCatalog;
  const result = overlayCatalog(source, config);
  await atomicWriteFile(targetPath, `${JSON.stringify(result, null, 2)}\n`, 0o600);
}

export async function ensureSourceCatalog(config: RouterConfig, configPath: string, codexBinary: string | undefined, home: string): Promise<void> {
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

export async function installCodexConfig(
  path: string,
  config: RouterConfig,
  prior: CodexMutation | undefined,
  force: boolean,
  conflicts: string[],
): Promise<CodexMutation> {
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

export async function uninstallCodexConfig(mutation: CodexMutation, force: boolean, conflicts: string[]): Promise<boolean> {
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

export async function normalizeCustomAgent(config: RouterConfig, agent: DiscoveredAgent, force: boolean, conflicts: string[]): Promise<boolean> {
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

export function restoreCustomModel(current: string, preserved: RouterConfig["preserved"]["customCodexAgents"][string], force: boolean): string {
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

export function selectCodexAgent(agents: DiscoveredAgent[], name: string): DiscoveredAgent | undefined {
  return agents.find((agent) => agent.harness === "codex" && agent.name === name && agent.kind === "project")
    ?? agents.find((agent) => agent.harness === "codex" && agent.name === name && agent.kind === "user");
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
