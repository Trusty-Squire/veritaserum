/**
 * `npm run check:plugin` (SPEC.md §3/§6.12 "distribution pipeline"): validates
 * `.claude-plugin/plugin.json` in isolation — parses as JSON, is named
 * "veritaserum", and its `version` is synced with package.json's. Run in CI
 * (ci.yml + release.yml) so a version bump that forgets the plugin manifest
 * fails fast instead of shipping a stale plugin version.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function fail(message: string): never {
  console.error(`check:plugin: ${message}`);
  process.exit(1);
}

const pkgRaw = readFileSync(resolve(ROOT, "package.json"), "utf8");
const pkg = JSON.parse(pkgRaw) as { version?: string };
if (typeof pkg.version !== "string" || !pkg.version) fail("package.json has no version");

let pluginRaw: string;
try {
  pluginRaw = readFileSync(resolve(ROOT, ".claude-plugin", "plugin.json"), "utf8");
} catch (err) {
  fail(`.claude-plugin/plugin.json is missing or unreadable (${err instanceof Error ? err.message : String(err)})`);
}

let plugin: { name?: string; version?: string };
try {
  plugin = JSON.parse(pluginRaw!) as { name?: string; version?: string };
} catch (err) {
  fail(`.claude-plugin/plugin.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
}

if (plugin.name !== "veritaserum") fail(`plugin.json "name" is "${plugin.name}", expected "veritaserum"`);
if (plugin.version !== pkg.version) {
  fail(`plugin.json version "${plugin.version}" does not match package.json version "${pkg.version}"`);
}

console.log(`check:plugin: OK — .claude-plugin/plugin.json version ${plugin.version} matches package.json`);
