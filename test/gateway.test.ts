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

    expect(original.captures.map((item) => item.body.model)).toEqual(["claude-main", "claude-main", "claude-main", "codex-parent"]);
    expect(custom.captures.map((item) => item.body.model)).toEqual(["claude-routed", "codex-routed"]);
    expect(original.captures[0]?.headers.authorization).toBe("Bearer original");
    expect(custom.captures.every((item) => item.headers.authorization === undefined)).toBe(true);
    expect(custom.captures.every((item) => item.headers.cookie === undefined && item.headers["x-provider-token"] === undefined)).toBe(true);
    expect(custom.captures.every((item) => item.headers["x-auth"] === undefined)).toBe(true);
    expect(original.captures[3]?.headers["x-auth"]).toBe("original-secret");
    expect(original.captures[0]?.path).toBe("/v1/messages");
    expect(original.captures[3]?.path).toBe("/v1/responses");
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
    servers.push(first.server, second.server, original.server);
    const { config, path } = await testConfig(root);
    config.harnesses.claude.enabled = true;
    config.harnesses.claude.originalUpstream.baseUrl = original.url;
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
    await Promise.all(Array.from({ length: 40 }, (_, index) => consume(fetch(url, { method: "POST", headers: { "content-type": "application/json", "X-Claude-Code-Session-Id": index % 2 ? "one" : "two", "X-Claude-Code-Agent-Id": "shared" }, body: JSON.stringify({ model: "main", messages: [], max_tokens: 1 }) }))));
    expect(first.captures).toHaveLength(20);
    expect(second.captures).toHaveLength(20);
    expect(first.captures.every((item) => item.body.model === "first-model")).toBe(true);
    expect(second.captures.every((item) => item.body.model === "second-model")).toBe(true);
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
