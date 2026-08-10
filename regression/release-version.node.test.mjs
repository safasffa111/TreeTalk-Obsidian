import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

void test("release metadata is synchronized", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const manifest = readJson("manifest.json");
  const versions = readJson("versions.json");
  const version = packageJson.version;

  assert.equal(typeof version, "string");
  assert.notEqual(version.trim(), "");
  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[""]["version"], version);
  assert.equal(manifest.version, version);
  assert.equal(manifest.author, "Len_shan");
  assert.equal(versions[version], manifest.minAppVersion);
});

void test("release workflow runs the complete quality gate", () => {
  const packageJson = readJson("package.json");
  const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.equal(packageJson.scripts.check, "npm run verify && npm run regression");
  assert.match(releaseWorkflow, /npm run check/u);
});
