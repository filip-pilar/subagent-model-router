import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { installIntegration } from "../src/lifecycle.js";
import { close, temporaryRoot, writeJson } from "./helpers.js";

const GATEWAY_OPENAI = process.env.HMR_LLM_GATEWAY_OPENAI_URL ?? "http://127.0.0.1:4317/openai/v1";
const GATEWAY_CLAUDE = process.env.HMR_LLM_GATEWAY_CLAUDE_URL ?? "http://127.0.0.1:4317/claude";
const ENTITLED_MODEL = process.env.HMR_LLM_GATEWAY_MODEL ?? "swe-1-6-slow";
const DENIED_MODEL = process.env.HMR_LLM_GATEWAY_DENIED_MODEL ?? "swe-1-7-lightning";
const live = process.env.HMR_LIVE_LLM_GATEWAY === "1";
const servers: Server[] = [];

interface UpstreamCapture { url: string; body: Record<string, any>; headers: Record<string, string>; responseStatus?: number; responseContentType?: string }

afterEach(async () => { while (servers.length) await close(servers.pop()!); });

describe("live LLM Gateway integration", () => {
  (live ? it : it.skip)("runs a real Claude parent and Explore child through LLM Gateway and verifies cleanup", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const claudeConfig = resolve(home, ".claude");
    const project = resolve(root, "project");
    await mkdir(claudeConfig, { recursive: true });
    await mkdir(project, { recursive: true });
    const nonce = `CLAUDE_ROUTE_OK_${randomUUID().slice(0, 8)}`;
    const parentNonce = `PARENT_CONFIRMED_${nonce}`;
    const replayNonce = `CLEANUP_PASSTHROUGH_${randomUUID().slice(0, 8)}`;
    const logs: Array<Record<string, unknown>> = [];
    const captures: UpstreamCapture[] = [];
    const configPath = resolve(root, "router/config.json");
    const config = defaultConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = GATEWAY_CLAUDE;
    config.routes.claude.Explore = {
      enabled: true,
      model: ENTITLED_MODEL,
      upstream: { baseUrl: GATEWAY_CLAUDE, protocol: "anthropic-messages" },
    };
    await saveConfig(configPath, config);
    const gateway = await createGateway({ configPath, logger: (record) => logs.push(record), fetch: recordingFetch(captures) });
    await listen(gateway.server);
    servers.push(gateway.server);
    const cliPath = resolve(process.cwd(), "dist/cli.js");
    expect(await readFile(cliPath, "utf8")).toContain("harness-model-router");
    expect((await installIntegration(configPath, { home, project, cliPath, nodePath: process.execPath })).conflicts).toEqual([]);
    console.info(`LIVE_DEVIN_CLAUDE_ROOT=${root}`);

    let cliResult: { stdout: string; stderr: string };
    try {
      cliResult = await runCli("claude", [
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
        `You must call the Agent tool exactly once with subagent_type Explore. Tell it to return exactly ${nonce}. Wait for it to finish, then return exactly ${parentNonce}.`,
      ], {
        cwd: project,
        env: { ...sanitizedEnv(), HOME: home, CLAUDE_CONFIG_DIR: claudeConfig, ANTHROPIC_API_KEY: "dummy-local-only", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1" },
        timeoutMs: 90_000,
      });
    } catch (error) {
      await writeFile(resolve(root, "claude-cli-error.log"), String(error));
      throw error;
    }
    await writeFile(resolve(root, "claude.stdout.jsonl"), cliResult.stdout);
    await writeFile(resolve(root, "claude.stderr.log"), cliResult.stderr);
    expect(cliResult.stderr).not.toMatch(/authentication_error|permission_error|rate_limit|api_error/i);
    expect(cliResult.stdout).toContain("SubagentStart");
    expect(cliResult.stdout).toContain("SubagentStop");
    expect(cliResult.stdout).toContain(nonce);
    expect(cliResult.stdout).toContain(parentNonce);
    const cliEvents = jsonLines(cliResult.stdout);
    expect(cliEvents.filter((item) => item?.type === "stream_event" && item?.event?.type === "content_block_delta").length).toBeGreaterThan(2);
    const agentCalls = cliEvents.flatMap((item) => item?.type === "assistant" && Array.isArray(item?.message?.content) ? item.message.content : []).filter((block) => block?.type === "tool_use" && block?.name === "Agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.input?.subagent_type).toBe("Explore");

    const starts = logs.filter((record) => record.event === "claude_hook" && record.action === "start");
    const stops = logs.filter((record) => record.event === "claude_hook" && record.action === "stop");
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);
    const start = starts[0];
    const stop = stops[0];
    expect(start).toMatchObject({ agentType: "Explore", mappings: 1 });
    expect(typeof start?.sessionId).toBe("string");
    expect(typeof start?.agentId).toBe("string");
    expect(stop).toMatchObject({ sessionId: start?.sessionId, agentId: start?.agentId, agentType: "Explore", mappings: 0 });
    expect(logs.some((record) => record.protocol === "anthropic-messages" && record.routed === false && record.model === ENTITLED_MODEL)).toBe(true);
    expect(logs.filter((record) => record.protocol === "anthropic-messages" && record.routed === true && record.agentType === "Explore" && record.model === ENTITLED_MODEL)).toHaveLength(1);

    const childCapture = captures.find((capture) => capture.headers["x-claude-code-agent-id"] === start?.agentId);
    expect(childCapture?.url).toMatch(/\/claude\/v1\/messages/);
    expect(childCapture?.body.model).toBe(ENTITLED_MODEL);
    expect(JSON.stringify(childCapture?.body.messages)).toContain(nonce);
    expect(childCapture?.responseStatus).toBe(200);
    expect(childCapture?.responseContentType).toMatch(/text\/event-stream/);
    expect(captures.some((capture) => !capture.headers["x-claude-code-agent-id"] && capture.body.model === ENTITLED_MODEL)).toBe(true);

    const status = await routerStatus(config.gateway.port);
    expect(status.mappings).toBe(0);
    const replay = await fetch(`http://127.0.0.1:${config.gateway.port}/claude/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy-local-only", "x-claude-code-session-id": String(start?.sessionId), "x-claude-code-agent-id": String(start?.agentId) },
      body: JSON.stringify({ model: ENTITLED_MODEL, max_tokens: 32, stream: true, messages: [{ role: "user", content: `Reply with exactly ${replayNonce}` }] }),
    });
    const replayText = await replay.text();
    if (!replay.ok) throw new Error(`LLM Gateway cleanup replay returned ${replay.status}: ${replayText}`);
    expect(logs.at(-1)?.routed).toBe(false);
    expect(anthropicTextDeltas(replayText)).toContain(replayNonce);
    expect((await routerStatus(config.gateway.port)).mappings).toBe(0);
    await writeJson(resolve(root, "combined-evidence.json"), { root, home, claudeConfig, project, configPath, nonce, parentNonce, replayNonce, status, start, stop, logs, captures });
  }, 90_000);

  (live ? it : it.skip)("passes main Codex traffic and routes a real hidden-alias session with V1 metadata", async (context) => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const codexHome = resolve(home, ".codex");
    const project = resolve(root, "project");
    await mkdir(codexHome, { recursive: true });
    await mkdir(project, { recursive: true });
    const nonce = `CODEX_ROUTE_OK_${randomUUID().slice(0, 8)}`;
    const bundled = JSON.parse(execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8", env: { ...sanitizedEnv(), CODEX_HOME: codexHome } })) as { models: Array<Record<string, any>> };
    const template = bundled.models[0];
    if (!template) throw new Error("Installed Codex catalog is empty");
    const sourceCatalog = {
      ...bundled,
      models: [{
        ...template,
        slug: ENTITLED_MODEL,
        display_name: ENTITLED_MODEL,
        description: "LLM Gateway live-test model",
        visibility: "list",
        base_instructions: "You are a tool-use test agent. When the user asks you to call a function tool, invoke that tool immediately. Never describe, promise, or simulate a tool call in text. For spawn_agent, call it and then use wait_agent until the child completes.",
      }],
    };
    const logs: Array<Record<string, unknown>> = [];
    const captures: UpstreamCapture[] = [];
    const configPath = resolve(root, "router/config.json");
    const config = defaultConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.originalUpstream.baseUrl = GATEWAY_OPENAI;
    config.harnesses.codex.parentModels = [ENTITLED_MODEL];
    config.harnesses.codex.sourceCatalogPath = resolve(root, "source-catalog.json");
    config.routes.codex.explorer = {
      enabled: true,
      alias: "router-explorer",
      model: ENTITLED_MODEL,
      upstream: { baseUrl: GATEWAY_OPENAI, protocol: "openai-responses" },
      requiredMultiAgentVersion: "v1",
    };
    await writeJson(config.harnesses.codex.sourceCatalogPath, sourceCatalog);
    await saveConfig(configPath, config);
    const gateway = await createGateway({ configPath, logger: (record) => logs.push(record), fetch: recordingFetch(captures) });
    await listen(gateway.server);
    servers.push(gateway.server);
    await writeFile(resolve(codexHome, "config.toml"), `model = ${JSON.stringify(ENTITLED_MODEL)}\nmodel_provider = "original"\nmodel_reasoning_effort = "low"\n\n[model_providers.original]\nname = "LLM Gateway"\nbase_url = ${JSON.stringify(GATEWAY_OPENAI)}\nenv_key = "LLM_GATEWAY_TEST_KEY"\nwire_api = "responses"\n\n[features]\nmulti_agent = true\nmulti_agent_v2 = false\nremote_plugin = false\nplugins = false\napps = false\n`);
    const cliPath = resolve(process.cwd(), "dist/cli.js");
    expect((await installIntegration(configPath, { home, project, cliPath, nodePath: process.execPath })).conflicts).toEqual([]);

    let spawnAttempt: { stdout: string; stderr: string };
    try {
      spawnAttempt = await runCli("codex", [
        "exec",
        "--dangerously-bypass-hook-trust",
        "--skip-git-repo-check",
        "--ephemeral",
        "--json",
        `You must call spawn_agent exactly once with agent_type explorer and message "Return exactly ${nonce}". Wait for it. Then output exactly PARENT_CONFIRMED_${nonce}.`,
      ], { cwd: project, env: { ...sanitizedEnv(), CODEX_HOME: codexHome, LLM_GATEWAY_TEST_KEY: "dummy-local-only" }, timeoutMs: 120_000 });
    } catch (error) {
      if (/429|rate limit/i.test(String(error))) {
        expect(logs.some((record) => record.protocol === "openai-responses" && record.routed === false && record.model === ENTITLED_MODEL)).toBe(true);
        context.skip("LLM Gateway OpenAI model is rate-limited");
        return;
      }
      throw error;
    }

    expect(spawnAttempt.stdout).toContain(nonce);
    expect(logs.some((record) => record.protocol === "openai-responses" && record.routed === false && record.model === ENTITLED_MODEL)).toBe(true);
    const parentRequest = captures[0];
    expect(parentRequest?.body.model).toBe(ENTITLED_MODEL);

    const aliasNonce = `CODEX_ALIAS_OK_${randomUUID().slice(0, 8)}`;
    const aliasResult = await runCli("codex", [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--model", "router-explorer",
      `Return exactly ${aliasNonce}.`,
    ], { cwd: project, env: { ...sanitizedEnv(), CODEX_HOME: codexHome, LLM_GATEWAY_TEST_KEY: "dummy-local-only" }, timeoutMs: 120_000 });
    expect(aliasResult.stdout).toContain(aliasNonce);
    expect(logs.some((record) => record.protocol === "openai-responses" && record.routed === true && record.agentType === "explorer" && record.model === ENTITLED_MODEL)).toBe(true);
    expect(logs.some((record) => record.model === "router-explorer")).toBe(false);
    expect(captures.every((capture) => capture.body.model !== "router-explorer")).toBe(true);
    const overlay = JSON.parse(await readFile(config.harnesses.codex.overlayCatalogPath!, "utf8")) as { models: Array<Record<string, any>> };
    expect(overlay.models.find((model) => model.slug === ENTITLED_MODEL)?.multi_agent_version).toBe("v1");
    expect(overlay.models.find((model) => model.slug === "router-explorer")).toMatchObject({ visibility: "hide", multi_agent_version: "v1" });

    config.routes.codex.explorer.model = DENIED_MODEL;
    await saveConfig(configPath, config);
    const denied = await fetch(`http://127.0.0.1:${config.gateway.port}/codex/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy-local-only" },
      body: JSON.stringify({ model: "router-explorer", input: "denied route probe", stream: false, max_output_tokens: 16 }),
    });
    expect(denied.ok).toBe(false);
    expect(await denied.text()).toMatch(/not entitled|model_not_entitled/i);
  }, 180_000);

  (live ? it : it.skip)("preserves routed entitlement errors on both bridge protocols", async () => {
    const root = await temporaryRoot();
    const logs: Array<Record<string, unknown>> = [];
    const configPath = resolve(root, "router/config.json");
    const config = defaultConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = GATEWAY_CLAUDE;
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.originalUpstream.baseUrl = GATEWAY_OPENAI;
    config.routes.claude.Explore = { enabled: true, model: DENIED_MODEL, upstream: { baseUrl: GATEWAY_CLAUDE, protocol: "anthropic-messages" } };
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: DENIED_MODEL, upstream: { baseUrl: GATEWAY_OPENAI, protocol: "openai-responses" } };
    await saveConfig(configPath, config);
    const gateway = await createGateway({ configPath, logger: (record) => logs.push(record) });
    await listen(gateway.server);
    servers.push(gateway.server);

    await claudeHook(config.gateway.port, "start", "entitlement-session", "entitlement-agent", "Explore");
    const claude = await fetch(`http://127.0.0.1:${config.gateway.port}/claude/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy-local-only", "x-claude-code-session-id": "entitlement-session", "x-claude-code-agent-id": "entitlement-agent" },
      body: JSON.stringify({ model: ENTITLED_MODEL, max_tokens: 8, stream: false, messages: [{ role: "user", content: "entitlement probe" }] }),
    });
    expect(claude.ok).toBe(false);
    expect(await claude.text()).toMatch(/not entitled|permission_error/i);
    await claudeHook(config.gateway.port, "stop", "entitlement-session", "entitlement-agent", "Explore");

    const codex = await fetch(`http://127.0.0.1:${config.gateway.port}/codex/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy-local-only" },
      body: JSON.stringify({ model: "router-explorer", input: "entitlement probe", stream: false, max_output_tokens: 8 }),
    });
    expect(codex.ok).toBe(false);
    expect(await codex.text()).toMatch(/not entitled|model_not_entitled/i);
    expect(logs.filter((record) => record.routed === true && record.model === DENIED_MODEL)).toHaveLength(2);
    expect((await fetch(`http://127.0.0.1:${config.gateway.port}/__router/status`).then((response) => response.json()) as { mappings: number }).mappings).toBe(0);
  }, 30_000);
});

