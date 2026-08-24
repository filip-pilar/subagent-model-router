import { routeFor, routeUpstream } from "./config.js";
import type { RouteDecision, RouterConfig } from "./types.js";

export const CODEX_V1_IDENTITY_REQUIRED = "Codex routing blocked this spawn because stock and dynamic routes require V1 agent_type metadata. Configure the selected parent model for V1 multi-agent routing, then try again.";

export function decideClaudeRoute(config: RouterConfig, originalModel: string, agentType?: string): RouteDecision {
  const original = config.harnesses.claude.originalUpstream;
  if (!agentType) return { harness: "claude", routed: false, reason: "main", wireModel: originalModel, upstream: original };
  const route = routeFor(config, "claude", agentType);
  if (!route) return { harness: "claude", agentType, routed: false, reason: "unknown", wireModel: originalModel, upstream: original };
  if (!route.enabled || !config.harnesses.claude.enabled) return { harness: "claude", agentType, routed: false, reason: "disabled", wireModel: originalModel, upstream: original };
  const upstream = routeUpstream(config, "claude", route);
  if (!upstream) return { harness: "claude", agentType, routed: false, reason: "broken", wireModel: originalModel, upstream: original };
  return { harness: "claude", agentType, routed: true, reason: "enabled", wireModel: route.model, upstream };
}

export function decideCodexRoute(config: RouterConfig, requestedModel: string): RouteDecision {
  const original = config.harnesses.codex.originalUpstream;
  const match = Object.entries(config.routes.codex).find(([, route]) => route.alias === requestedModel);
  if (!match) return { harness: "codex", routed: false, reason: "main", wireModel: requestedModel, upstream: original };
  const [agentType, route] = match;
  const preserved = Object.values(config.preserved.customCodexAgents).find((entry) => entry.alias === requestedModel && entry.agentType === agentType);
  if (route.enabled && config.harnesses.codex.enabled) {
    const upstream = routeUpstream(config, "codex", route);
    if (!upstream) return preserved
      ? { harness: "codex", agentType, routed: false, reason: "persistent-disabled", wireModel: preserved.originalModel, upstream: original, internalAlias: requestedModel }
      : { harness: "codex", agentType, routed: false, reason: "broken", wireModel: requestedModel, upstream: original, internalAlias: requestedModel };
    return { harness: "codex", agentType, routed: true, reason: "enabled", wireModel: route.model, upstream, internalAlias: requestedModel };
  }
  if (preserved) {
    return { harness: "codex", agentType, routed: false, reason: "persistent-disabled", wireModel: preserved.originalModel, upstream: original, internalAlias: requestedModel };
  }
  return { harness: "codex", agentType, routed: false, reason: "disabled", wireModel: requestedModel, upstream: original, internalAlias: requestedModel };
}

export function codexHookOutput(config: RouterConfig, toolName: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!/^(?:Agent|spawn_agent|collaborationspawn_agent|multi_agent_v1\.spawn_agent|functions\.spawn_agent)$/.test(toolName)) return undefined;
  const agentType = input.agent_type;
  if (typeof agentType !== "string") {
    const hasHookDependentRoute = Object.entries(config.routes.codex).some(([routeAgentType, route]) => {
      const preservedV2 = Object.values(config.preserved.customCodexAgents)
        .some((entry) => entry.agentType === routeAgentType && entry.alias === route.alias);
      return config.harnesses.codex.enabled
        && route.enabled
        && Boolean(route.alias)
        && Boolean(routeUpstream(config, "codex", route))
        && (route.requiredMultiAgentVersion === "v1" || !preservedV2);
    });
    return hasHookDependentRoute ? denyCodexSpawn(CODEX_V1_IDENTITY_REQUIRED) : undefined;
  }
  const route = config.routes.codex[agentType];
  if (!config.harnesses.codex.enabled || !route?.enabled || !route.alias || !routeUpstream(config, "codex", route)) return undefined;
  const v2Custom = Object.values(config.preserved.customCodexAgents).some((entry) => entry.agentType === agentType && entry.alias === route.alias);
  if (route.requiredMultiAgentVersion !== "v1" && !v2Custom) {
    return denyCodexSpawn(`Codex route ${JSON.stringify(agentType)} cannot use V2 because V2 routing requires a detected custom agent with an explicit model. Configure this route for V1, then try again.`);
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, model: route.alias },
    },
  };
}

function denyCodexSpawn(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
