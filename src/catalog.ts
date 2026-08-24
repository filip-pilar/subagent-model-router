import type { RouterConfig } from "./types.js";
import { routeUpstream } from "./config.js";

export interface ModelCatalogEntry {
  slug: string;
  display_name?: string;
  visibility?: string;
  multi_agent_version?: string;
  [key: string]: unknown;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  [key: string]: unknown;
}

export function overlayCatalog(source: ModelCatalog, config: RouterConfig): ModelCatalog {
  const models = source.models.map((model) => structuredClone(model));
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  const enabledV1 = Object.values(config.routes.codex).filter((route) => route.enabled && routeUpstream(config, "codex", route) && route.requiredMultiAgentVersion === "v1");
  const template = models[0];
  for (const route of Object.values(config.routes.codex)) {
    if (!routeUpstream(config, "codex", route)) continue;
    if (!route.alias) continue;
    const persistent = Object.values(config.preserved.customCodexAgents).some((entry) => entry.alias === route.alias);
    if (!route.enabled && !persistent) continue;
    const existing = bySlug.get(route.alias);
    const real = bySlug.get(route.model);
    if (!existing && !real && !template) throw new Error(`Cannot create catalog alias ${route.alias}: source catalog has no template model`);
    const alias: ModelCatalogEntry = existing ?? structuredClone(real ?? template!);
    alias.slug = route.alias;
    alias.display_name = route.alias;
    alias.visibility = "hide";
    if (route.enabled && route.requiredMultiAgentVersion === "v1") alias.multi_agent_version = "v1";
    else if (alias.multi_agent_version === "v1") delete alias.multi_agent_version;
    if (!existing) models.push(alias);
    bySlug.set(route.alias, alias);
  }
  if (enabledV1.length > 0) {
    for (const parentSlug of config.harnesses.codex.parentModels) {
      const parent = bySlug.get(parentSlug);
      if (!parent) throw new Error(`V1 parent model ${parentSlug} is missing from the source catalog`);
      parent.multi_agent_version = "v1";
    }
  }
  return { ...structuredClone(source), models };
}

export function catalogOverlaySummary(source: ModelCatalog, overlaid: ModelCatalog): Array<{ slug: string; kind: "alias" | "metadata"; multiAgentVersion?: string }> {
  const original = new Map(source.models.map((model) => [model.slug, model]));
  const summary: Array<{ slug: string; kind: "alias" | "metadata"; multiAgentVersion?: string }> = [];
  for (const model of overlaid.models) {
    const before = original.get(model.slug);
    if (!before) summary.push({ slug: model.slug, kind: "alias", ...(model.multi_agent_version ? { multiAgentVersion: model.multi_agent_version } : {}) });
    else if (before.multi_agent_version !== model.multi_agent_version) summary.push({ slug: model.slug, kind: "metadata", ...(model.multi_agent_version ? { multiAgentVersion: model.multi_agent_version } : {}) });
  }
  return summary;
}
