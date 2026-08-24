import { describe, expect, it } from "vitest";
import { overlayCatalog } from "../src/catalog.js";
import { defaultConfig } from "../src/config.js";

describe("Codex catalog overlays", () => {
  it("adds hidden aliases and scopes V1 to enabled child aliases and named parents", () => {
    const source = { revision: "keep", models: [
      { slug: "parent", display_name: "Parent", multi_agent_version: "v2", untouched: { x: 1 } },
      { slug: "real-child", display_name: "Child", multi_agent_version: "v2", context_window: 100, base_instructions: "retain exactly", shell_type: "shell_command", experimental_supported_tools: ["apply_patch"], supports_parallel_tool_calls: true, capability_data: { nested: [1, 2, 3] } },
      { slug: "unrelated", display_name: "Other", multi_agent_version: "v2" },
    ] };
    const config = defaultConfig("/tmp/project");
    config.harnesses.codex.parentModels = ["parent"];
    config.routes.codex.explorer = { enabled: true, alias: "router-explorer", model: "real-child", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" }, requiredMultiAgentVersion: "v1" };
    const result = overlayCatalog(source, config);
    expect(result.revision).toBe("keep");
    const alias = result.models.find((model) => model.slug === "router-explorer")!;
    expect(alias).toMatchObject({ visibility: "hide", multi_agent_version: "v1", context_window: 100 });
    expect(withoutCatalogIdentity(alias)).toEqual(withoutCatalogIdentity(source.models[1]!));
    expect(result.models.find((model) => model.slug === "parent")).toMatchObject({ display_name: "Parent", multi_agent_version: "v1", untouched: { x: 1 } });
    expect(result.models.find((model) => model.slug === "unrelated")?.multi_agent_version).toBe("v2");
    expect(source.models[0]?.multi_agent_version).toBe("v2");
  });

  it("removes dynamic disabled aliases but retains normalized custom aliases", () => {
    const source = { models: [{ slug: "parent", display_name: "Parent" }] };
    const config = defaultConfig("/tmp/project");
    config.routes.codex.custom = { enabled: false, alias: "router-custom", model: "real", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };
    expect(overlayCatalog(source, config).models.some((model) => model.slug === "router-custom")).toBe(false);
    config.preserved.customCodexAgents["/custom.toml"] = { agentType: "custom", path: "/custom.toml", alias: "router-custom", originalModel: "parent", originalModelLine: 'model = "parent"', installedModelLine: 'model = "router-custom"', modelOffset: 0, originalContentHash: "x", installedContentHash: "x" };
    expect(overlayCatalog(source, config).models.find((model) => model.slug === "router-custom")).toMatchObject({ visibility: "hide" });
  });

  it("does not inherit V1 metadata for a V2 custom-agent alias", () => {
    const source = { models: [{ slug: "real-child", display_name: "Child", multi_agent_version: "v1" }] };
    const config = defaultConfig("/tmp/project");
    config.routes.codex.reviewer = { enabled: true, alias: "router-reviewer", model: "real-child", upstream: { baseUrl: "http://custom/v1", protocol: "openai-responses" } };

    const alias = overlayCatalog(source, config).models.find((model) => model.slug === "router-reviewer");

    expect(alias).toMatchObject({ slug: "router-reviewer", visibility: "hide" });
    expect(alias?.multi_agent_version).toBeUndefined();
  });
});

function withoutCatalogIdentity(model: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(model);
  for (const key of ["slug", "display_name", "visibility", "multi_agent_version"]) delete clone[key];
  return clone;
}
