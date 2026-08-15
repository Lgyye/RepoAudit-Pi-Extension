import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../src/adapter/process-runner.js";
import { withRepoAuditLock } from "../src/adapter/run-repoaudit.js";

function request(args: readonly string[], timeoutMs = 5_000) {
  return {
    command: process.execPath,
    args,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs,
  };
}

test("process runner 捕获 stdout/stderr/exitCode", async () => {
  const result = await runProcess(
    request(["-e", "process.stdout.write('out'); process.stderr.write('err')"]),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.stdoutBytes, 3);
  assert.equal(result.stderrBytes, 3);
});

test("process runner 保留非零 exitCode", async () => {
  const result = await runProcess(request(["-e", "process.exit(7)"]));
  assert.equal(result.exitCode, 7);
  assert.equal(result.aborted, false);
  assert.equal(result.timedOut, false);
});

test("repoPath 含空格与中文时保持单个 argv", async () => {
  const value = "C:/含 空格/中文仓库";
  const result = await runProcess(
    request(["-e", "process.stdout.write(process.argv[1])", value]),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, value);
});

test("AbortSignal 终止进程树并只完成一次", async () => {
  const controller = new AbortController();
  const pending = runProcess({
    ...request(["-e", "setInterval(() => {}, 1000)"], 5_000),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 80);
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test("timeout 终止进程树", async () => {
  const result = await runProcess(
    request(["-e", "setInterval(() => {}, 1000)"], 100),
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
});

test("进程内 mutex 串行化两个执行", async () => {
  const events: string[] = [];
  const first = withRepoAuditLock(async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 60));
    events.push("first:end");
  });
  const second = withRepoAuditLock(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("等待 mutex 时 abort 不会执行 action", async () => {
  const controller = new AbortController();
  const first = withRepoAuditLock(
    () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
  );
  let ran = false;
  const second = withRepoAuditLock(async () => {
    ran = true;
  }, controller.signal);
  controller.abort();
  await first;
  await assert.rejects(second);
  assert.equal(ran, false);
});
