import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exists } from "./files.js";

export const BLOCK_START = "# subagent-model-router:start";
export const BLOCK_END = "# subagent-model-router:end";
export const LEGACY_BLOCK_START = "# harness-model-router:start";
export const LEGACY_BLOCK_END = "# harness-model-router:end";
export const LEGACY_SERVICE_NAME = "harness-model-router";
export const SERVICE_NAME = "subagent-model-router";

export interface ScalarMutation { key: string; originalLine?: string; installedLine: string }
export interface JsonMutation {
  path: string;
  existed: boolean;
  priorBaseUrl?: string;
  installedBaseUrl?: string;
  hookCommands: string[];
}
export interface CodexMutation {
  path: string;
  existed: boolean;
  scalars: ScalarMutation[];
  blockHash: string;
}
export interface InstallState {
  version: 1;
  claude?: JsonMutation;
  codexHooks?: JsonMutation;
  codexConfig?: CodexMutation;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function installStatePath(configPath: string): string {
  return resolve(dirname(configPath), "install-state.json");
}

export async function readInstallState(path: string): Promise<InstallState> {
  return await exists(path) ? JSON.parse(await readFile(path, "utf8")) as InstallState : { version: 1 };
}

export function extractOwnedBlock(content: string): string | undefined {
  return extractOwnedBlockWithMarkers(content, BLOCK_START, BLOCK_END);
}

export function extractOwnedBlockWithMarkers(content: string, start: string, end: string): string | undefined {
  return new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`).exec(content)?.[0];
}

export function removeOwnedBlock(content: string): string {
  return content.replace(new RegExp(`\\n?${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\n?`), "\n");
}

export function assertCredentialFreeUrl(value: string, label: string): void {
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

export function assertNoStaticProviderCredentials(provider: Record<string, any>, path: string, providerName: string): void {
  const staticHeaders = provider.http_headers;
  if (staticHeaders && typeof staticHeaders === "object" && Object.keys(staticHeaders).some((name) => /authorization|api[-_]?key|token|secret|password/i.test(name))) {
    throw new Error(`${path} provider ${providerName} contains a static credential header; use env_key or env_http_headers before installing`);
  }
  if (Object.keys(provider).some((name) => /bearer_token|access_token|api_key|password|secret/i.test(name) && name !== "env_key")) {
    throw new Error(`${path} provider ${providerName} contains a static credential field; use an environment-backed provider field before installing`);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
