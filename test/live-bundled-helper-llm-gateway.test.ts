import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../src/config.js";
import { temporaryRoot, writeJson } from "./helpers.js";

const GATEWAY_CLAUDE = process.env.SMR_LLM_GATEWAY_CLAUDE_URL ?? process.env.HMR_LLM_GATEWAY_CLAUDE_URL ?? "http://127.0.0.1:4317/claude";
const ENTITLED_MODEL = process.env.SMR_LLM_GATEWAY_MODEL ?? process.env.HMR_LLM_GATEWAY_MODEL ?? "swe-1-6-slow";
const live = (process.env.SMR_LIVE_BUNDLED_HELPER_LLM_GATEWAY ?? process.env.HMR_LIVE_BUNDLED_HELPER_LLM_GATEWAY) === "1";

describe("app-bundled helper with live LLM Gateway", () => {
  (live ? it : it.skip)("runs a real Claude parent and Explore child through the bundled helper", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const claudeConfig = resolve(home, ".claude");
    const project = resolve(root, "project");
    const routerDirectory = resolve(root, "router");
    const configPath = resolve(routerDirectory, "config.json");
    const helper = resolve(process.cwd(), "dist/Subagent Model Router.app/Contents/Resources/subagent-model-router-helper");
    await mkdir(claudeConfig, { recursive: true });
    await mkdir(project, { recursive: true });
    const nonce = `BUNDLED_CHILD_${randomUUID().slice(0, 8)}`;
    const parentNonce = `BUNDLED_PARENT_${randomUUID().slice(0, 8)}`;
    const replayNonce = `BUNDLED_REPLAY_${randomUUID().slice(0, 8)}`;

    const config = defaultConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = GATEWAY_CLAUDE;
    config.routes.claude.Explore = { enabled: true, model: ENTITLED_MODEL, upstream: { baseUrl: GATEWAY_CLAUDE, protocol: "anthropic-messages" } };
    await saveConfig(configPath, config);

    const isolatedEnv = { ...sanitizedEnv(), SMR_HOME: home };
    const setup = await run(helper, ["--config", configPath, "setup", "claude", "--helper-path", helper, "--json"], { cwd: project, env: isolatedEnv, timeoutMs: 30_000 });
    expect(setup.stderr).toBe("");
    const settings = JSON.parse(await readFile(resolve(claudeConfig, "settings.json"), "utf8")) as Record<string, any>;
    expect(settings.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9476/claude");
    expect(JSON.stringify(settings.hooks?.SubagentStart)).toContain(helper);
    expect(JSON.stringify(settings.hooks?.SubagentStop)).toContain(helper);

    const helperProcess = spawn(helper, ["--config", configPath, "start"], { cwd: project, env: isolatedEnv, stdio: ["pipe", "pipe", "pipe"] });
    const helperStdout: Buffer[] = [], helperStderr: Buffer[] = [];
    helperProcess.stdout.on("data", (chunk) => helperStdout.push(Buffer.from(chunk)));
    helperProcess.stderr.on("data", (chunk) => helperStderr.push(Buffer.from(chunk)));
    console.info(`LIVE_BUNDLED_HELPER_ROOT=${root}`);
    try {
      await waitForRouter(helperProcess);
      const claude = await run("claude", [
        "--print",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--include-hook-events",
        "--forward-subagent-text",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources", "user",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--tools", "Agent",
        "--allowedTools", "Agent",
        "--dangerously-skip-permissions",
        "--model", ENTITLED_MODEL,
        `Call the Agent tool exactly once with subagent_type Explore and ask it to return exactly ${nonce}. Wait for it, then return exactly ${parentNonce}.`,
      ], {
        cwd: project,
        env: { ...isolatedEnv, HOME: home, CLAUDE_CONFIG_DIR: claudeConfig, ANTHROPIC_API_KEY: "dummy-local-only", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" },
        timeoutMs: 90_000,
      });
      await writeFile(resolve(root, "claude.stdout.jsonl"), claude.stdout);
      await writeFile(resolve(root, "claude.stderr.log"), claude.stderr);
      expect(claude.stderr).not.toMatch(/authentication_error|permission_error|rate_limit|api_error/i);
      expect(claude.stdout).toContain(nonce);
      expect(claude.stdout).toContain(parentNonce);
      expect(claude.stdout).toContain("SubagentStart");
      expect(claude.stdout).toContain("SubagentStop");
      const cliEvents = jsonLines(claude.stdout);
      const calls = cliEvents.flatMap((item) => item?.type === "assistant" && Array.isArray(item?.message?.content) ? item.message.content : []).filter((block) => block?.type === "tool_use" && block?.name === "Agent");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input?.subagent_type).toBe("Explore");
      expect(cliEvents.filter((item) => item?.type === "stream_event" && item?.event?.type === "content_block_delta").length).toBeGreaterThan(2);

      await eventually(() => helperLogs(helperStderr).some((record) => record.event === "claude_hook" && record.action === "stop"));
      const beforeReplay = helperLogs(helperStderr);
      const starts = beforeReplay.filter((record) => record.event === "claude_hook" && record.action === "start");
      const stops = beforeReplay.filter((record) => record.event === "claude_hook" && record.action === "stop");
      expect(starts).toHaveLength(1);
      expect(stops).toHaveLength(1);
      const start = starts[0];
      expect(start).toMatchObject({ agentType: "Explore", mappings: 1 });
      expect(stops[0]).toMatchObject({ sessionId: start?.sessionId, agentId: start?.agentId, agentType: "Explore", mappings: 0 });
      expect(beforeReplay.filter((record) => record.event === "proxy" && record.routed === true && record.agentType === "Explore" && record.model === ENTITLED_MODEL)).toHaveLength(1);
      expect(beforeReplay.some((record) => record.event === "proxy" && record.routed === false && record.model === ENTITLED_MODEL)).toBe(true);
      expect((await routerStatus()).mappings).toBe(0);

      const replay = await fetch("http://127.0.0.1:9476/claude/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy-local-only", "x-claude-code-session-id": String(start?.sessionId), "x-claude-code-agent-id": String(start?.agentId) },
        body: JSON.stringify({ model: ENTITLED_MODEL, max_tokens: 32, stream: true, messages: [{ role: "user", content: `Return exactly ${replayNonce}` }] }),
      });
      const replayText = await replay.text();
      if (!replay.ok) throw new Error(`Bundled-helper replay returned ${replay.status}: ${replayText}`);
      expect(anthropicTextDeltas(replayText)).toContain(replayNonce);
      await eventually(() => helperLogs(helperStderr).length > beforeReplay.length);
      const finalLogs = helperLogs(helperStderr);
      expect(finalLogs.at(-1)).toMatchObject({ event: "proxy", routed: false, model: ENTITLED_MODEL });
      expect((await routerStatus()).mappings).toBe(0);
      expect(finalLogs.some((record) => record.event === "config_invalid" || record.error)).toBe(false);
      await writeJson(resolve(root, "bundled-helper-evidence.json"), { root, home, claudeConfig, project, routerDirectory, configPath, helper, nonce, parentNonce, replayNonce, setup: JSON.parse(setup.stdout), start, stop: stops[0], logs: finalLogs, status: await routerStatus(), replayStatus: replay.status, replayContentType: replay.headers.get("content-type") });
    } finally {
      helperProcess.kill("SIGTERM");
      await waitForExit(helperProcess);
      await writeFile(resolve(root, "helper.stdout.log"), Buffer.concat(helperStdout));
      await writeFile(resolve(root, "helper.stderr.jsonl"), Buffer.concat(helperStderr));
    }
  }, 120_000);
});

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[name];
  return env;
}

