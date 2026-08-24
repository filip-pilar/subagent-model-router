import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../src/discovery.js";
import { temporaryRoot } from "./helpers.js";

describe("agent discovery", () => {
  it("finds built-ins, global Claude agents, and supported Codex roles without modifying files", async () => {
    const root = await temporaryRoot();
    const home = resolve(root, "home");
    const paths = {
      claudeUser: resolve(home, ".claude/agents/user-agent.md"),
      codexUser: resolve(home, ".codex/agents/reviewer.toml"),
      codexMcp: resolve(home, ".codex/agents/docs-researcher.toml"),
      codexSkills: resolve(home, ".codex/agents/ui-fixer.toml"),
      codexInvalidShape: resolve(home, ".codex/agents/invalid-shape.toml"),
      codexProviderOverride: resolve(home, ".codex/agents/provider-override.toml"),
      codexProvidersOverride: resolve(home, ".codex/agents/providers-override.toml"),
      codexCatalogOverride: resolve(home, ".codex/agents/catalog-override.toml"),
      codexMalformed: resolve(home, ".codex/agents/malformed.toml"),
      codexDeclared: resolve(home, ".codex/configured/declared.toml"),
    };
    for (const path of Object.values(paths)) await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(paths.claudeUser, "---\nname: user-agent\ndescription: user\nmodel: sonnet\n---\nPrompt\n");
    await writeFile(paths.codexUser, 'name = "reviewer"\ndescription = "review"\ndeveloper_instructions = "review"\nmodel = "gpt-custom"\nmodel_reasoning_summary = "none"\n');
    await writeFile(paths.codexMcp, 'name = "docs-researcher"\ndescription = "research"\ndeveloper_instructions = "use docs"\nmodel = "gpt-docs"\n[mcp_servers.openai]\nurl = "https://example.invalid/mcp"\n');
    await writeFile(paths.codexSkills, 'name = "ui-fixer"\ndescription = "fix UI"\ndeveloper_instructions = "apply focused fixes"\nmodel = "gpt-ui"\n[[skills.config]]\npath = "/tmp/example-skill/SKILL.md"\nenabled = false\n');
    await writeFile(paths.codexInvalidShape, 'name = "invalid-shape"\ndescription = "invalid known field"\ndeveloper_instructions = "do not route as V2"\nmodel = "gpt-custom"\nsandbox_mode = ["read-only"]\n');
    await writeFile(paths.codexProviderOverride, 'name = "provider-override"\ndescription = "private provider"\ndeveloper_instructions = "use private provider"\nmodel = "gpt-custom"\nmodel_provider = "private"\n');
    await writeFile(paths.codexProvidersOverride, 'name = "providers-override"\ndescription = "private provider table"\ndeveloper_instructions = "use private provider"\nmodel = "gpt-custom"\n[model_providers.private]\nbase_url = "https://provider.example/v1"\n');
    await writeFile(paths.codexCatalogOverride, 'name = "catalog-override"\ndescription = "private catalog"\ndeveloper_instructions = "use private catalog"\nmodel = "gpt-custom"\nmodel_catalog_json = "/tmp/private-catalog.json"\n');
    await writeFile(paths.codexMalformed, 'name = "malformed"\nmodel = "gpt-custom"\n');
    await writeFile(paths.codexDeclared, 'name = "file-override"\nmodel = "gpt-declared"\n');
    await writeFile(resolve(home, ".codex/config.toml"), '[agents.declared]\ndescription = "declared role"\nconfig_file = "./configured/declared.toml"\n');
    const result = await discover({ home });
    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ harness: "claude", name: "Explore", kind: "built-in" }),
      expect.objectContaining({ harness: "claude", name: "user-agent", kind: "user" }),
      expect.objectContaining({ harness: "codex", name: "reviewer", kind: "user", explicitModel: "gpt-custom", codexV2Eligible: true }),
      expect.objectContaining({ harness: "codex", name: "docs-researcher", kind: "user", explicitModel: "gpt-docs", codexV2Eligible: true }),
      expect.objectContaining({ harness: "codex", name: "ui-fixer", kind: "user", explicitModel: "gpt-ui", codexV2Eligible: true }),
      expect.objectContaining({ harness: "codex", name: "file-override", kind: "user", explicitModel: "gpt-declared", codexV2Eligible: true }),
    ]));
    expect(result.agents.find((agent) => agent.name === "malformed")).toMatchObject({ explicitModel: "gpt-custom" });
    expect(result.agents.find((agent) => agent.name === "malformed")?.codexV2Eligible).not.toBe(true);
    expect(result.agents.find((agent) => agent.name === "invalid-shape")?.codexV2Eligible).not.toBe(true);
    for (const name of ["provider-override", "providers-override", "catalog-override"]) {
      expect(result.agents.find((agent) => agent.name === name)).toMatchObject({ explicitModel: "gpt-custom" });
      expect(result.agents.find((agent) => agent.name === name)?.codexV2Eligible).not.toBe(true);
    }
  });
});
