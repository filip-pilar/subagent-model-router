import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "./files.js";
import type { Destination, Harness, Protocol, Route, RouterConfig, Upstream } from "./types.js";

export const DEFAULT_CONFIG_NAME = "config.json";

export function defaultConfig(root: string): RouterConfig {
  const dataDir = resolve(root, ".subagent-model-router");
  return {
    version: 2,
    gateway: { enabled: true, host: "127.0.0.1", port: 9476, maxBodyBytes: 16 * 1024 * 1024 },
    destinations: {},
    harnesses: {
      claude: {
        enabled: false,
        originalUpstream: { baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages" },
        mappingTtlMs: 30 * 60 * 1000,
      },
      codex: {
        enabled: false,
        originalUpstream: { baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" },
        hookTimeoutMs: 1_500,
        overlayCatalogPath: resolve(dataDir, "codex-model-catalog.json"),
        parentModels: [],
      },
    },
    routes: { claude: {}, codex: {} },
    preserved: { customCodexAgents: {} },
  };
}

export async function loadConfig(path: string): Promise<RouterConfig> {
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(value);
}

export function parseConfig(value: unknown): RouterConfig {
  const migrated = migrateConfig(value);
  const issues = validateConfig(migrated);
  if (issues.length > 0) throw new Error(`Invalid router configuration:\n- ${issues.join("\n- ")}`);
  return migrated as RouterConfig;
}

export function defaultGlobalConfig(dataDirectory: string): RouterConfig {
  const config = defaultConfig(dirname(dataDirectory));
  config.harnesses.codex.overlayCatalogPath = resolve(dataDirectory, "codex-model-catalog.json");
  return config;
}

export async function saveConfig(path: string, config: RouterConfig): Promise<void> {
  const issues = validateConfig(config);
  if (issues.length > 0) throw new Error(`Invalid router configuration:\n- ${issues.join("\n- ")}`);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function validateConfig(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["configuration must be an object"];
  if (value.version !== 2) issues.push("version must be 2");
  const gateway = value.gateway;
  if (!isRecord(gateway)) issues.push("gateway must be an object");
  else {
    if (typeof gateway.enabled !== "boolean") issues.push("gateway.enabled must be boolean");
    if (gateway.host !== "127.0.0.1") issues.push("gateway.host must be 127.0.0.1");
    if (gateway.port !== 9476) issues.push("gateway.port must be 9476");
    if (!Number.isInteger(gateway.maxBodyBytes) || Number(gateway.maxBodyBytes) < 1024) issues.push("gateway.maxBodyBytes must be an integer >= 1024");
  }
  const destinations = value.destinations;
  if (!isRecord(destinations)) issues.push("destinations must be an object");
  else for (const [id, destination] of Object.entries(destinations)) validateDestination(destination, `destinations.${id}`, issues);
  const harnesses = value.harnesses;
  if (!isRecord(harnesses)) issues.push("harnesses must be an object");
  else {
    validateHarness(harnesses.claude, "claude", "anthropic-messages", issues);
    validateHarness(harnesses.codex, "codex", "openai-responses", issues);
    if (isRecord(harnesses.claude) && (!Number.isFinite(harnesses.claude.mappingTtlMs) || Number(harnesses.claude.mappingTtlMs) < 100)) issues.push("harnesses.claude.mappingTtlMs must be >= 100");
    if (isRecord(harnesses.codex)) {
      if (!Number.isFinite(harnesses.codex.hookTimeoutMs) || Number(harnesses.codex.hookTimeoutMs) < 50 || Number(harnesses.codex.hookTimeoutMs) > 10_000) issues.push("harnesses.codex.hookTimeoutMs must be between 50 and 10000");
      if (!Array.isArray(harnesses.codex.parentModels) || !harnesses.codex.parentModels.every((item) => typeof item === "string" && item.length > 0)) issues.push("harnesses.codex.parentModels must be an array of model slugs");
    }
  }
  const routes = value.routes;
  if (!isRecord(routes)) issues.push("routes must be an object");
  else {
    validateRoutes(routes.claude, "claude", issues);
    validateRoutes(routes.codex, "codex", issues);
    const codexRoutes = isRecord(routes.codex) ? Object.values(routes.codex) : [];
    const requiresV1 = codexRoutes.some((route) => isRecord(route)
      && route.enabled === true
      && route.requiredMultiAgentVersion === "v1"
      && hasUsableCodexUpstream(route, destinations));
    const parentModels = isRecord(harnesses) && isRecord(harnesses.codex) ? harnesses.codex.parentModels : undefined;
    if (requiresV1 && (!Array.isArray(parentModels) || parentModels.length === 0)) issues.push("enabled Codex V1 routes require at least one harnesses.codex.parentModels entry");
  }
  if (!isRecord(value.preserved) || !isRecord(value.preserved.customCodexAgents)) issues.push("preserved.customCodexAgents must be an object");
  return issues;
}

function hasUsableCodexUpstream(route: Record<string, any>, destinations: unknown): boolean {
  if (isRecord(route.upstream)) return typeof route.upstream.baseUrl === "string" && route.upstream.baseUrl.trim().length > 0;
  if (typeof route.destination !== "string" || !isRecord(destinations)) return false;
  const destination = destinations[route.destination];
  return isRecord(destination) && typeof destination.openaiBaseUrl === "string" && destination.openaiBaseUrl.trim().length > 0;
}

function validateHarness(value: unknown, name: string, protocol: Protocol, issues: string[]): void {
  if (!isRecord(value)) return void issues.push(`harnesses.${name} must be an object`);
  if (typeof value.enabled !== "boolean") issues.push(`harnesses.${name}.enabled must be boolean`);
  validateUpstream(value.originalUpstream, `harnesses.${name}.originalUpstream`, protocol, issues);
}

function validateRoutes(value: unknown, harness: string, issues: string[]): void {
  if (!isRecord(value)) return void issues.push(`routes.${harness} must be an object`);
  const aliases = new Set<string>();
  for (const [agent, candidate] of Object.entries(value)) {
    if (!agent.trim()) issues.push(`routes.${harness} has an empty agent name`);
    if (!isRecord(candidate)) {
      issues.push(`routes.${harness}.${agent} must be an object`);
      continue;
    }
    if (typeof candidate.enabled !== "boolean") issues.push(`routes.${harness}.${agent}.enabled must be boolean`);
    if (typeof candidate.model !== "string" || !candidate.model.trim()) issues.push(`routes.${harness}.${agent}.model must be a non-empty string`);
    if (typeof candidate.destination !== "string" || !candidate.destination.trim()) {
      const expected = harness === "claude" ? "anthropic-messages" : "openai-responses";
      if (candidate.upstream !== undefined) validateUpstream(candidate.upstream, `routes.${harness}.${agent}.upstream`, expected, issues);
      else issues.push(`routes.${harness}.${agent}.destination must be a non-empty destination id`);
    }
    validateAuthorization(candidate.authorization, `routes.${harness}.${agent}.authorization`, issues);
    if (harness === "codex") {
      if (typeof candidate.alias !== "string" || !/^router-[a-z0-9][a-z0-9-]*$/.test(candidate.alias)) issues.push(`routes.codex.${agent}.alias must match router-[a-z0-9-]+`);
      else if (aliases.has(candidate.alias)) issues.push(`routes.codex alias ${candidate.alias} is duplicated`);
      else aliases.add(candidate.alias);
      if (candidate.requiredMultiAgentVersion !== undefined && candidate.requiredMultiAgentVersion !== "v1") issues.push(`routes.codex.${agent}.requiredMultiAgentVersion supports only v1`);
    } else if (candidate.requiredMultiAgentVersion !== undefined) issues.push(`routes.claude.${agent} cannot require Codex multi-agent metadata`);
  }
}

function validateDestination(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) return void issues.push(`${path} must be an object`);
  if (typeof value.name !== "string" || !value.name.trim()) issues.push(`${path}.name must be a non-empty string`);
  const openai = validateOptionalUrl(value.openaiBaseUrl, `${path}.openaiBaseUrl`, issues);
  const anthropic = validateOptionalUrl(value.anthropicBaseUrl, `${path}.anthropicBaseUrl`, issues);
  if (!openai && !anthropic) issues.push(`${path} must define at least one protocol URL`);
}

function validateOptionalUrl(value: unknown, path: string, issues: string[]): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string") { issues.push(`${path} must be a URL`); return false; }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") issues.push(`${path} must use http or https`);
    if (url.username || url.password) issues.push(`${path} must not contain inline credentials`);
    return true;
  } catch { issues.push(`${path} must be a valid URL`); return false; }
}

