import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

void test("0.9.3 release metadata is synchronized", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const manifest = readJson("manifest.json");
  const versions = readJson("versions.json");
  assert.equal(packageJson.version, "0.9.3");
  assert.equal(packageLock.version, "0.9.3");
  assert.equal(packageLock.packages[""]["version"], "0.9.3");
  assert.equal(manifest.version, "0.9.3");
  assert.equal(manifest.author, "Len_shan");
  assert.equal(versions["0.9.3"], "1.13.0");
});
