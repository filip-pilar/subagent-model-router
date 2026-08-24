import type { Upstream } from "./types.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-auth-token",
  "x-access-token",
  "cookie",
  "cookie2",
]);

export function forwardedHeaders(source: Headers, original: Upstream, target: Upstream, env: NodeJS.ProcessEnv = process.env): Headers {
  const output = new Headers();
  const connectionTokens = new Set((source.get("connection") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  const preserveCredentials = sameOrigin(original.baseUrl, target.baseUrl);
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower) || lower === "host" || lower === "content-length") continue;
    if (!preserveCredentials && isCredentialHeader(lower, original)) continue;
    output.set(name, value);
  }
  output.delete("content-encoding");
  if (target.authorization) {
    const value = env[target.authorization.env];
    if (!value) throw new Error(`Authorization environment variable ${target.authorization.env} is not set`);
    output.set(target.authorization.header ?? "Authorization", target.authorization.scheme ? `${target.authorization.scheme} ${value}` : value);
  }
  return output;
}

function isCredentialHeader(name: string, original: Upstream): boolean {
  const configured = (original.authorization?.header ?? "Authorization").toLowerCase();
  return name === configured
    || (original.credentialHeaders ?? []).some((header) => name === header.toLowerCase())
    || CREDENTIAL_HEADERS.has(name)
    || /(?:^|[-_])(?:api[-_]?key|token|secret|credential)(?:$|[-_])/.test(name);
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

export function responseHeaders(source: Headers): Headers {
  const output = new Headers();
  const connectionTokens = new Set((source.get("connection") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !connectionTokens.has(lower) && lower !== "content-length") output.set(name, value);
  }
  output.delete("content-encoding");
  return output;
}
