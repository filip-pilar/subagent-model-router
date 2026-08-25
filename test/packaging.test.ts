import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGlobalConfig } from "../src/config.js";
import { ROUTER_VERSION } from "../src/version.js";

describe("standalone helper", () => {
  it("keeps the npm artifact limited to portable compiled files", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { files?: string[] };
    expect(manifest.files).toEqual([
      "dist/*.js",
      "dist/*.js.map",
      "dist/*.d.ts",
      "README.md",
      "LICENSE",
    ]);
    expect(manifest.files).not.toContain("dist");
  });

  it("compiles with its dependencies, serves readiness, and obeys its parent lifeline", { timeout: 30_000 }, async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    const output = resolve(mkdtempSync(resolve(tmpdir(), "hmr-helper-")), "helper");
    execFileSync(process.execPath, [resolve("bin/build-helper.mjs"), "--output", output], { stdio: "pipe", timeout: 30_000 });
    expect(execFileSync(output, ["--version"], { encoding: "utf8" }).trim()).toBe(ROUTER_VERSION);
    expect(execFileSync(output, ["--help"], { encoding: "utf8" })).toContain("app-state");
    const home = resolve(output, "../home");
    const configPath = resolve(home, ".local/share/subagent-model-router/config.json");
    mkdirSync(resolve(configPath, ".."), { recursive: true });
    const initial = defaultGlobalConfig(resolve(configPath, ".."));
    initial.harnesses.codex.enabled = true;
    writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`);
    expect(execFileSync(output, ["--config", configPath, "hook", "codex-pretool"], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: { agent_type: "unknown" } }) })).toBe("");
    execFileSync(output, ["--config", configPath, "main-route", "set", "codex", "--model", "main-wire", "--endpoint", "https://provider.example/v1"], { stdio: "pipe" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).mainRoutes.codex).toMatchObject({ enabled: true, model: "main-wire", destination: "codex-main" });
    expect(JSON.parse(execFileSync(output, ["--config", configPath, "routes", "--json"], { encoding: "utf8" }))).toContainEqual(expect.objectContaining({ harness: "codex", target: "main", enabled: true, broken: false, wireModel: "main-wire" }));
    execFileSync(output, ["--config", configPath, "main-route", "disable", "codex"], { stdio: "pipe" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).mainRoutes.codex.enabled).toBe(false);
    execFileSync(output, ["--config", configPath, "main-route", "enable", "codex"], { stdio: "pipe" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).mainRoutes.codex.enabled).toBe(true);
    expect(cliFailure(output, configPath, ["main-route", "set", "codex", "--endpoint", "https://provider.example/v1"])).toContain("main-route set requires --model and --endpoint");
    expect(cliFailure(output, configPath, ["main-route", "replace", "codex"])).toContain("main-route action must be set, enable, disable, or remove");
    execFileSync(output, ["--config", configPath, "main-route", "remove", "codex"], { stdio: "pipe" });
    expect(JSON.parse(readFileSync(configPath, "utf8")).mainRoutes.codex).toBeUndefined();
    expect(JSON.parse(execFileSync(output, ["--config", configPath, "routes", "--json"], { encoding: "utf8" }))).toEqual([]);
    const child = spawn(output, ["--config", configPath, "start", "--parent-lifeline"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SMR_HOME: home } });
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { response = await fetch("http://127.0.0.1:9476/__router/readiness"); if (response.ok) break; } catch { /* starting */ }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      expect(response?.headers.get("x-subagent-model-router")).toBe("1");
      child.stdin.end();
      const [status] = await once(child, "exit");
      expect(status).toBe(0);
    } finally { if (!child.killed && child.exitCode === null) child.kill("SIGKILL"); }
  });
});

function cliFailure(output: string, configPath: string, args: string[]): string {
  try {
    execFileSync(output, ["--config", configPath, ...args], { stdio: "pipe" });
    throw new Error("CLI command unexpectedly succeeded");
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error);
  }
}
