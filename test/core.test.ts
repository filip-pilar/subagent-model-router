import { describe, expect, it } from "vitest";
import { ClaudeIdentityStore } from "../src/identity.js";
import { decideClaudeRoute, decideCodexRoute, codexHookOutput } from "../src/routing.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { forwardedHeaders } from "../src/headers.js";
import { redact } from "../src/redact.js";

describe("Claude identity", () => {
  it("isolates concurrent sessions, expires entries, and removes stopped agents", () => {
    let now = 100;
    const store = new ClaudeIdentityStore(10, { now: () => now });
    store.register("session-a", "same-agent", "Explore");
    store.register("session-b", "same-agent", "Plan");
    expect(store.resolve("session-a", "same-agent")).toBe("Explore");
    expect(store.resolve("session-b", "same-agent")).toBe("Plan");
    expect(store.remove("session-a", "same-agent")).toBe(true);
    expect(store.resolve("session-a", "same-agent")).toBeUndefined();
    now = 111;
    expect(store.resolve("session-b", "same-agent")).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("routing", () => {
  it("passes main and unknown Claude traffic through and routes only an enabled identity", () => {
    const config = defaultConfig("/tmp/project");
    config.harnesses.claude.enabled = true;
    config.routes.claude.Explore = { enabled: true, model: "claude-fast", upstream: { baseUrl: "http://custom", protocol: "anthropic-messages" } };
    expect(decideClaudeRoute(config, "claude-main").reason).toBe("main");
    expect(decideClaudeRoute(config, "claude-main", "Unknown").reason).toBe("unknown");
    expect(decideClaudeRoute(config, "claude-main", "Explore")).toMatchObject({ reason: "enabled", wireModel: "claude-fast", routed: true });
  });

  it("replaces aliases and resolves persistent disabled aliases to the original model", () => {
    const config = defaultConfig("/tmp/project");
    config.harnesses.codex.enabled = true;
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "real-child", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };
    expect(decideCodexRoute(config, "parent-model")).toMatchObject({ reason: "main", wireModel: "parent-model" });
    expect(decideCodexRoute(config, "router-reviewer")).toMatchObject({ reason: "enabled", wireModel: "real-child" });
    config.preserved.customCodexAgents["/agent.toml"] = { agentType: "reviewer", path: "/agent.toml", alias: "router-reviewer", originalModel: "original-child", originalModelLine: 'model = "original-child"', installedModelLine: 'model = "router-reviewer"', modelOffset: 0, originalContentHash: "x", installedContentHash: "x" };
    config.routes.codex.reviewer.enabled = false;
    expect(decideCodexRoute(config, "router-reviewer")).toMatchObject({ reason: "persistent-disabled", wireModel: "original-child", upstream: config.harnesses.codex.originalUpstream });
  });

  it("rewrites only exact configured Codex agent_type values", () => {
    const config = defaultConfig("/tmp/project");
    config.harnesses.codex.enabled = true;
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: "real", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };
    expect(codexHookOutput(config, "collaborationspawn_agent", { agent_type: "explorer", message: "x" })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { agent_type: "explorer", message: "x", model: "router-explorer" } } });
    expect(codexHookOutput(config, "spawn_agent", { agent_type: "unknown" })).toBeUndefined();
    expect(codexHookOutput(config, "other", { agent_type: "explorer" })).toBeUndefined();
  });
});

describe("validation and safety", () => {
  it("rejects cross-protocol routes and unsupported multi-agent versions", () => {
    const config: any = defaultConfig("/tmp/project");
    config.routes.claude.bad = { enabled: true, model: "gpt", upstream: { baseUrl: "http://example.test", protocol: "openai-responses" } };
    config.routes.codex.bad = { enabled: true, alias: "router-bad", model: "claude", upstream: { baseUrl: "http://example.test", protocol: "anthropic-messages" }, requiredMultiAgentVersion: "v2" };
    expect(validateConfig(config).join("\n")).toMatch(/cross-protocol|must be anthropic-messages/);
    expect(validateConfig(config).join("\n")).toMatch(/supports only v1/);
  });

  it("keeps same-origin credentials and isolates credentials between destination origins", () => {
    const original = {
      baseUrl: "http://original/v1",
      protocol: "openai-responses" as const,
      authorization: { env: "ORIGINAL_KEY", header: "X-Custom-Auth" },
    };
    const source = new Headers({
      Authorization: "Bearer secret",
      "X-Api-Key": "anthropic-secret",
      "X-Provider-Token": "provider-secret",
      "X-Custom-Auth": "custom-secret",
      Cookie: "session=secret",
      "X-Custom": "keep",
      Connection: "x-remove",
      "X-Remove": "gone",
    });
    const same = forwardedHeaders(source, original, original, { ORIGINAL_KEY: "custom-secret" });
    expect(same.get("authorization")).toBe("Bearer secret");
    expect(same.get("x-api-key")).toBe("anthropic-secret");
    expect(same.get("x-provider-token")).toBe("provider-secret");
    expect(same.get("x-custom-auth")).toBe("custom-secret");
    expect(same.get("cookie")).toBe("session=secret");
    expect(same.get("x-custom")).toBe("keep");
    expect(same.has("x-remove")).toBe(false);
    const unauthenticatedTarget = { baseUrl: "http://custom/v1", protocol: "openai-responses" as const };
    const isolated = forwardedHeaders(source, original, unauthenticatedTarget);
    expect(isolated.has("authorization")).toBe(false);
    expect(isolated.has("x-api-key")).toBe(false);
    expect(isolated.has("x-provider-token")).toBe(false);
    expect(isolated.has("x-custom-auth")).toBe(false);
    expect(isolated.has("cookie")).toBe(false);
    expect(isolated.get("x-custom")).toBe("keep");
    const target = { baseUrl: "http://custom/v1", protocol: "openai-responses" as const, authorization: { env: "CUSTOM_KEY", scheme: "Bearer" } };
    const routed = forwardedHeaders(source, original, target, { CUSTOM_KEY: "new-secret" });
    expect(routed.get("authorization")).toBe("Bearer new-secret");
    expect(routed.has("x-api-key")).toBe(false);
    const apiKeyTarget = { ...target, authorization: { env: "CUSTOM_KEY", header: "X-Api-Key" } };
    expect(forwardedHeaders(source, original, apiKeyTarget, { CUSTOM_KEY: "destination-secret" }).get("x-api-key")).toBe("destination-secret");
    const tokenTarget = { ...target, authorization: { env: "CUSTOM_KEY", header: "X-Provider-Token" } };
    expect(forwardedHeaders(source, original, tokenTarget, { CUSTOM_KEY: "replacement-token" }).get("x-provider-token")).toBe("replacement-token");
  });

  it("redacts credentials recursively and in error text", () => {
    expect(redact({ Authorization: "Bearer abc", nested: "token=abc" })).toEqual({ Authorization: "[REDACTED]", nested: "token=[REDACTED]" });
  });
});
