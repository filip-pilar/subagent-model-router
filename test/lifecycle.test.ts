import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { installIntegration, integrationStatus, uninstallHarnessIntegration, uninstallIntegration } from "../src/lifecycle.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { forwardedHeaders } from "../src/headers.js";
import { CODEX_V1_IDENTITY_REQUIRED, codexHookOutput } from "../src/routing.js";
import { temporaryRoot, testConfig, writeJson } from "./helpers.js";

describe("installation lifecycle", () => {
  it("uses an existing Claude base URL as the original upstream and restores it", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const settingsPath = resolve(home, ".claude/settings.json");
    await mkdir(resolve(settingsPath, ".."), { recursive: true });
    await writeJson(settingsPath, { env: { ANTHROPIC_BASE_URL: "https://existing-gateway.example/anthropic" } });
    const { config, path } = await testConfig(root);
    config.harnesses.claude.enabled = true;
    await saveConfig(path, config);

    expect((await installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" })).conflicts).toEqual([]);
    expect((await loadConfig(path)).harnesses.claude.originalUpstream.baseUrl).toBe("https://existing-gateway.example/anthropic");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9476/claude");

    const externallyChanged = JSON.parse(await readFile(settingsPath, "utf8"));
    delete externallyChanged.env;
    await writeJson(settingsPath, externallyChanged);
    const beforeRemoval = await readFile(settingsPath, "utf8");
    const blocked = await uninstallHarnessIntegration(path, "claude");
    expect(blocked.changed).toEqual([]);
    expect(blocked.conflicts.join("\n")).toContain("ANTHROPIC_BASE_URL changed after installation");
    expect(await readFile(settingsPath, "utf8")).toBe(beforeRemoval);

    expect((await uninstallHarnessIntegration(path, "claude", true)).conflicts).toEqual([]);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL).toBe("https://existing-gateway.example/anthropic");
  });

  it("rejects orphaned Claude settings that already point at the router", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const settingsPath = resolve(home, ".claude/settings.json");
    await mkdir(resolve(settingsPath, ".."), { recursive: true });
    const originalSettings = '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9476/claude/"},"theme":"dark"}\n';
    await writeFile(settingsPath, originalSettings);
    const { config, path } = await testConfig(root);
    config.harnesses.claude.enabled = true;
    await saveConfig(path, config);

    await expect(installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" }))
      .rejects.toThrow(/no matching installation state exists.*Restore ANTHROPIC_BASE_URL to the real upstream/);

    expect(await readFile(settingsPath, "utf8")).toBe(originalSettings);
    expect((await loadConfig(path)).harnesses.claude.originalUpstream.baseUrl).toBe("https://api.anthropic.com");
    await expect(readFile(resolve(path, "../install-state.json"), "utf8")).rejects.toThrow();
  });

  it("records original Codex environment-backed credential header names", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }] });
    await writeFile(resolve(home, ".codex/config.toml"), `model_provider = "private"\n\n[model_providers.private]\nbase_url = "http://original.example/v1"\nenv_key = "PRIVATE_API_KEY"\nenv_http_headers = { X-Auth = "PRIVATE_AUTH", X-Account = "PRIVATE_ACCOUNT" }\n`);
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    await saveConfig(path, config);

    const options = { home, cliPath: "/router.js", nodePath: "/node" };
    expect((await installIntegration(path, options)).conflicts).toEqual([]);
    expect((await installIntegration(path, options)).conflicts).toEqual([]);
    expect((await loadConfig(path)).harnesses.codex.originalUpstream.credentialHeaders).toEqual(["Authorization", "X-Auth", "X-Account"]);
    expect((parseToml(await readFile(resolve(home, ".codex/config.toml"), "utf8")) as any).model_providers["subagent-model-router"].env_http_headers).toEqual({ "X-Auth": "PRIVATE_AUTH", "X-Account": "PRIVATE_ACCOUNT" });
  });

  it("treats every original static provider header as origin-bound", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }] });
    await writeFile(resolve(home, ".codex/config.toml"), `model_provider = "private"\n\n[model_providers.private]\nbase_url = "http://original.example/v1"\nhttp_headers = { X-Auth = "static-value", X-Feature = "provider-value" }\n`);
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    await saveConfig(path, config);

    expect((await installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" })).conflicts).toEqual([]);
    const original = (await loadConfig(path)).harnesses.codex.originalUpstream;
    expect(original.credentialHeaders).toEqual(["X-Auth", "X-Feature"]);
    const forwarded = forwardedHeaders(
      new Headers({ "X-Auth": "static-value", "X-Feature": "provider-value", "X-Request": "keep" }),
      original,
      { baseUrl: "http://destination.example/v1", protocol: "openai-responses" },
    );
    expect(forwarded.has("X-Auth")).toBe(false);
    expect(forwarded.has("X-Feature")).toBe(false);
    expect(forwarded.get("X-Request")).toBe("keep");
  });

  it("installs idempotently, preserves unrelated state, normalizes explicit agents, and restores exactly", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    await mkdir(resolve(home, ".claude"), { recursive: true });
    await mkdir(resolve(home, ".codex/agents"), { recursive: true });
    const claudeSettings = resolve(home, ".claude/settings.json");
    await writeJson(claudeSettings, { theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] }] } });
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent", multi_agent_version: "v2" }, { slug: "wire-review", display_name: "Review", multi_agent_version: "v2" }] });
    const codexConfig = resolve(home, ".codex/config.toml");
    const originalCodex = `model = "parent"\nmodel_provider = "private"\nmodel_catalog_json = ${JSON.stringify(source)}\nunrelated = "keep"\n\n[model_providers.private]\nbase_url = "http://original.example/v1"\nenv_key = "PRIVATE_API_KEY"\nrequest_max_retries = 7\n`;
    await writeFile(codexConfig, originalCodex);
    const agentPath = resolve(home, ".codex/agents/reviewer.toml");
    const originalAgent = 'name = "reviewer"\ndescription = "Review"\ndeveloper_instructions = "Be exact"\nmodel = "original-child" # preserve this comment\n[mcp_servers.docs]\nurl = "https://example.invalid/mcp"\n[[skills.config]]\npath = "/tmp/review/SKILL.md"\nenabled = false\n';
    await writeFile(agentPath, originalAgent);
    const { config, path } = await testConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.codex.enabled = true;
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "wire-review", upstream: { baseUrl: "http://custom.example/v1", protocol: "openai-responses" } };
    await saveConfig(path, config);

    const options = { home, cliPath: "/opt/router/cli.js", nodePath: "/opt/node" };
    expect((await installIntegration(path, options)).conflicts).toEqual([]);
    expect((await installIntegration(path, options)).conflicts).toEqual([]);
    const settings = JSON.parse(await readFile(claudeSettings, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("keep-me");
    expect(settings.hooks.SubagentStart).toHaveLength(1);
    expect(await readFile(agentPath, "utf8")).toContain('model = "router-reviewer" # preserve this comment');
    expect(await readFile(agentPath, "utf8")).toContain('[mcp_servers.docs]\nurl = "https://example.invalid/mcp"');
    expect(await readFile(agentPath, "utf8")).toContain('[[skills.config]]\npath = "/tmp/review/SKILL.md"\nenabled = false');
    const installedConfig = await readFile(codexConfig, "utf8");
    expect(installedConfig).toContain('unrelated = "keep"');
    expect(installedConfig).toContain("[model_providers.subagent-model-router]");
    expect((parseToml(installedConfig) as any).model_providers["subagent-model-router"]).toMatchObject({ env_key: "PRIVATE_API_KEY", request_max_retries: 7 });
    const installedRouterConfig = await loadConfig(path);
    expect(installedRouterConfig.routes.codex.reviewer.requiredMultiAgentVersion).toBeUndefined();
    const overlay = JSON.parse(await readFile(installedRouterConfig.harnesses.codex.overlayCatalogPath!, "utf8"));
    expect(overlay.models.find((model: any) => model.slug === "router-reviewer")).toMatchObject({ visibility: "hide", multi_agent_version: "v2" });
    expect(overlay.models.find((model: any) => model.slug === "parent").multi_agent_version).toBe("v2");

    const removed = await uninstallIntegration(path);
    expect(removed.conflicts).toEqual([]);
    expect(await readFile(agentPath, "utf8")).toBe(originalAgent);
    const restoredSettings = JSON.parse(await readFile(claudeSettings, "utf8"));
    expect(restoredSettings).toEqual({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] }] } });
    const restoredConfig = await readFile(codexConfig, "utf8");
    expect(restoredConfig).toContain('model_provider = "private"');
    expect(restoredConfig).toContain('unrelated = "keep"');
    expect(restoredConfig).not.toContain("subagent-model-router:start");
  });

  it.each([
    ["model_provider", 'model_provider = "private"\n'],
    ["model_providers", '[model_providers.private]\nbase_url = "https://provider.example/v1"\n'],
    ["model_catalog_json", 'model_catalog_json = "/tmp/private-catalog.json"\n'],
  ])("rejects a routed custom-agent %s override before changing lifecycle files", async (field, override) => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const agentPath = resolve(home, ".codex/agents/reviewer.toml");
    await mkdir(resolve(agentPath, ".."), { recursive: true });
    const originalAgent = `name = "reviewer"\ndescription = "Review"\ndeveloper_instructions = "Review"\nmodel = "original"\n${override}`;
    await writeFile(agentPath, originalAgent);
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }] });
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "wire", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };
    await saveConfig(path, config);
    const savedConfig = await readFile(path, "utf8");

    await expect(installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" }))
      .rejects.toThrow(new RegExp(`custom-agent .*${field}.* overrides`));

    expect(await readFile(agentPath, "utf8")).toBe(originalAgent);
    expect(await readFile(path, "utf8")).toBe(savedConfig);
    await expect(readFile(resolve(home, ".codex/hooks.json"), "utf8")).rejects.toThrow();
    await expect(readFile(resolve(home, ".codex/config.toml"), "utf8")).rejects.toThrow();
    await expect(readFile(config.harnesses.codex.overlayCatalogPath!, "utf8")).rejects.toThrow();
    await expect(readFile(resolve(path, "../install-state.json"), "utf8")).rejects.toThrow();
  });

  it("requires a configured V1 parent for built-in and malformed custom routes before changing Codex files", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const codexDirectory = resolve(home, ".codex");
    await mkdir(resolve(codexDirectory, "agents"), { recursive: true });
    const malformedAgentPath = resolve(codexDirectory, "agents/reviewer.toml");
    const malformedAgent = 'name = "reviewer"\nmodel = "gpt-custom"\n';
    await writeFile(malformedAgentPath, malformedAgent);
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent", multi_agent_version: "v2" }, { slug: "wire-explorer", display_name: "Explorer", multi_agent_version: "v2" }] });
    const codexConfig = resolve(codexDirectory, "config.toml");
    const originalCodex = 'model = "parent"\nmodel_provider = "openai"\n\n[model_providers.openai]\nbase_url = "http://original.example/v1"\nenv_key = "OPENAI_API_KEY"\n';
    await writeFile(codexConfig, originalCodex);
    const hooksPath = resolve(codexDirectory, "hooks.json");
    const originalHooks = '{"hooks":{"Existing":[]}}\n';
    await writeFile(hooksPath, originalHooks);
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: "wire-explorer", upstream: { baseUrl: "http://custom.example/v1", protocol: "openai-responses" } };
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "wire-reviewer", upstream: { baseUrl: "http://custom.example/v1", protocol: "openai-responses" } };
    await saveConfig(path, config);

    await expect(installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" })).rejects.toThrow('Codex route "explorer" requires V1');
    expect(await readFile(codexConfig, "utf8")).toBe(originalCodex);
    expect(await readFile(hooksPath, "utf8")).toBe(originalHooks);
    expect(await readFile(malformedAgentPath, "utf8")).toBe(malformedAgent);
    await expect(readFile(config.harnesses.codex.overlayCatalogPath!, "utf8")).rejects.toThrow();
    expect((await loadConfig(path)).routes.codex.explorer.requiredMultiAgentVersion).toBeUndefined();

    const retry = await loadConfig(path);
    retry.harnesses.codex.parentModels = ["parent"];
    await saveConfig(path, retry);
    expect((await installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" })).conflicts).toEqual([]);
    const installed = await loadConfig(path);
    expect(installed.routes.codex.explorer.requiredMultiAgentVersion).toBe("v1");
    expect(installed.routes.codex.reviewer.requiredMultiAgentVersion).toBe("v1");
    expect(await readFile(malformedAgentPath, "utf8")).toBe(malformedAgent);
    const overlay = JSON.parse(await readFile(installed.harnesses.codex.overlayCatalogPath!, "utf8"));
    expect(overlay.models.find((model: any) => model.slug === "router-explorer").multi_agent_version).toBe("v1");
    expect(overlay.models.find((model: any) => model.slug === "parent").multi_agent_version).toBe("v1");
  });

  it("allows an enabled dangling V1 route to pass through without parent models", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }] });
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    config.routes.codex.explorer = {
      enabled: true,
      alias: "router-explorer",
      model: "wire-explorer",
      destination: "removed-destination",
      requiredMultiAgentVersion: "v1",
    };
    await saveConfig(path, config);

    expect((await installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" })).conflicts).toEqual([]);
    const installed = await loadConfig(path);
    expect(installed.harnesses.codex.parentModels).toEqual([]);
    expect(installed.routes.codex.explorer.requiredMultiAgentVersion).toBe("v1");
    expect(codexHookOutput(installed, "collaborationspawn_agent", { agent_type: "explorer", message: "x" })).toBeUndefined();
  });

  it("detects later custom-agent edits and only force restores them explicitly", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    await mkdir(resolve(home, ".codex/agents"), { recursive: true });
    const agentPath = resolve(home, ".codex/agents/reviewer.toml");
    const original = 'name = "reviewer"\ndescription = "Review"\ndeveloper_instructions = "Review"\nmodel = "original"\n';
    await writeFile(agentPath, original);
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }] });
    config.harnesses.codex.sourceCatalogPath = source;
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "real", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };
    await saveConfig(path, config);
    await installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" });
    await writeFile(agentPath, `${await readFile(agentPath, "utf8")}# user edit\n`);
    const protectedPaths = [
      resolve(home, ".codex/hooks.json"),
      resolve(home, ".codex/config.toml"),
      config.harnesses.codex.overlayCatalogPath!,
      path,
      resolve(path, "../install-state.json"),
    ];
    const protectedContents = await Promise.all(protectedPaths.map((protectedPath) => readFile(protectedPath, "utf8")));
    const conflicted = await uninstallIntegration(path);
    expect(conflicted.changed).toEqual([]);
    expect(conflicted.conflicts.join("\n")).toMatch(/changed after normalization|changed after installation/);
    await Promise.all(protectedPaths.map(async (protectedPath, index) => expect(await readFile(protectedPath, "utf8")).toBe(protectedContents[index])));
    await uninstallIntegration(path, true);
    expect(await readFile(agentPath, "utf8")).toBe(`${original}# user edit\n`);
  });

  it("preflights a Codex config conflict before changing hooks or install state", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }] });
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    await saveConfig(path, config);
    await installIntegration(path, { home, cliPath: "/router.js", nodePath: "/node" });
    const codexConfigPath = resolve(home, ".codex/config.toml");
    const hooksPath = resolve(home, ".codex/hooks.json");
    await writeFile(codexConfigPath, (await readFile(codexConfigPath, "utf8")).replace('name = "subagent-model-router"', 'name = "user-edited-router"'));
    await writeFile(hooksPath, (await readFile(hooksPath, "utf8")).replace("hook codex-pretool", "hook codex-pretool-edited"));
    const protectedPaths = [
      hooksPath,
      codexConfigPath,
      config.harnesses.codex.overlayCatalogPath!,
      path,
      resolve(path, "../install-state.json"),
    ];
    const before = await Promise.all(protectedPaths.map((protectedPath) => readFile(protectedPath, "utf8")));

    const result = await uninstallHarnessIntegration(path, "codex");

    expect(result.changed).toEqual([]);
    expect(result.conflicts.join("\n")).toMatch(/owned Codex hook changed/);
    expect(result.conflicts.join("\n")).toMatch(/owned Codex provider block changed/);
    await Promise.all(protectedPaths.map(async (protectedPath, index) => expect(await readFile(protectedPath, "utf8")).toBe(before[index])));
  });

  it("completes Codex removal when owned artifacts are already missing", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    await mkdir(resolve(home, ".codex/agents"), { recursive: true });
    const agentPath = resolve(home, ".codex/agents/reviewer.toml");
    await writeFile(agentPath, 'name = "reviewer"\ndescription = "Review"\ndeveloper_instructions = "Review"\nmodel = "original"\n');
    const source = resolve(root, "catalog.json");
    await writeJson(source, { models: [{ slug: "parent", display_name: "Parent" }, { slug: "wire", display_name: "Wire" }] });
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.sourceCatalogPath = source;
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "wire", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };
    await saveConfig(path, config);
    const options = { home, cliPath: "/router.js", nodePath: "/node" };
    await installIntegration(path, options);
    await unlink(agentPath);
    const reapplied = await loadConfig(path);
    reapplied.harnesses.codex.parentModels = ["parent"];
    await saveConfig(path, reapplied);
    expect((await installIntegration(path, options)).conflicts).toEqual([]);
    const installed = await loadConfig(path);
    expect(installed.routes.codex.reviewer.requiredMultiAgentVersion).toBe("v1");
    expect(codexHookOutput(installed, "collaborationspawn_agent", { task_name: "review" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: CODEX_V1_IDENTITY_REQUIRED,
      },
    });
    const ownedPaths = [
      resolve(home, ".codex/hooks.json"),
      resolve(home, ".codex/config.toml"),
      config.harnesses.codex.overlayCatalogPath!,
    ];
    await Promise.all(ownedPaths.map((ownedPath) => unlink(ownedPath)));

    const result = await uninstallHarnessIntegration(path, "codex");

    expect(result).toEqual({ changed: [], conflicts: [] });
    const restoredConfig = await loadConfig(path);
    expect(restoredConfig.harnesses.codex.enabled).toBe(false);
    expect(restoredConfig.preserved.customCodexAgents).toEqual({});
    expect((await integrationStatus(path)).codex).toBe(false);
    await expect(readFile(resolve(path, "../install-state.json"), "utf8")).rejects.toThrow();
  });
});
