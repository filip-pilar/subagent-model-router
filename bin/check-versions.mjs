#!/usr/bin/env node
/* global console */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (path) => readFile(resolve(root, path), "utf8");
const packageJson = JSON.parse(await read("package.json"));
const packageLock = JSON.parse(await read("package-lock.json"));
const source = await read("src/version.ts");
const plist = await read("macos/SubagentModelRouterApp/Info.plist");
const nodeVersion = (await read(".node-version")).trim();
const bunVersion = (await read(".bun-version")).trim();

const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["src/version.ts", /ROUTER_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1]],
  ["macOS Info.plist", /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]],
]);
const expected = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  const details = [...versions].map(([location, version]) => `${location}: ${String(version)}`).join("\n");
  throw new Error(`Release versions are not synchronized (expected ${expected}):\n${details}`);
}
const minimumNode = /^>=(\d+)/.exec(String(packageJson.engines?.node ?? ""))?.[1];
if (!/^\d+$/.test(nodeVersion) || !minimumNode || Number(nodeVersion) < Number(minimumNode)) {
  throw new Error(`.node-version (${nodeVersion}) must be a major version supported by package.json engines.node`);
}
if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) throw new Error(`.bun-version must contain an exact semantic version; received ${bunVersion}`);
if (!String(packageJson.packageManager ?? "").startsWith("npm@")) throw new Error("package.json packageManager must pin npm");

console.log(`Versions synchronized at ${expected}; Node ${nodeVersion}, Bun ${bunVersion}, ${packageJson.packageManager}.`);
