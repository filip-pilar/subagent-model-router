import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appState, ensureGlobalConfig, removeHarness, resetEverything, setupHarness } from "../src/app.js";
import { temporaryRoot } from "./helpers.js";

describe("desktop harness lifecycle", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sets up and independently restores detected Claude and Codex harnesses", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const bin = resolve(home, ".local/bin");
    await mkdir(bin, { recursive: true });
    const claude = resolve(bin, "claude");
    const codex = resolve(bin, "codex");
    await writeFile(claude, "#!/bin/sh\necho '2.1.216 (Claude Code)'\n");
    await writeFile(codex, "#!/bin/sh\nif [ \"$1\" = debug ]; then echo '{\"models\":[{\"slug\":\"parent\",\"display_name\":\"Parent\"}]}'; else echo 'codex-cli 0.145.0'; fi\n");
    await chmod(claude, 0o755); await chmod(codex, 0o755);
    const configPath = resolve(home, ".local/share/subagent-model-router/config.json");
    await ensureGlobalConfig(configPath, home);

    await setupHarness(configPath, "claude", "/stable/router-helper", home);
    await setupHarness(configPath, "codex", "/stable/router-helper", home);
    const installed = await appState(configPath, home) as any;
    expect(installed.integration).toEqual({ claude: true, codex: true });
    expect(await readFile(resolve(home, ".claude/settings.json"), "utf8")).toContain('/stable/router-helper');
    expect(await readFile(resolve(home, ".codex/hooks.json"), "utf8")).toContain('/stable/router-helper');

    expect((await removeHarness(configPath, "claude") as any).conflicts).toEqual([]);
    const partial = await appState(configPath, home) as any;
    expect(partial.integration).toEqual({ claude: false, codex: true });
    expect((await resetEverything(configPath, home) as any).conflicts).toEqual([]);
    const reset = await appState(configPath, home) as any;
    expect(reset.integration).toEqual({ claude: false, codex: false });
    expect(reset.config.destinations).toEqual({});
  });

  it("does not rewrite a valid config while refreshing app state", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const configPath = resolve(home, ".local/share/subagent-model-router/config.json");
    await ensureGlobalConfig(configPath, home);
    const before = await stat(configPath);
    const content = await readFile(configPath, "utf8");
    await appState(configPath, home);
    await appState(configPath, home);
    const after = await stat(configPath);
    expect(await readFile(configPath, "utf8")).toBe(content);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rolls back first-time Codex setup when catalog capture fails", async () => {
    vi.stubEnv("SMR_TEST_HOME_ONLY", "1");
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const app = resolve(home, "Applications/Codex.app/Contents");
    await mkdir(app, { recursive: true });
    await writeFile(resolve(app, "Info.plist"), plist("1.2.3"));
    const hooks = resolve(home, ".codex/hooks.json");
    await mkdir(resolve(hooks, ".."), { recursive: true });
    await writeFile(hooks, "{\"hooks\":{\"Existing\":[]}}\n");
    const configPath = resolve(home, ".local/share/subagent-model-router/config.json");
    await ensureGlobalConfig(configPath, home);
    const originalConfig = await readFile(configPath, "utf8");

    await expect(setupHarness(configPath, "codex", "/stable/router-helper", home)).rejects.toThrow(/Unable to capture the installed Codex catalog/);

    expect(await readFile(hooks, "utf8")).toBe("{\"hooks\":{\"Existing\":[]}}\n");
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    await expect(readFile(resolve(home, ".local/share/subagent-model-router/install-state.json"), "utf8")).rejects.toThrow();
    await expect(readFile(resolve(home, ".local/share/subagent-model-router/codex-source-catalog.json"), "utf8")).rejects.toThrow();
  });

  it("sets up Codex Desktop without a CLI by falling back to its model cache", async () => {
    vi.stubEnv("SMR_TEST_HOME_ONLY", "1");
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const app = resolve(home, "Applications/Codex.app/Contents");
    await mkdir(app, { recursive: true });
    await writeFile(resolve(app, "Info.plist"), plist("1.2.3"));
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(resolve(home, ".codex/models_cache.json"), '{"models":[{"slug":"desktop-parent","display_name":"Desktop Parent"}]}\n');
    const configPath = resolve(home, ".local/share/subagent-model-router/config.json");
    await ensureGlobalConfig(configPath, home);

    await setupHarness(configPath, "codex", "/stable/router-helper", home);

    const state = await appState(configPath, home) as any;
    expect(state.detection.codex).toMatchObject({ detected: true, appPath: resolve(home, "Applications/Codex.app"), version: "1.2.3" });
    expect(state.detection.codex.cliPath).toBeUndefined();
    expect(state.integration.codex).toBe(true);
    expect(JSON.parse(await readFile(resolve(home, ".local/share/subagent-model-router/codex-source-catalog.json"), "utf8")).models[0].slug).toBe("desktop-parent");
    expect(await readFile(resolve(home, ".codex/hooks.json"), "utf8")).toContain("/stable/router-helper");
  });

  it("migrates the legacy data directory, hooks, provider, and install state", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const bin = resolve(home, ".local/bin");
    await mkdir(bin, { recursive: true });
    const claude = resolve(bin, "claude");
    const codex = resolve(bin, "codex");
    await writeFile(claude, "#!/bin/sh\necho '2.1.216 (Claude Code)'\n");
    await writeFile(codex, "#!/bin/sh\nif [ \"$1\" = debug ]; then echo '{\"models\":[{\"slug\":\"parent\",\"display_name\":\"Parent\"}]}'; else echo 'codex-cli 0.145.0'; fi\n");
    await chmod(claude, 0o755); await chmod(codex, 0o755);

    const currentData = resolve(home, ".local/share/subagent-model-router");
    const legacyData = resolve(home, ".local/share/harness-model-router");
    const configPath = resolve(currentData, "config.json");
    const helperPath = resolve(currentData, "bin/subagent-model-router-helper");
    await ensureGlobalConfig(configPath, home);
    await setupHarness(configPath, "claude", helperPath, home);
    await setupHarness(configPath, "codex", helperPath, home);

    const replaceDataPath = (value: string): string => value
      .replaceAll(currentData, legacyData)
      .replaceAll("subagent-model-router-helper", "harness-model-router-helper");
    const hookPaths = [
      resolve(home, ".claude/settings.json"),
      resolve(home, ".codex/hooks.json"),
    ];
    for (const path of hookPaths) await writeFile(path, replaceDataPath(await readFile(path, "utf8")));
    const codexConfigPath = resolve(home, ".codex/config.toml");
    const legacyCodexIdentifiers = replaceDataPath(await readFile(codexConfigPath, "utf8"))
      .replaceAll('model_provider = "subagent-model-router"', 'model_provider = "harness-model-router"')
      .replaceAll("# subagent-model-router:start", "# harness-model-router:start")
      .replaceAll("# subagent-model-router:end", "# harness-model-router:end")
      .replaceAll("[model_providers.subagent-model-router]", "[model_providers.harness-model-router]")
      .replaceAll('name = "subagent-model-router"', 'name = "harness-model-router"');
    await writeFile(codexConfigPath, legacyCodexIdentifiers);
    await writeFile(configPath, replaceDataPath(await readFile(configPath, "utf8")));

    const installStatePath = resolve(currentData, "install-state.json");
    const installState = JSON.parse(await readFile(installStatePath, "utf8"));
    for (const mutation of [installState.claude, installState.codexHooks]) {
      mutation.hookCommands = mutation.hookCommands.map(replaceDataPath);
    }
    for (const scalar of installState.codexConfig.scalars) {
      scalar.installedLine = replaceDataPath(scalar.installedLine);
      if (scalar.key === "model_provider") scalar.installedLine = scalar.installedLine.replaceAll("subagent-model-router", "harness-model-router");
      if (scalar.originalLine) scalar.originalLine = replaceDataPath(scalar.originalLine);
    }
    const legacyCodexConfig = await readFile(resolve(home, ".codex/config.toml"), "utf8");
    const legacyBlock = /# harness-model-router:start[\s\S]*?# harness-model-router:end/.exec(legacyCodexConfig)![0];
    installState.codexConfig.blockHash = createHash("sha256").update(legacyBlock).digest("hex");
    await writeFile(installStatePath, `${JSON.stringify(installState, null, 2)}\n`);
    await mkdir(resolve(currentData, "bin"), { recursive: true });
    await writeFile(resolve(currentData, "bin/harness-model-router-helper"), "legacy");
    await rename(currentData, legacyData);

    const migrated = await appState(configPath, home) as any;

    expect(migrated.integration).toEqual({ claude: true, codex: true });
    await expect(stat(legacyData)).rejects.toThrow();
    await expect(stat(resolve(currentData, "bin/harness-model-router-helper"))).rejects.toThrow();
    expect(await readFile(resolve(home, ".claude/settings.json"), "utf8")).toContain(helperPath);
    expect(await readFile(resolve(home, ".codex/hooks.json"), "utf8")).toContain(helperPath);
    const migratedCodexConfig = await readFile(resolve(home, ".codex/config.toml"), "utf8");
    expect(migratedCodexConfig).toContain("[model_providers.subagent-model-router]");
    expect(migratedCodexConfig).not.toContain("harness-model-router");
    const migratedConfig = JSON.parse(await readFile(configPath, "utf8"));
    expect(migratedConfig.harnesses.codex.overlayCatalogPath).toContain(currentData);
    expect(await readFile(installStatePath, "utf8")).not.toContain("harness-model-router");
  });

  it("restores the legacy data directory when owned hooks conflict during migration", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const bin = resolve(home, ".local/bin");
    await mkdir(bin, { recursive: true });
    const claude = resolve(bin, "claude");
    await writeFile(claude, "#!/bin/sh\necho '2.1.216 (Claude Code)'\n");
    await chmod(claude, 0o755);

    const currentData = resolve(home, ".local/share/subagent-model-router");
    const legacyData = resolve(home, ".local/share/harness-model-router");
    const configPath = resolve(currentData, "config.json");
    const helperPath = resolve(currentData, "bin/subagent-model-router-helper");
    await ensureGlobalConfig(configPath, home);
    await setupHarness(configPath, "claude", helperPath, home);

    const settingsPath = resolve(home, ".claude/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.hooks.SubagentStart[0].hooks[0].command = "user-changed-command";
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    await writeFile(configPath, (await readFile(configPath, "utf8")).replaceAll(currentData, legacyData));
    const statePath = resolve(currentData, "install-state.json");
    await writeFile(statePath, (await readFile(statePath, "utf8"))
      .replaceAll(currentData, legacyData)
      .replaceAll("subagent-model-router-helper", "harness-model-router-helper"));
    await rename(currentData, legacyData);
    await mkdir(resolve(currentData, "bin"), { recursive: true });
    await writeFile(resolve(currentData, "bin/subagent-model-router-helper"), "current");

    await expect(appState(configPath, home)).rejects.toThrow(/legacy router hook changed/);
    expect(await readFile(resolve(legacyData, "config.json"), "utf8")).toContain(legacyData);
    expect(await readFile(resolve(currentData, "bin/subagent-model-router-helper"), "utf8")).toBe("current");
    expect(await readFile(settingsPath, "utf8")).toContain("user-changed-command");
  });
});

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`;
}
