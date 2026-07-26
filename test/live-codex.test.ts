import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createGateway } from "../src/gateway.js";
import { defaultConfig, saveConfig } from "../src/config.js";
import { installIntegration } from "../src/lifecycle.js";
import { captureServer, close, temporaryRoot, writeJson, type Capture } from "./helpers.js";

const live = (process.env.SMR_LIVE_CODEX ?? process.env.HMR_LIVE_CODEX) === "1" && hasCodex();
const servers: Server[] = [];
afterEach(async () => { while (servers.length) await close(servers.pop()!); });

describe("live Codex V1 integration", () => {
  (live ? it : it.skip)("delivers a readable assignment while retaining the parent wire model and upstream", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const codexHome = resolve(home, ".codex");
    const project = resolve(root, "project");
    await mkdir(codexHome, { recursive: true });
    await mkdir(project, { recursive: true });
    const nonce = `SMR_${randomUUID().replaceAll("-", "")}`;
    const sourceCatalog = JSON.parse(execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } })) as { models: Array<Record<string, any>> };
    const parentModel = String(sourceCatalog.models[0]?.slug);
    expect(parentModel).toBeTruthy();

    let parentTurn = 0;
    const original = await captureServer((capture) => {
      const input = Array.isArray(capture.body.input) ? capture.body.input : [];
      const isUnroutedChild = JSON.stringify(input).includes(nonce) && !input.some((item: any) => item?.type === "function_call");
      if (isUnroutedChild) return sseMessage("unrouted-child", nonce);
      if (parentTurn === 0) {
        parentTurn += 1;
        return sseFunction("parent-spawn", "spawn-call", "spawn_agent", { message: `Return exactly ${nonce}`, agent_type: "explorer" }, "multi_agent_v1");
      }
      if (parentTurn === 1) {
        parentTurn += 1;
        const output = input.find((item: any) => item?.type === "function_call_output" && item.call_id === "spawn-call")?.output;
        const parsed = typeof output === "string" ? JSON.parse(output) : output;
        const agentId = parsed?.agent_id;
        if (typeof agentId !== "string") return sseMessage("bad-spawn", "missing agent id");
        return sseFunction("parent-wait", "wait-call", "wait_agent", { targets: [agentId], timeout_ms: 10_000 }, "multi_agent_v1");
      }
      parentTurn += 1;
      return sseMessage("parent-final", `PARENT_CONFIRMED_${nonce}`);
    });
    const child = await captureServer(() => sseMessage("child-final", nonce));
    servers.push(original.server, child.server);

    const configPath = resolve(root, "router/config.json");
    const config = defaultConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.originalUpstream.baseUrl = original.url;
    config.harnesses.codex.parentModels = [parentModel];
    config.harnesses.codex.sourceCatalogPath = resolve(root, "source-catalog.json");
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: "independent-child-wire", upstream: { baseUrl: child.url, protocol: "openai-responses" }, requiredMultiAgentVersion: "v1" };
    await writeJson(config.harnesses.codex.sourceCatalogPath, sourceCatalog);
    await saveConfig(configPath, config);
    const gateway = await createGateway({ configPath });
    await new Promise<void>((resolvePromise) => gateway.server.listen(9476, "127.0.0.1", resolvePromise));
    servers.push(gateway.server);

    await writeFile(resolve(codexHome, "config.toml"), `model = ${JSON.stringify(parentModel)}\nmodel_provider = "original"\n\n[model_providers.original]\nname = "Original mock"\nbase_url = ${JSON.stringify(`${original.url}/v1`)}\nenv_key = "CODEX_LIVE_KEY"\nwire_api = "responses"\n\n[features]\nmulti_agent = true\nmulti_agent_v2 = false\nremote_plugin = false\nplugins = false\napps = false\n`);
    const cliPath = resolve(process.cwd(), "dist/cli.js");
    expect(await readFile(cliPath, "utf8")).toContain("subagent-model-router");
    const installed = await installIntegration(configPath, { home, project, cliPath, nodePath: process.execPath });
    expect(installed.conflicts).toEqual([]);

    const { stdout, stderr } = await runCodex(["exec", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--ephemeral", "--json", "Delegate one exploration task, wait for it, then finish."], {
      cwd: project,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_LIVE_KEY: "not-a-secret" },
      timeoutMs: 25_000,
    });
    expect(stderr).not.toMatch(/error:/i);
    expect(stdout).toContain(`PARENT_CONFIRMED_${nonce}`);
    expect(child.captures).toHaveLength(1);
    expect(child.captures[0]?.body.model).toBe("independent-child-wire");
    expect(JSON.stringify(child.captures[0]?.body.input)).toContain(nonce);
    expect(original.captures.every((capture) => capture.body.model === parentModel)).toBe(true);
    expect(original.captures.some((capture) => JSON.stringify(capture.body.input).includes(nonce) && JSON.stringify(capture.body.input).includes("wait-call"))).toBe(true);
    expect(allModels([...original.captures, ...child.captures])).not.toContain("router-explorer");
    const overlay = JSON.parse(await readFile(config.harnesses.codex.overlayCatalogPath!, "utf8"));
    expect(overlay.models.find((model: any) => model.slug === parentModel).multi_agent_version).toBe("v1");
    expect(overlay.models.find((model: any) => model.slug === "router-explorer")).toMatchObject({ visibility: "hide", multi_agent_version: "v1" });
  }, 30_000);
});

function sseFunction(responseId: string, callId: string, name: string, argumentsValue: unknown, namespace: string): { headers: Record<string, string>; body: string } {
  return sse([
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.done", item: { type: "function_call", call_id: callId, namespace, name, arguments: JSON.stringify(argumentsValue) } },
    completed(responseId),
  ]);
}

function sseMessage(responseId: string, text: string): { headers: Record<string, string>; body: string } {
  return sse([{ type: "response.output_item.done", item: { type: "message", role: "assistant", id: `${responseId}-message`, content: [{ type: "output_text", text }] } }, completed(responseId)]);
}

function sse(events: unknown[]): { headers: Record<string, string>; body: string } {
  return { headers: { "content-type": "text/event-stream" }, body: events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") };
}

function completed(id: string): unknown {
  return { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } };
}

function allModels(captures: Capture[]): string[] { return captures.map((capture) => String(capture.body.model)); }
function hasCodex(): boolean { try { execFileSync("codex", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }

async function runCodex(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const processChild = spawn("codex", args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
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
      else reject(new Error(`codex exited with ${code ?? signal}: ${result.stderr}`));
    });
    processChild.stdin.end();
  });
}