function validateAuthorization(value: unknown, path: string, issues: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)) issues.push(`${path}.env must be an environment variable name`);
  else if (value.header !== undefined && (typeof value.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.header))) issues.push(`${path}.header is invalid`);
}

function validateUpstream(value: unknown, path: string, expected: Protocol, issues: string[]): void {
  if (!isRecord(value)) return void issues.push(`${path} must be an object`);
  if (value.protocol !== expected) issues.push(`${path}.protocol must be ${expected}; cross-protocol translation is unsupported`);
  if (typeof value.baseUrl !== "string") issues.push(`${path}.baseUrl must be a URL`);
  else {
    try {
      const url = new URL(value.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") issues.push(`${path}.baseUrl must use http or https`);
      if (url.username || url.password) issues.push(`${path}.baseUrl must not contain credentials; use an environment-variable authorization reference`);
      if ([...url.searchParams.keys()].some((key) => /key|token|secret|password/i.test(key))) issues.push(`${path}.baseUrl must not contain credential-like query parameters`);
    } catch {
      issues.push(`${path}.baseUrl must be a valid URL`);
    }
  }
  validateAuthorization(value.authorization, `${path}.authorization`, issues);
  if (value.credentialHeaders !== undefined && (!Array.isArray(value.credentialHeaders) || !value.credentialHeaders.every((header) => typeof header === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)))) {
    issues.push(`${path}.credentialHeaders must contain valid HTTP header names`);
  }
}

