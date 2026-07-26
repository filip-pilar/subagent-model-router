import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { defaultConfig, saveConfig } from "../src/config.js";
import type { RouterConfig } from "../src/types.js";

export async function temporaryRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "subagent-model-router-test-"));
}

export async function testConfig(root: string): Promise<{ config: RouterConfig; path: string }> {
  const config = defaultConfig(root);
  config.gateway.port = 9476;
  const path = resolve(root, ".subagent-model-router/config.json");
  await saveConfig(path, config);
  return { config, path };
}

export interface Capture { path: string; headers: Record<string, string | string[] | undefined>; body: any }

export interface CaptureResponse { status?: number; headers?: Record<string, string>; body?: string; chunks?: string[] }

export async function captureServer(handler?: (capture: Capture, request: IncomingMessage) => CaptureResponse): Promise<{ server: Server; url: string; captures: Capture[] }> {
  const captures: Capture[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const capture = { path: request.url ?? "", headers: request.headers, body: raw ? JSON.parse(raw) : undefined };
    captures.push(capture);
    const result = handler?.(capture, request) ?? { body: JSON.stringify({ ok: true }) };
    response.statusCode = result.status ?? 200;
    for (const [name, value] of Object.entries(result.headers ?? { "content-type": "application/json" })) response.setHeader(name, value);
    if (result.chunks) {
      for (const chunk of result.chunks) {
        response.write(chunk);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
      response.end();
    } else response.end(result.body ?? JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return { server, url: `http://127.0.0.1:${address.port}`, captures };
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
