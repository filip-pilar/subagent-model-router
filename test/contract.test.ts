import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

interface AppStateContract {
  config: unknown;
  integration: { claude: boolean; codex: boolean };
  detection: Record<"claude" | "codex", { detected: boolean; version?: string; cliPath?: string; appPath?: string }>;
  agents: Array<{ harness: string; name: string; kind: string; path?: string; explicitModel?: string; codexV2Eligible?: boolean }>;
  codexParentModel?: string;
}

describe("helper/app JSON contract", () => {
  it("keeps the shared v2 app-state fixture valid for the TypeScript helper", async () => {
    const fixture = JSON.parse(await readFile(resolve("contracts/app-state-v2.json"), "utf8")) as AppStateContract;
    const config = parseConfig(fixture.config);

    expect(config.version).toBe(2);
    expect(config.routes.claude.Explore?.authorization?.header).toBe("X-Api-Key");
    expect(config.routes.codex.explorer).toMatchObject({
      alias: "router-explorer",
    });
    expect(config.routes.codex.explorer?.requiredMultiAgentVersion).toBeUndefined();
    expect(config.mainRoutes.claude).toMatchObject({ enabled: true, model: "claude-main-routed" });
    expect(config.mainRoutes.codex).toMatchObject({ enabled: false, model: "codex-main-routed" });
    expect(config.harnesses.codex.originalUpstream.credentialHeaders).toEqual(["Authorization", "X-Original-Auth"]);
    expect(fixture.integration).toEqual({ claude: true, codex: true });
    expect(fixture.detection.codex.appPath).toBe("/Applications/Codex.app");
    expect(fixture.agents.map((agent) => `${agent.harness}:${agent.name}`)).toEqual(["claude:Explore", "codex:explorer"]);
    expect(fixture.agents[1]?.codexV2Eligible).toBe(true);
    expect(fixture.codexParentModel).toBe("parent-model");
  });
});
