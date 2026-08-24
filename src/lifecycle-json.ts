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
  if (!prior && typeof existingBase === "string" && sameRouterEndpoint(existingBase, baseUrl)) {
    throw new Error(`${path}: ANTHROPIC_BASE_URL already points at ${baseUrl}, but no matching installation state exists. Restore ANTHROPIC_BASE_URL to the real upstream, or remove it to use Claude Code's default, before setting up routing.`);
  }
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

function sameRouterEndpoint(left: string, right: string): boolean {
  const normalizePath = (value: string): string => value.replace(/\/+$/, "") || "/";
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  return leftUrl.origin === rightUrl.origin
    && normalizePath(leftUrl.pathname) === normalizePath(rightUrl.pathname)
    && leftUrl.search === rightUrl.search;
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
  if (!force) {
    const before = conflicts.length;
    await preflightJsonMutation(mutation, conflicts, kind);
    if (conflicts.length > before) return false;
  }
  const original = await readFile(mutation.path, "utf8");
  const document = JSON.parse(original) as Record<string, any>;
  let changed = false;
  if (force) {
    for (const command of routerHookCommands(document.hooks, kind)) changed = removeHook(document.hooks, command) || changed;
  }
  for (const command of mutation.hookCommands) changed = removeHook(document.hooks, command) || changed;
  if (kind === "claude") {
    const currentBaseUrl = document.env?.ANTHROPIC_BASE_URL;
    if (force || currentBaseUrl === mutation.installedBaseUrl) {
      if (mutation.priorBaseUrl !== undefined) {
        document.env ??= {};
        document.env.ANTHROPIC_BASE_URL = mutation.priorBaseUrl;
      } else if (document.env) delete document.env.ANTHROPIC_BASE_URL;
      changed = currentBaseUrl !== mutation.priorBaseUrl || changed;
    }
    if (changed && document.env && Object.keys(document.env).length === 0) delete document.env;
  }
  if (changed && document.hooks && Object.keys(document.hooks).length === 0) delete document.hooks;
  if (!changed) return false;
  if (!mutation.existed && Object.keys(document).length === 0) await unlink(mutation.path);
  else await atomicWriteFile(mutation.path, `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return true;
}

export async function preflightJsonMutation(
  mutation: JsonMutation,
  conflicts: string[],
  kind: "claude" | "codex",
): Promise<void> {
  if (!await exists(mutation.path)) return;
  const document = JSON.parse(await readFile(mutation.path, "utf8")) as Record<string, any>;
  if (kind === "claude") {
    const currentBaseUrl = document.env?.ANTHROPIC_BASE_URL;
    if (currentBaseUrl !== mutation.installedBaseUrl && currentBaseUrl !== mutation.priorBaseUrl) {
      conflicts.push(`${mutation.path}: ANTHROPIC_BASE_URL changed after installation`);
    }
  }
  const installed = new Set(mutation.hookCommands);
  if (routerHookCommands(document.hooks, kind).some((command) => !installed.has(command))) {
    conflicts.push(`${mutation.path}: owned ${kind === "codex" ? "Codex" : "Claude"} hook changed after installation`);
  }
}

function routerHookCommands(hooks: Record<string, any> | undefined, kind: "claude" | "codex"): string[] {
  if (!hooks) return [];
  const matcher = kind === "codex" ? /\bhook\s+codex-pretool\b/ : /\bhook\s+claude-(?:start|stop)\b/;
  const commands: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook?.command === "string" && matcher.test(hook.command)) commands.push(hook.command);
      }
    }
  }
  return commands;
}

function addHook(hooks: Record<string, any>, event: string, command: string, statusMessage: string, matcher = "*", timeout = 2): void {
  hooks[event] ??= [];
  if (hookExists({ [event]: hooks[event] }, command)) return;
  hooks[event].push({ matcher, hooks: [{ type: "command", command, timeout, statusMessage }] });
}

function removeHook(hooks: Record<string, any> | undefined, command: string): boolean {
  if (!hooks) return false;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].map((group: any) => {
      if (!Array.isArray(group.hooks)) return group;
      const filtered = group.hooks.filter((hook: any) => hook?.command !== command);
      if (filtered.length !== group.hooks.length) changed = true;
      return { ...group, hooks: filtered };
    }).filter((group: any) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  return changed;
}
