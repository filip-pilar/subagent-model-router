import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { DiscoveredAgent, DiscoveryResult, RouterConfig } from "./types.js";
import type { ModelCatalog } from "./catalog.js";
import { exists } from "./files.js";

const CLAUDE_BUILT_INS = ["general-purpose", "Explore", "Plan"];
const CODEX_BUILT_INS = ["default", "worker", "explorer"];
const CODEX_ROUTER_OWNED_KEYS = ["model_provider", "model_providers", "model_catalog_json"] as const;

export interface DiscoveryOptions {
  home: string;
  config?: RouterConfig;
}

export async function discover(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const agents: DiscoveredAgent[] = [
    ...CLAUDE_BUILT_INS.map((name): DiscoveredAgent => ({ harness: "claude", name, kind: "built-in" })),
    ...CODEX_BUILT_INS.map((name): DiscoveredAgent => ({ harness: "codex", name, kind: "built-in" })),
  ];
  await discoverClaudeDirectory(resolve(options.home, ".claude/agents"), agents);
  const codexConfigPath = options.config?.harnesses.codex.configPath ?? resolve(options.home, ".codex/config.toml");
  await discoverConfiguredCodexAgents(codexConfigPath, agents);
  await discoverCodexDirectory(resolve(options.home, ".codex/agents"), agents);
  const catalogPath = options.config?.harnesses.codex.sourceCatalogPath;
  const result: DiscoveryResult = { agents: deduplicate(agents) };
  if (catalogPath && await exists(catalogPath)) {
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as ModelCatalog;
    result.codexCatalog = {
      path: catalogPath,
      models: catalog.models.map((model) => ({ slug: model.slug, ...(model.multi_agent_version ? { multiAgentVersion: model.multi_agent_version } : {}), ...(model.visibility ? { visibility: model.visibility } : {}) })),
    };
  }
  return result;
}

async function discoverClaudeDirectory(directory: string, output: DiscoveredAgent[]): Promise<void> {
  for (const path of await filesUnder(directory, ".md", 1)) {
    await discoverClaudeFile(path, output);
  }
}

async function discoverClaudeFile(path: string, output: DiscoveredAgent[]): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    const metadata = frontmatter ? parseYaml(frontmatter) as Record<string, unknown> : {};
    const name = typeof metadata.name === "string" ? metadata.name : basename(path, ".md");
    output.push({ harness: "claude", name, kind: "user", path });
  } catch { /* malformed agents are discoverable only after users fix them */ }
}

async function discoverCodexDirectory(directory: string, output: DiscoveredAgent[]): Promise<void> {
  for (const path of (await filesUnder(directory, ".toml", 1)).sort()) {
    await discoverCodexFile(path, output);
  }
}

interface CodexAgentRegistration {
  nameHint: string;
  description?: string;
  nicknameCandidates?: unknown;
  validShape: boolean;
}

async function discoverConfiguredCodexAgents(configPath: string, output: DiscoveredAgent[]): Promise<void> {
  if (!await exists(configPath)) return;
  try {
    const parsed = parseToml(await readFile(configPath, "utf8")) as Record<string, any>;
    if (!parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents)) return;
    for (const [name, registration] of Object.entries(parsed.agents)) {
      if (!registration || typeof registration !== "object" || Array.isArray(registration)) continue;
      const values = registration as Record<string, unknown>;
      const configFile = values.config_file;
      if (typeof configFile !== "string" || configFile.trim().length === 0) continue;
      await discoverCodexFile(resolve(dirname(configPath), configFile), output, {
        nameHint: name,
        ...(typeof values.description === "string" ? { description: values.description } : {}),
        ...(values.nickname_candidates !== undefined ? { nicknameCandidates: values.nickname_candidates } : {}),
        validShape: Object.keys(values).every((key) => ["description", "config_file", "nickname_candidates"].includes(key))
          && (values.description === undefined || typeof values.description === "string")
          && validNicknameCandidates(values.nickname_candidates),
      });
    }
  } catch { /* malformed Codex configuration is reported by setup */ }
}

