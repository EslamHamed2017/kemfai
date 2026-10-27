#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptsDir, "..");
const manifestPath = join(scriptsDir, "t093-suite-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const integrationDir = join(repoDir, "backend/api/test/integration");
const verifierPath =
  "test/integration/audit-source-linkage.integration-spec.ts";
const entries = new Map(manifest.suites.map((suite) => [suite.path, suite]));
const integrationPaths = readdirSync(integrationDir)
  .filter((name) => name.endsWith(".integration-spec.ts"))
  .map((name) => `test/integration/${name}`)
  .filter((path) => path !== verifierPath);
const integrationPathSet = new Set(integrationPaths);

function fail(message) {
  process.stderr.write(`T093 manifest: ${message}\n`);
  process.exitCode = 1;
}

if (entries.size !== manifest.suites.length) fail("duplicate suite path");
for (const suite of manifest.suites) {
  if (
    typeof suite.run !== "boolean" ||
    typeof suite.rationale !== "string" ||
    !suite.rationale.trim()
  ) {
    fail(`invalid entry ${suite.path}`);
    continue;
  }
  if (suite.path === verifierPath)
    fail(`verifier must not be classified: ${suite.path}`);
  else if (!integrationPathSet.has(suite.path))
    fail(`unknown integration suite: ${suite.path}`);
  for (const [name, value] of Object.entries(suite.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
      fail(`unsafe environment setting in ${suite.path}`);
    }
  }
}

for (const path of integrationPaths) {
  if (!entries.has(path)) fail(`integration suite is unclassified: ${path}`);
}

if (process.argv[2] === "list") {
  for (const suite of manifest.suites) {
    const environment = Object.entries(suite.env ?? {}).map(
      ([key, value]) => `${key}=${value}`,
    );
    if (suite.run)
      process.stdout.write(`${suite.path}\t${environment.join(" ")}\n`);
  }
} else if (process.argv[2] !== "check") {
  fail("usage: t093_manifest.mjs check|list");
}
