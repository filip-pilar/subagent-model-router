#!/usr/bin/env node
/* global process */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "macos", "SubagentModelRouterApp");
const app = join(root, "dist", "Subagent Model Router.app");
const legacyApp = join(root, "dist", "Harness Model Router.app");
const contents = join(app, "Contents"), macos = join(contents, "MacOS"), resources = join(contents, "Resources");
const helper = join(root, ".build", "macos", "subagent-model-router-helper");
const legacyHelper = join(root, ".build", "macos", "harness-model-router-helper");
const scratch = join(root, ".build", "macos-swift-release"), moduleCache = join(root, ".build", "swift-module-cache");

function run(command, args, capture = false) {
  mkdirSync(moduleCache, { recursive: true });
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit", env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFTPM_MODULECACHE_OVERRIDE: moduleCache } });
  if (result.error) throw result.error;
  if (result.status !== 0) { if (capture) process.stderr.write(result.stderr || result.stdout); process.exit(result.status || 1); }
  return result.stdout?.trim();
}

if (!app.startsWith(`${root}/dist/`) || !legacyApp.startsWith(`${root}/dist/`) || !helper.startsWith(`${root}/.build/`) || !legacyHelper.startsWith(`${root}/.build/`) || !scratch.startsWith(`${root}/.build/`)) throw new Error("Refusing unsafe build paths");
rmSync(app, { recursive: true, force: true });
rmSync(legacyApp, { recursive: true, force: true });
rmSync(legacyHelper, { force: true });
mkdirSync(macos, { recursive: true }); mkdirSync(resources, { recursive: true }); mkdirSync(dirname(helper), { recursive: true });
run("node", [join(root, "bin", "build-helper.mjs"), "--output", helper]);
const swiftArgs = ["build", "--disable-sandbox", "-c", "release", "--package-path", packageRoot, "--scratch-path", scratch, "--triple", "arm64-apple-macosx15.0"];
run("swift", swiftArgs);
const binPath = run("swift", [...swiftArgs, "--show-bin-path"], true);
copyFileSync(join(binPath, "SubagentModelRouterApp"), join(macos, "SubagentModelRouterApp"));
copyFileSync(helper, join(resources, "subagent-model-router-helper"));
copyFileSync(join(packageRoot, "Info.plist"), join(contents, "Info.plist"));
chmodSync(join(macos, "SubagentModelRouterApp"), 0o755); chmodSync(join(resources, "subagent-model-router-helper"), 0o755);
run("plutil", ["-lint", join(contents, "Info.plist")]);
run("codesign", ["--force", "--sign", "-", join(resources, "subagent-model-router-helper")]);
run("codesign", ["--force", "--sign", "-", join(macos, "SubagentModelRouterApp")]);
run("codesign", ["--force", "--deep", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
process.stdout.write(`${app}\n`);