async function claudeHook(portNumber: number, action: "start" | "stop", sessionId: string, agentId: string, agentType: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${portNumber}/__router/claude/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: action === "start" ? "SubagentStart" : "SubagentStop", session_id: sessionId, agent_id: agentId, agent_type: agentType }),
  });
  if (!response.ok) throw new Error(`Claude hook returned ${response.status}`);
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[name];
  return env;
}

function recordingFetch(captures: UpstreamCapture[]): typeof fetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : {};
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const capture: UpstreamCapture = { url: String(input), body, headers };
    captures.push(capture);
    const response = await fetch(input, init);
    capture.responseStatus = response.status;
    capture.responseContentType = response.headers.get("content-type") ?? undefined;
    return response;
  };
}

async function routerStatus(portNumber: number): Promise<{ mappings: number }> {
  return fetch(`http://127.0.0.1:${portNumber}/__router/status`).then((response) => response.json()) as Promise<{ mappings: number }>;
}

function jsonLines(value: string): any[] {
  return value.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function anthropicTextDeltas(value: string): string {
  return value.split("\n").filter((line) => line.startsWith("data: ")).flatMap((line) => {
    try {
      const event = JSON.parse(line.slice("data: ".length));
      return event?.delta?.type === "text_delta" ? [String(event.delta.text)] : [];
    } catch { return []; }
  }).join("");
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.listen(9476, "127.0.0.1", resolvePromise));
}

async function runCli(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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
