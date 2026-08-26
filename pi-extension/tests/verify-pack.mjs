import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const npmCache = mkdtempSync(path.join(tmpdir(), "repoaudit-npm-cache-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this verifier through npm run verify:pack");
let output;
try {
  output = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
const report = JSON.parse(output)[0];
const files = report.files.map((entry) => entry.path);

assert.ok(files.includes("dist/src/index.js"));
assert.ok(files.includes("dist/src/doctor-cli.js"));
assert.ok(files.includes("README.md"));
for (const forbidden of ["node_modules/", ".venv/", "dist/tests/", "log/", "result/", "runs/", "lock/"]) {
  assert.equal(files.some((file) => file.startsWith(forbidden)), false, forbidden);
}
assert.equal(files.some((file) => /(^|\/)(\.env|.*\.log|.*\.tgz)$/.test(file)), false);

const packageRoot = path.resolve(process.cwd());
const embeddedRootVariants = [packageRoot, packageRoot.replaceAll("\\", "/")];
for (const file of files.filter((candidate) => candidate.startsWith("dist/") || candidate === "package.json")) {
  const contents = readFileSync(path.join(packageRoot, file), "utf8");
  for (const embeddedRoot of embeddedRootVariants) {
    assert.equal(contents.includes(embeddedRoot), false, `embedded absolute build path in ${file}`);
  }
}

console.log(JSON.stringify({ fileCount: files.length, unpackedSize: report.unpackedSize, files }, null, 2));
