import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, saveConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { installIntegration } from "../src/lifecycle.js";
import { captureServer, close, temporaryRoot, type CaptureResponse } from "./helpers.js";

const live = (process.env.SMR_LIVE_CLAUDE ?? process.env.HMR_LIVE_CLAUDE) === "1" && hasClaude();
const servers: Server[] = [];
afterEach(async () => { while (servers.length) await close(servers.pop()!); });

describe("live Claude Code integration", () => {
  (live ? it : it.skip)("routes a real hooked subagent while preserving and cleaning up main traffic", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const claudeConfig = resolve(home, ".claude");
    const project = resolve(root, "project");
    await mkdir(claudeConfig, { recursive: true });
    await mkdir(project, { recursive: true });
    const nonce = `SMR_${randomUUID().replaceAll("-", "")}`;
    const parentModel = "claude-sonnet-4-6";
    const childModel = "independent-claude-wire";

    const original = await captureServer((capture) => {
      const messages = Array.isArray(capture.body.messages) ? capture.body.messages : [];
      const agentId = header(capture, "x-claude-code-agent-id");
      if (agentId) return anthropicText(String(capture.body.model), nonce);
      const hasToolResult = messages.some((message: any) => Array.isArray(message?.content) && message.content.some((block: any) => block?.type === "tool_result"));
      if (hasToolResult) return anthropicText(String(capture.body.model), `PARENT_CONFIRMED_${nonce}`);
      const agentTool = Array.isArray(capture.body.tools)
        ? capture.body.tools.find((tool: any) => tool?.name === "Agent" || tool?.name === "Task")
        : undefined;
      if (!agentTool) return { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Agent tool was not offered" } }) };
      return anthropicTool(String(capture.body.model), String(agentTool.name), {
        description: "Live route probe",
        prompt: `Return exactly ${nonce}`,
        subagent_type: "Explore",
      });
    });
    const child = await captureServer((capture) => anthropicText(String(capture.body.model), nonce));
    servers.push(original.server, child.server);

    const configPath = resolve(root, "router/config.json");
    const config = defaultConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = original.url;
    config.routes.claude.Explore = {
      enabled: true,
      model: childModel,
      upstream: { baseUrl: child.url, protocol: "anthropic-messages" },
    };
    await saveConfig(configPath, config);
    const gateway = await createGateway({ configPath });
    await new Promise<void>((resolvePromise) => gateway.server.listen(9476, "127.0.0.1", resolvePromise));
    servers.push(gateway.server);

    const cliPath = resolve(process.cwd(), "dist/cli.js");
    expect(await readFile(cliPath, "utf8")).toContain("subagent-model-router");
    const installed = await installIntegration(configPath, { home, project, cliPath, nodePath: process.execPath });
    expect(installed.conflicts).toEqual([]);

    const { stdout, stderr } = await runClaude([
      "--print",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--include-hook-events",
      "--verbose",
      "--no-session-persistence",
      "--setting-sources", "user",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--tools", "Agent",
      "--allowedTools", "Agent",
      "--dangerously-skip-permissions",
      "--model", parentModel,
      `Delegate one exploration task. The child must return exactly ${nonce}; then finish.`,
    ], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: claudeConfig,
        ANTHROPIC_API_KEY: "dummy-local-key",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      timeoutMs: 25_000,
    });

    expect(stderr).not.toMatch(/error:/i);
    expect(stdout).toContain(`PARENT_CONFIRMED_${nonce}`);
    expect(stdout).toContain("SubagentStart");
    expect(stdout).toContain("SubagentStop");
    const streamEvents = stdout.split("\n").flatMap((line) => {
      try { return [JSON.parse(line) as any]; } catch { return []; }
    }).filter((item) => item?.type === "stream_event" && item?.event?.type === "content_block_delta");
    expect(streamEvents.length).toBeGreaterThanOrEqual(5);
    expect(child.captures).toHaveLength(1);
    const routedChild = child.captures[0]!;
    expect(routedChild.body.model).toBe(childModel);
    expect(JSON.stringify(routedChild.body.messages)).toContain(nonce);
    const sessionId = header(routedChild, "x-claude-code-session-id");
    const agentId = header(routedChild, "x-claude-code-agent-id");
    expect(sessionId).toBeTruthy();
    expect(agentId).toBeTruthy();
    expect(original.captures.length).toBeGreaterThanOrEqual(2);
    expect(original.captures.every((capture) => capture.body.model === parentModel)).toBe(true);
    expect(original.captures.every((capture) => !header(capture, "x-claude-code-agent-id"))).toBe(true);

    const status = await fetch("http://127.0.0.1:9476/__router/status").then((response) => response.json()) as { mappings: number };
    expect(status.mappings).toBe(0);
    const replay = await fetch("http://127.0.0.1:9476/claude/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "dummy-local-key",
        "x-claude-code-session-id": sessionId!,
        "x-claude-code-agent-id": agentId!,
      },
      body: JSON.stringify({ model: parentModel, max_tokens: 16, stream: true, messages: [{ role: "user", content: "cleanup probe" }] }),
    });
    expect(replay.ok).toBe(true);
    await replay.text();
    expect(child.captures).toHaveLength(1);
    expect(original.captures.at(-1)?.body.model).toBe(parentModel);
    expect(header(original.captures.at(-1)!, "x-claude-code-agent-id")).toBe(agentId);
  }, 30_000);
});

function anthropicTool(model: string, name: string, input: unknown): CaptureResponse {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const toolId = `toolu_${randomUUID().replaceAll("-", "")}`;
  return anthropicSse([
    event("message_start", { type: "message_start", message: message(id, model) }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name, input: {} } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } }),
    event("message_stop", { type: "message_stop" }),
  ]);
}


function anthropicText(model: string, text: string): CaptureResponse {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  const split = Math.max(1, Math.floor(text.length / 2));
  return anthropicSse([
    event("message_start", { type: "message_start", message: message(id, model) }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, split) } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(split) } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }),
    event("message_stop", { type: "message_stop" }),
  ]);
}

function anthropicSse(chunks: string[]): CaptureResponse {
  return { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, chunks };
}

function event(name: string, value: unknown): string { return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`; }
function message(id: string, model: string): unknown {
  return { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}
function header(capture: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = capture.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
function hasClaude(): boolean { try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }

async function runClaude(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const processChild = spawn("claude", args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    processChild.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    processChild.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => processChild.kill("SIGKILL"), options.timeoutMs);
    processChild.once("error", reject);
    processChild.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolvePromise(result);
      else reject(new Error(`claude exited with ${code ?? signal}: ${result.stderr}\n${result.stdout}`));
    });
    processChild.stdin.end();
  });
}
