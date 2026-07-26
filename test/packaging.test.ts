import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGlobalConfig } from "../src/config.js";

describe("standalone helper", () => {
  it("compiles with its dependencies, serves readiness, and obeys its parent lifeline", { timeout: 30_000 }, async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    const output = resolve(mkdtempSync(resolve(tmpdir(), "hmr-helper-")), "helper");
    execFileSync(process.execPath, [resolve("bin/build-helper.mjs"), "--output", output], { stdio: "pipe", timeout: 30_000 });
    expect(execFileSync(output, ["--version"], { encoding: "utf8" }).trim()).toBe("0.1.0");
    expect(execFileSync(output, ["--help"], { encoding: "utf8" })).toContain("app-state");
    const home = resolve(output, "../home");
    const configPath = resolve(home, ".local/share/subagent-model-router/config.json");
    mkdirSync(resolve(configPath, ".."), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(defaultGlobalConfig(resolve(configPath, "..")), null, 2)}\n`);
    expect(execFileSync(output, ["--config", configPath, "hook", "codex-pretool"], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: { agent_type: "unknown" } }) })).toBe("");
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
