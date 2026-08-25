export type Protocol = "anthropic-messages" | "openai-responses";
export type Harness = "claude" | "codex";

export interface AuthorizationReference {
  env: string;
  header?: string;
  scheme?: string;
}

export interface Upstream {
  baseUrl: string;
  protocol: Protocol;
  authorization?: AuthorizationReference;
  credentialHeaders?: string[];
}

export interface Destination {
  name: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
}

export interface Route {
  enabled: boolean;
  alias?: string;
  model: string;
  destination: string;
  authorization?: AuthorizationReference;
  requiredMultiAgentVersion?: "v1";
}

export interface HarnessConfig {
  enabled: boolean;
  originalUpstream: Upstream;
}

export interface ClaudeHarnessConfig extends HarnessConfig {
  mappingTtlMs: number;
  settingsPath?: string;
}

export interface CodexHarnessConfig extends HarnessConfig {
  hookTimeoutMs: number;
  configPath?: string;
  hooksPath?: string;
  sourceCatalogPath?: string;
  overlayCatalogPath?: string;
  parentModels: string[];
}

export interface PreservedCustomAgent {
  agentType: string;
  path: string;
  alias: string;
  originalModel: string;
  originalModelLine: string;
  installedModelLine: string;
  modelOffset: number;
  originalContentHash: string;
  installedContentHash: string;
}

export interface RouterConfig {
  version: 2;
  gateway: {
    enabled: boolean;
    host: string;
    port: number;
    maxBodyBytes: number;
  };
  destinations: Record<string, Destination>;
  harnesses: {
    claude: ClaudeHarnessConfig;
    codex: CodexHarnessConfig;
  };
  routes: {
    claude: Record<string, Route>;
    codex: Record<string, Route>;
  };
  mainRoutes: {
    claude?: Route;
    codex?: Route;
  };
  preserved: {
    customCodexAgents: Record<string, PreservedCustomAgent>;
  };
}

export interface RouteDecision {
  harness: Harness;
  agentType?: string;
  routed: boolean;
  reason: "main" | "main-disabled" | "main-broken" | "unknown" | "disabled" | "broken" | "enabled" | "persistent-disabled";
  wireModel: string;
  upstream: Upstream;
  internalAlias?: string;
}

export interface ClaudeHookInput {
  hook_event_name: "SubagentStart" | "SubagentStop";
  session_id: string;
  agent_id: string;
  agent_type: string;
}

export interface CodexPreToolInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface DiscoveredAgent {
  harness: Harness;
  name: string;
  kind: "built-in" | "user";
  path?: string;
  explicitModel?: string;
  codexV2Eligible?: boolean;
}

export interface DiscoveryResult {
  agents: DiscoveredAgent[];
  codexCatalog?: {
    path: string;
    models: Array<{ slug: string; multiAgentVersion?: string; visibility?: string }>;
  };
}
