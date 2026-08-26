import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { acquireRepoAuditFileLock, type RepoAuditLockMetadata } from "../src/adapter/file-lock.js";
import { RepoAuditError } from "../src/adapter/errors.js";

async function lockDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repoaudit-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function options(directory: string, runId: string) {
  return { directory, runId, waitTimeoutMs: 80, staleMs: 60_000, heartbeatMs: 25_000, pollMs: 10 };
}

test("file lock provides mutual exclusion and LOCK_TIMEOUT", async (t) => {
  const directory = await lockDirectory(t);
  const first = await acquireRepoAuditFileLock(options(directory, "run_11111111111111111111111111111111"));
  await assert.rejects(
    acquireRepoAuditFileLock(options(directory, "run_22222222222222222222222222222222")),
    (error: unknown) => error instanceof RepoAuditError && error.code === "LOCK_TIMEOUT",
  );
  await first.release();
  const second = await acquireRepoAuditFileLock(options(directory, "run_22222222222222222222222222222222"));
  await second.release();
});

test("stale lock owned by a dead same-host PID is recovered", async (t) => {
  const directory = await lockDirectory(t);
  const lockPath = path.join(directory, "repoaudit-scan.lock");
  const stale: RepoAuditLockMetadata = {
    ownerToken: "stale-owner",
    pid: 2_147_483_000,
    hostname: hostname(),
    runId: "run_11111111111111111111111111111111",
    createdAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
  };
  await writeFile(lockPath, `${JSON.stringify(stale)}\n`, "utf8");
  const acquired = await acquireRepoAuditFileLock({
    ...options(directory, "run_22222222222222222222222222222222"),
    staleMs: 50,
  });
  assert.notEqual(acquired.metadata.ownerToken, stale.ownerToken);
  await acquired.release();
});

test("non-owner release never removes another owner's lock", async (t) => {
  const directory = await lockDirectory(t);
  const acquired = await acquireRepoAuditFileLock(options(directory, "run_11111111111111111111111111111111"));
  const metadata = JSON.parse(await readFile(acquired.path, "utf8")) as RepoAuditLockMetadata;
  await writeFile(acquired.path, `${JSON.stringify({ ...metadata, ownerToken: "replacement-owner" })}\n`, "utf8");
  await acquired.release();
  assert.equal((await stat(acquired.path)).isFile(), true);
});

test("stale lock from another hostname is not deleted without a central lease", async (t) => {
  const directory = await lockDirectory(t);
  const lockPath = path.join(directory, "repoaudit-scan.lock");
  const old = new Date(Date.now() - 120_000).toISOString();
  await writeFile(lockPath, `${JSON.stringify({
    ownerToken: "foreign-owner",
    pid: 999_999,
    hostname: "another-host",
    runId: "run_11111111111111111111111111111111",
    createdAt: old,
    heartbeatAt: old,
  })}\n`, "utf8");

  await assert.rejects(
    acquireRepoAuditFileLock({
      directory,
      runId: "run_22222222222222222222222222222222",
      waitTimeoutMs: 40,
      staleMs: 30,
      heartbeatMs: 10,
      pollMs: 5,
    }),
    (error: unknown) => error instanceof RepoAuditError && error.code === "LOCK_TIMEOUT",
  );
  const remaining = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(remaining.ownerToken, "foreign-owner");
});

test("separate Node processes compete for the same lock", async (t) => {
  const directory = await lockDirectory(t);
  const first = await acquireRepoAuditFileLock(options(directory, "run_11111111111111111111111111111111"));
  const moduleUrl = pathToFileURL(path.resolve("dist/src/adapter/file-lock.js")).href;
  const script = `import { acquireRepoAuditFileLock } from ${JSON.stringify(moduleUrl)};
try {
  const lock = await acquireRepoAuditFileLock({directory: process.argv[1], runId: "run_22222222222222222222222222222222", waitTimeoutMs: 120, staleMs: 60000, heartbeatMs: 25000, pollMs: 10});
  await lock.release(); process.stdout.write("acquired");
} catch (error) { process.stdout.write(error.code ?? "unknown"); }`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], {
      cwd: process.cwd(), windowsHide: true, shell: false,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", () => resolve(stdout));
  });
  assert.equal(output, "LOCK_TIMEOUT");
  await first.release();
});
