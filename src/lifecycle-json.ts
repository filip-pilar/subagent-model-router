import { readFile, unlink } from "node:fs/promises";
import { atomicWriteFile, exists } from "./files.js";
import { assertCredentialFreeUrl, type JsonMutation } from "./lifecycle-state.js";

export async function installClaudeSettings(
  path: string,
  baseUrl: string,
  commands: string[],
  prior: JsonMutation | undefined,
  force: boolean,
  conflicts: string[],
): Promise<JsonMutation> {
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

export async function installCodexHooks(
  path: string,
  command: string,
  timeoutSeconds: number,
  prior: JsonMutation | undefined,
  force: boolean,
  conflicts: string[],
): Promise<JsonMutation> {
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

export function hookExists(hooks: Record<string, any>, command: string): boolean {
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook: any) => hook?.command === command)));
}

export function replaceHookCommand(hooks: Record<string, any> | undefined, legacyCommand: string, migratedCommand: string): boolean {
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

export async function uninstallJsonMutation(
  mutation: JsonMutation,
  force: boolean,
  conflicts: string[],
  kind: "claude" | "codex",
): Promise<boolean> {
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

function addHook(hooks: Record<string, any>, event: string, command: string, statusMessage: string, matcher = "*", timeout = 2): void {
  hooks[event] ??= [];
  if (hookExists({ [event]: hooks[event] }, command)) return;
  hooks[event].push({ matcher, hooks: [{ type: "command", command, timeout, statusMessage }] });
}

function removeHook(hooks: Record<string, any> | undefined, command: string): void {
  if (!hooks) return;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].map((group: any) => ({ ...group, hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook: any) => hook?.command !== command) : group.hooks })).filter((group: any) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
}