function helperLogs(chunks: Buffer[]): Array<Record<string, any>> {
  return Buffer.concat(chunks).toString("utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
}

function jsonLines(value: string): any[] {
  return value.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function anthropicTextDeltas(value: string): string {
  return value.split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
    try { const event = JSON.parse(line.slice(6)); return event?.delta?.type === "text_delta" ? [String(event.delta.text)] : []; } catch { return []; }
  }).join("");
}

async function routerStatus(): Promise<{ mappings: number }> {
  const response = await fetch("http://127.0.0.1:9476/__router/status");
  if (!response.ok) throw new Error(`Router status returned ${response.status}`);
  return response.json() as Promise<{ mappings: number }>;
}

async function waitForRouter(process: ChildProcessWithoutNullStreams): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Bundled helper exited early with ${process.exitCode}`);
    try { if ((await fetch("http://127.0.0.1:9476/__router/readiness")).ok) return; } catch { /* retry */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Bundled helper did not become ready");
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Expected helper evidence did not arrive");
}

async function waitForExit(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => process.once("close", () => resolvePromise()));
}

async function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolvePromise(result);
      else reject(new Error(`${command} exited with ${code ?? signal}: ${result.stderr}\n${result.stdout}`));
    });
    child.stdin.end();
  });
}
