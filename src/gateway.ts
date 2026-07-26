import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { decompress as zstdDecompress } from "fzstd";
import { adaptAnthropicRequest, adaptOpenAIRequest, protocolForPath, upstreamUrl } from "./adapters.js";
import { loadConfig } from "./config.js";
import { forwardedHeaders, responseHeaders } from "./headers.js";
import { ClaudeIdentityStore } from "./identity.js";
import { safeError } from "./redact.js";
import type { ClaudeHookInput, RouterConfig } from "./types.js";
import { ROUTER_VERSION } from "./version.js";

export interface GatewayOptions {
  configPath: string;
  fetch?: typeof globalThis.fetch;
  logger?: (record: Record<string, unknown>) => void;
}

export async function createGateway(options: GatewayOptions): Promise<{ server: Server; identities: ClaudeIdentityStore; config: RouterConfig }> {
  const initial = await loadConfig(options.configPath);
  const configState = { value: initial };
  const identities = new ClaudeIdentityStore(initial.harnesses.claude.mappingTtlMs);
  const requestFetch = options.fetch ?? globalThis.fetch;
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, options.configPath, configState, identities, requestFetch, options.logger);
    } catch (error) {
      if (!response.headersSent) json(response, 502, { error: { type: "gateway_error", message: safeError(error) } });
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { server, identities, config: initial };
}

export async function listenGateway(options: GatewayOptions): Promise<Server> {
  const { server, config } = await createGateway(options);
  if (!config.gateway.enabled) throw new Error("Gateway is disabled in configuration");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.gateway.port, config.gateway.host, () => resolve());
  });
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  configPath: string,
  configState: { value: RouterConfig },
  identities: ClaudeIdentityStore,
  requestFetch: typeof globalThis.fetch,
  logger?: (record: Record<string, unknown>) => void,
): Promise<void> {
  let config = configState.value;
  try {
    config = await loadConfig(configPath);
    configState.value = config;
  } catch (error) {
    logger?.({ event: "config_invalid", error: safeError(error) });
  }
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/__router/status" || requestUrl.pathname === "/__router/readiness") {
    response.setHeader("x-subagent-model-router", "1");
    return void json(response, 200, {
      ready: true,
      service: "subagent-model-router",
      version: ROUTER_VERSION,
      mappings: identities.size,
      harnesses: { claude: config.harnesses.claude.enabled, codex: config.harnesses.codex.enabled },
      routeCount: { claude: Object.keys(config.routes.claude).length, codex: Object.keys(config.routes.codex).length },
    });
  }
  if (requestUrl.pathname === "/__router/claude/start" || requestUrl.pathname === "/__router/claude/stop") {
    if (request.method !== "POST") return void json(response, 405, { error: "method_not_allowed" });
    const input = JSON.parse((await readBody(request, config.gateway.maxBodyBytes)).toString("utf8")) as ClaudeHookInput;
    validateClaudeHook(input, requestUrl.pathname.endsWith("start") ? "SubagentStart" : "SubagentStop");
    if (input.hook_event_name === "SubagentStart") identities.register(input.session_id, input.agent_id, input.agent_type);
    else identities.remove(input.session_id, input.agent_id);
    logger?.({ event: "claude_hook", action: input.hook_event_name === "SubagentStart" ? "start" : "stop", sessionId: input.session_id, agentId: input.agent_id, agentType: input.agent_type, mappings: identities.size });
    return void json(response, 204, undefined);
  }
  const protocol = protocolForPath(requestUrl.pathname);
  if (!protocol) return void json(response, 404, { error: "not_found" });
  if (request.method !== "POST") return void json(response, 405, { error: "method_not_allowed" });
  const raw = decodeBody(await readBody(request, config.gateway.maxBodyBytes), request.headers["content-encoding"]);
  if (raw.length > config.gateway.maxBodyBytes) throw new Error(`Decoded request body exceeds ${config.gateway.maxBodyBytes} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return void json(response, 400, { error: { type: "invalid_request", message: "Request body must be valid JSON" } });
  }
  const inputHeaders = nodeHeaders(request);
  const adapted = protocol === "anthropic-messages"
    ? adaptAnthropicRequest(config, identities, inputHeaders, body)
    : adaptOpenAIRequest(config, body);
  const harnessConfig = protocol === "anthropic-messages" ? config.harnesses.claude : config.harnesses.codex;
  const target = upstreamUrl(adapted.decision.upstream.baseUrl, protocol, requestUrl.search);
  const outgoingHeaders = forwardedHeaders(inputHeaders, harnessConfig.originalUpstream, adapted.decision.upstream);
  outgoingHeaders.set("content-type", "application/json");
  logger?.({ event: "proxy", protocol, routed: adapted.decision.routed, agentType: adapted.decision.agentType, model: adapted.decision.wireModel, upstream: target.origin });
  let upstream: Response;
  try {
    upstream = await requestFetch(target, { method: "POST", headers: outgoingHeaders, body: JSON.stringify(adapted.body), redirect: "manual" });
  } catch (error) {
    throw new Error(`Upstream ${target.origin} is unavailable: ${safeError(error)}`);
  }
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of responseHeaders(upstream.headers)) response.setHeader(name, value);
  if (!upstream.body) return void response.end();
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), response);
}

function validateClaudeHook(value: ClaudeHookInput, expected: ClaudeHookInput["hook_event_name"]): void {
  if (value.hook_event_name !== expected || typeof value.session_id !== "string" || typeof value.agent_id !== "string" || typeof value.agent_type !== "string") {
    throw new Error(`Invalid ${expected} hook input`);
  }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function nodeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding || encoding === "identity") return body;
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "gzip") return gunzipSync(body);
  if (normalized === "deflate") return inflateSync(body);
  if (normalized === "br") return brotliDecompressSync(body);
  if (normalized === "zstd") return Buffer.from(zstdDecompress(body));
  throw new Error(`Unsupported request content-encoding: ${encoding}`);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  if (status === 204) return void response.end();
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