async function discoverCodexFile(
  path: string,
  output: DiscoveredAgent[],
  registration?: CodexAgentRegistration,
): Promise<void> {
  try {
    const metadata = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
    const fileName = nonBlankString(metadata.name);
    const registeredName = nonBlankString(registration?.nameHint);
    const name = fileName ?? registeredName ?? basename(path, ".toml");
    const description = nonBlankString(metadata.description) ?? nonBlankString(registration?.description);
    const developerInstructions = nonBlankString(metadata.developer_instructions);
    const explicitModel = nonBlankString(metadata.model);
    const validFileName = metadata.name === undefined || fileName !== undefined;
    const validDescription = metadata.description === undefined || nonBlankString(metadata.description) !== undefined;
    const validDeveloperInstructions = metadata.developer_instructions === undefined || developerInstructions !== undefined;
    const effectiveNicknames = metadata.nickname_candidates ?? registration?.nicknameCandidates;
    const codexV2Eligible = explicitModel !== undefined
      && description !== undefined
      && validFileName
      && validDescription
      && validDeveloperInstructions
      && validCodexRoleShape(metadata)
      && validNicknameCandidates(effectiveNicknames)
      && (registration?.validShape ?? true)
      && (registration !== undefined
        ? fileName !== undefined || registeredName !== undefined
        : fileName !== undefined && developerInstructions !== undefined);
    output.push({
      harness: "codex",
      name,
      kind: "user",
      path,
      ...(explicitModel ? { explicitModel } : {}),
      ...(codexV2Eligible ? { codexV2Eligible: true } : {}),
    });
  } catch { /* validation reports malformed files elsewhere */ }
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validNicknameCandidates(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  const normalized = value.map(nonBlankString);
  if (normalized.some((item) => item === undefined)) return false;
  const nicknames = normalized as string[];
  return new Set(nicknames).size === nicknames.length
    && nicknames.every((item) => /^[A-Za-z0-9 _-]+$/.test(item));
}

function validCodexRoleShape(metadata: Record<string, unknown>): boolean {
  if (codexRoutingOverrideKeys(metadata).length > 0) return false;
  if (metadata.model !== undefined && typeof metadata.model !== "string") return false;
  if (metadata.model_reasoning_effort !== undefined && nonBlankString(metadata.model_reasoning_effort) === undefined) return false;
  if (!validOptionalStringEnum(metadata.sandbox_mode, ["read-only", "workspace-write", "danger-full-access"])) return false;
  if (!validOptionalStringEnum(metadata.model_reasoning_summary, ["none", "auto", "concise", "detailed"])) return false;
  if (!validOptionalStringEnum(metadata.model_verbosity, ["low", "medium", "high"])) return false;
  if (!validOptionalStringEnum(metadata.personality, ["none", "friendly", "pragmatic"])) return false;
  return true;
}

export function codexRoutingOverrideKeys(metadata: Record<string, unknown>): string[] {
  return CODEX_ROUTER_OWNED_KEYS.filter((key) => metadata[key] !== undefined);
}

function validOptionalStringEnum(value: unknown, allowed: string[]): boolean {
  return value === undefined || (typeof value === "string" && allowed.includes(value));
}

async function filesUnder(directory: string, extension: string, depth: number): Promise<string[]> {
  if (depth < 0 || !await exists(directory)) return [];
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path, extension, depth - 1));
    else if (entry.isFile() && extname(entry.name) === extension) output.push(path);
  }
  return output;
}

function deduplicate(agents: DiscoveredAgent[]): DiscoveredAgent[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    const key = agent.harness === "codex" && agent.kind === "user"
      ? `${agent.harness}:user:${agent.name}`
      : `${agent.harness}:${agent.kind}:${agent.path ?? agent.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