export function routeFor(config: RouterConfig, harness: "claude" | "codex", agentType: string): Route | undefined {
  return config.routes[harness][agentType];
}

export function routeUpstream(config: RouterConfig, harness: Harness, route: Route): Upstream | undefined {
  const legacy = (route as unknown as { upstream?: Upstream }).upstream;
  if (legacy) return legacy;
  const destination = config.destinations[route.destination];
  if (!destination) return undefined;
  const baseUrl = harness === "claude" ? destination.anthropicBaseUrl : destination.openaiBaseUrl;
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    protocol: harness === "claude" ? "anthropic-messages" : "openai-responses",
    ...(route.authorization ? { authorization: route.authorization } : {}),
  };
}

export function migrateConfig(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1) return value;
  const migrated = structuredClone(value) as Record<string, any>;
  migrated.version = 2;
  if (isRecord(migrated.gateway)) {
    migrated.gateway.host = "127.0.0.1";
    migrated.gateway.port = 9476;
  }
  migrated.destinations = {};
  for (const harness of ["claude", "codex"] as const) {
    const routes = isRecord(migrated.routes?.[harness]) ? migrated.routes[harness] as Record<string, any> : {};
    for (const [agent, route] of Object.entries(routes)) {
      if (!isRecord(route) || !isRecord(route.upstream)) continue;
      const destinationId = uniqueDestinationId(migrated.destinations, `${harness}-${agent}`);
      const destination: Destination = {
        name: `${harness === "claude" ? "Claude" : "Codex"} · ${agent}`,
        ...(harness === "claude" ? { anthropicBaseUrl: route.upstream.baseUrl } : { openaiBaseUrl: route.upstream.baseUrl }),
      };
      migrated.destinations[destinationId] = destination;
      route.destination = destinationId;
      if (route.upstream.authorization) route.authorization = route.upstream.authorization;
      delete route.upstream;
    }
  }
  return migrated;
}

function uniqueDestinationId(destinations: Record<string, unknown>, seed: string): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "destination";
  let candidate = base;
  for (let index = 2; candidate in destinations; index += 1) candidate = `${base}-${index}`;
  return candidate;
}

export function sameUpstream(left: Upstream, right: Upstream): boolean {
  return normalizeBase(left.baseUrl) === normalizeBase(right.baseUrl) && left.protocol === right.protocol;
}

function normalizeBase(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
