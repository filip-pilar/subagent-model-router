import { describe, expect, it } from "vitest";
import { defaultConfig, migrateConfig, parseConfig, routeUpstream, validateConfig } from "../src/config.js";

describe("desktop configuration", () => {
  it("migrates v1 inline upstreams into reusable destinations without changing routing", () => {
    const legacy: any = defaultConfig("/tmp/example");
    legacy.version = 1;
    delete legacy.destinations;
    legacy.routes.claude.Explore = {
      enabled: true,
      model: "child",
      upstream: { baseUrl: "https://provider.example/claude", protocol: "anthropic-messages", authorization: { env: "LOCAL_KEY" } },
    };
    const config = parseConfig(migrateConfig(legacy));
    const route = config.routes.claude.Explore!;
    expect(config.version).toBe(2);
    expect(config.destinations[route.destination]?.anthropicBaseUrl).toBe("https://provider.example/claude");
    expect(route.authorization?.env).toBe("LOCAL_KEY");
    expect(routeUpstream(config, "claude", route)?.baseUrl).toBe("https://provider.example/claude");
  });

  it("keeps dangling destination references valid but resolves them as broken", () => {
    const config = defaultConfig("/tmp/example");
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: "child", destination: "deleted" };
    expect(validateConfig(config)).toEqual([]);
    expect(routeUpstream(config, "codex", config.routes.codex.explorer)).toBeUndefined();
  });

  it("validates destination protocols and requires at least one URL", () => {
    const config = defaultConfig("/tmp/example");
    config.destinations.empty = { name: "Empty" };
    config.destinations.bad = { name: "Bad", openaiBaseUrl: "file:///tmp/socket" };
    expect(validateConfig(config).join("\n")).toMatch(/at least one protocol URL/);
    expect(validateConfig(config).join("\n")).toMatch(/must use http or https/);
  });

  it("rejects external edits that change the fixed gateway address", () => {
    const wrongHost = defaultConfig("/tmp/example");
    wrongHost.gateway.host = "0.0.0.0";
    expect(() => parseConfig(wrongHost)).toThrow(/gateway\.host must be 127\.0\.0\.1/);
    const wrongPort = defaultConfig("/tmp/example");
    wrongPort.gateway.port = 9576;
    expect(() => parseConfig(wrongPort)).toThrow(/gateway\.port must be 9476/);
  });

  it("normalizes the gateway address while migrating legacy config", () => {
    const legacy: any = defaultConfig("/tmp/example");
    legacy.version = 1;
    legacy.gateway = { ...legacy.gateway, host: "localhost", port: 9576 };
    delete legacy.destinations;
    const migrated = parseConfig(migrateConfig(legacy));
    expect(migrated.gateway).toMatchObject({ host: "127.0.0.1", port: 9476 });
  });
});
