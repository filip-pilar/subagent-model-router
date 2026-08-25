import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { createGateway } from "../src/gateway.js";
import { saveConfig } from "../src/config.js";
import { captureServer, close, temporaryRoot, testConfig } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => { while (servers.length) await close(servers.pop()!); });

describe("localhost gateway acceptance", () => {
  it("preserves main models/upstreams, routes identified agents, and passes unknown agents through", async () => {
    const root = await temporaryRoot();
    const original = await captureServer();
    const custom = await captureServer();
    servers.push(original.server, custom.server);
    const { config, path } = await testConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.codex.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = original.url;
    config.harnesses.codex.originalUpstream.baseUrl = original.url;
    config.harnesses.codex.originalUpstream.credentialHeaders = ["X-Auth"];
    config.destinations.routed = { name: "Routed", anthropicBaseUrl: custom.url, openaiBaseUrl: custom.url };
    config.mainRoutes.claude = { enabled: true, model: "claude-main-routed", destination: "routed" };
    config.mainRoutes.codex = { enabled: true, model: "codex-main-routed", destination: "routed" };
    config.routes.claude.Explore = { enabled: true, model: "claude-routed", upstream: { baseUrl: custom.url, protocol: "anthropic-messages" } };
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: "codex-routed", upstream: { baseUrl: custom.url, protocol: "openai-responses" } };
    await saveConfig(path, config);
    const gateway = await createGateway({ configPath: path });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    servers.push(gateway.server);
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("gateway address missing");
    const url = `http://127.0.0.1:${address.port}`;

    await consume(fetch(`${url}/claude/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer original", "x-main": "yes" }, body: JSON.stringify({ model: "claude-main", messages: [], max_tokens: 1 }) }));
    await consume(fetch(`${url}/__router/claude/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "SubagentStart", session_id: "session-a", agent_id: "agent-1", agent_type: "Explore" }) }));
    await consume(fetch(`${url}/claude/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer original", cookie: "session=secret", "x-provider-token": "provider-secret", "X-Claude-Code-Session-Id": "session-a", "X-Claude-Code-Agent-Id": "agent-1" }, body: JSON.stringify({ model: "claude-main", messages: [], max_tokens: 1 }) }));
    await consume(fetch(`${url}/__router/claude/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "session-a", agent_id: "agent-1", agent_type: "Explore" }) }));
    await consume(fetch(`${url}/claude/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "X-Claude-Code-Session-Id": "session-a", "X-Claude-Code-Agent-Id": "agent-1" }, body: JSON.stringify({ model: "claude-main", messages: [], max_tokens: 1 }) }));
    gateway.identities.register("session-b", "agent-1", "Unknown");
    await consume(fetch(`${url}/claude/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "X-Claude-Code-Session-Id": "session-b", "X-Claude-Code-Agent-Id": "agent-1" }, body: JSON.stringify({ model: "claude-main", messages: [], max_tokens: 1 }) }));
    await consume(fetch(`${url}/codex/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: "Bearer original", "X-Auth": "original-secret" }, body: gzipSync(JSON.stringify({ model: "codex-parent", input: "main" })) }));
    await consume(fetch(`${url}/codex/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer original", "X-Auth": "original-secret" }, body: JSON.stringify({ model: "router-explorer", input: "child" }) }));

    expect(original.captures.map((item) => item.body.model)).toEqual(["claude-main"]);
    expect(custom.captures.map((item) => item.body.model)).toEqual(["claude-main-routed", "claude-routed", "claude-main-routed", "codex-main-routed", "codex-routed"]);
    expect(custom.captures.every((item) => item.headers.authorization === undefined)).toBe(true);
    expect(custom.captures.every((item) => item.headers.cookie === undefined && item.headers["x-provider-token"] === undefined)).toBe(true);
    expect(custom.captures.every((item) => item.headers["x-auth"] === undefined)).toBe(true);
    expect(original.captures[0]?.path).toBe("/v1/messages");
    expect(custom.captures[3]?.path).toBe("/v1/responses");
  });

  it("streams upstream bytes and applies configured environment authorization", async () => {
    const root = await temporaryRoot();
    const original = await captureServer();
    const custom = await captureServer(() => ({ headers: { "content-type": "text/event-stream", "x-stream": "yes" }, body: "event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\n" }));
    servers.push(original.server, custom.server);
    const { config, path } = await testConfig(root);
    config.harnesses.codex.enabled = true;
    config.harnesses.codex.originalUpstream.baseUrl = original.url;
    config.routes.codex.worker = { enabled: true, alias: "router-worker", model: "wire-worker", upstream: { baseUrl: custom.url, protocol: "openai-responses", authorization: { env: "ROUTER_TEST_KEY", scheme: "Bearer" } } };
    await saveConfig(path, config);
    const before = process.env.ROUTER_TEST_KEY;
    process.env.ROUTER_TEST_KEY = "custom-secret";
    try {
      const gateway = await createGateway({ configPath: path });
      await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
      servers.push(gateway.server);
      const address = gateway.server.address();
      if (!address || typeof address === "string") throw new Error("gateway address missing");
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer old" }, body: JSON.stringify({ model: "router-worker", input: "x", stream: true }) });
      expect(response.headers.get("x-stream")).toBe("yes");
      expect(await response.text()).toContain('"delta":"ok"');
      expect(custom.captures[0]?.headers.authorization).toBe("Bearer custom-secret");
    } finally {
      if (before === undefined) delete process.env.ROUTER_TEST_KEY;
      else process.env.ROUTER_TEST_KEY = before;
    }
  });

  it("does not cross-talk under concurrent session reuse", async () => {
    const root = await temporaryRoot();
    const first = await captureServer();
    const second = await captureServer();
    const original = await captureServer();
    const main = await captureServer();
    servers.push(first.server, second.server, original.server, main.server);
    const { config, path } = await testConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = original.url;
    config.destinations.main = { name: "Main", anthropicBaseUrl: main.url };
    config.mainRoutes.claude = { enabled: true, model: "main-model", destination: "main" };
    config.routes.claude.Explore = { enabled: true, model: "first-model", upstream: { baseUrl: first.url, protocol: "anthropic-messages" } };
    config.routes.claude.Plan = { enabled: true, model: "second-model", upstream: { baseUrl: second.url, protocol: "anthropic-messages" } };
    await saveConfig(path, config);
    const gateway = await createGateway({ configPath: path });
    gateway.identities.register("one", "shared", "Explore");
    gateway.identities.register("two", "shared", "Plan");
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    servers.push(gateway.server);
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("gateway address missing");
    const url = `http://127.0.0.1:${address.port}/v1/messages`;
    await Promise.all(Array.from({ length: 60 }, (_, index) => {
      const headers = index % 3 === 0
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", "X-Claude-Code-Session-Id": index % 3 === 1 ? "one" : "two", "X-Claude-Code-Agent-Id": "shared" };
      return consume(fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "original-main", messages: [], max_tokens: 1 }) }));
    }));
    expect(first.captures).toHaveLength(20);
    expect(second.captures).toHaveLength(20);
    expect(main.captures).toHaveLength(20);
    expect(original.captures).toHaveLength(0);
    expect(first.captures.every((item) => item.body.model === "first-model")).toBe(true);
    expect(second.captures.every((item) => item.body.model === "second-model")).toBe(true);
    expect(main.captures.every((item) => item.body.model === "main-model")).toBe(true);
  });

  it("continues using the last valid configuration while an external edit is invalid", async () => {
    const root = await temporaryRoot();
    const original = await captureServer();
    servers.push(original.server);
    const { config, path } = await testConfig(root);
    config.harnesses.codex.originalUpstream.baseUrl = original.url;
    await saveConfig(path, config);
    const records: Array<Record<string, unknown>> = [];
    const gateway = await createGateway({ configPath: path, logger: (record) => records.push(record) });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    servers.push(gateway.server);
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("gateway address missing");
    await writeFile(path, "{ invalid json");
    const response = await fetch(`http://127.0.0.1:${address.port}/__router/readiness`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-subagent-model-router")).toBe("1");
    expect(records.some((record) => record.event === "config_invalid")).toBe(true);
  });
});

async function consume(response: Promise<Response>): Promise<void> {
  await (await response).arrayBuffer();
}
