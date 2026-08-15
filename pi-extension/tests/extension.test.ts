import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { RepoAuditResult } from "../src/adapter/contracts.js";
import extension, {
  createRepoAuditExtension,
  type RepoAuditToolDefinition,
} from "../src/index.js";

type RunRepoAudit = typeof import("../src/adapter/run-repoaudit.js").runRepoAudit;

function successfulResult(): RepoAuditResult {
  return {
    status: "success_no_findings",
    tool: "repoaudit",
    bugType: "NPD",
    language: "Python",
    repoPath: "C:/repo",
    findingCount: 0,
    findings: [],
    reportPath: null,
    logPath: "C:/RepoAudit/log/dfbscan.log",
    execution: {
      runId: "run-1",
      startedAt: "2026-08-14T00:00:00.000Z",
      endedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      pythonExecutable: "python",
      pythonVersion: "3.13.9",
      modelName: "model",
      workingDirectory: "C:/RepoAudit/src",
      resultDirectory: null,
      logDirectory: "C:/RepoAudit/log",
      stdoutBytes: 0,
      stderrBytes: 0,
    },
  };
}

function register(factory = extension): RepoAuditToolDefinition {
  const tools: RepoAuditToolDefinition[] = [];
  factory({
    registerTool(tool) {
      tools.push(tool as unknown as RepoAuditToolDefinition);
    },
  } as ExtensionAPI);
  assert.equal(tools.length, 1);
  return tools[0] as RepoAuditToolDefinition;
}

test("默认导出是可加载的 ExtensionFactory 且只注册 repoaudit_scan", () => {
  assert.equal(typeof extension, "function");
  const tool = register();
  assert.equal(tool.name, "repoaudit_scan");
  assert.equal(tool.executionMode, "sequential");
});

test("schema 只暴露 repoPath、language、bugType", () => {
  const schema = register().parameters as unknown as {
    properties: Record<string, unknown>;
    required?: string[];
  };

  assert.deepEqual(Object.keys(schema.properties).sort(), ["bugType", "language", "repoPath"]);
  assert.deepEqual([...(schema.required ?? [])].sort(), ["bugType", "language", "repoPath"]);
  for (const forbidden of ["API key", "pythonExecutable", "model", "outputDir", "timeoutMs"]) {
    assert.equal(forbidden in schema.properties, false);
  }
});

test("description 明确支持矩阵与不适用边界", () => {
  const description = register().description;
  for (const phrase of ["C/C++", "Java", "Python", "Go", "NPD", "UAF", "MLK"]) {
    assert.match(description, new RegExp(phrase.replace("+", "\\+")));
  }
  for (const phrase of [
    "Web pentesting",
    "Network scanning",
    "Binary/reverse analysis",
    "Dependency vulnerability scanning",
    "Generic code review",
  ]) {
    assert.match(description, new RegExp(phrase, "i"));
  }
});

test("execute 调用 runRepoAudit、透传 signal，并只发送真实阶段更新", async () => {
  const calls: Array<{ options: unknown; runtimeOptions: unknown }> = [];
  const mockRun: RunRepoAudit = async (options, runtimeOptions) => {
    calls.push({ options, runtimeOptions });
    return successfulResult();
  };
  const tool = register(createRepoAuditExtension(mockRun));
  const controller = new AbortController();
  const updates: string[] = [];
  const result = await tool.execute(
    "call-1",
    { repoPath: "C:/repo", language: "Python", bugType: "NPD" },
    controller.signal,
    (update) => {
      const first = update.content[0];
      if (first?.type === "text") updates.push(first.text);
    },
    { cwd: "C:/workspace" } as never,
  );

  assert.deepEqual(calls, [{
    options: { repoPath: "C:/repo", language: "Python", bugType: "NPD" },
    runtimeOptions: { signal: controller.signal },
  }]);
  assert.deepEqual(updates, [
    "Preparing RepoAudit scan...",
    "Running RepoAudit analysis...",
    "Processing RepoAudit result...",
  ]);
  assert.equal("status" in result.details ? result.details.status : undefined, "success_no_findings");
});

test("unsupported language/bug 组合由 Adapter 安全失败且不调用 Python/LLM", async () => {
  const failed: RepoAuditResult = {
    ...successfulResult(),
    status: "failed",
    language: "Python",
    bugType: "UAF",
    error: {
      code: "UNSUPPORTED_LANGUAGE_BUG_COMBINATION",
      message: "Python does not support UAF; raw diagnostic should not leak",
      recoverable: true,
    },
  };
  const mockRun: RunRepoAudit = async () => failed;
  const tool = register(createRepoAuditExtension(mockRun));

  await assert.rejects(
    tool.execute(
      "call-2",
      { repoPath: "C:/repo", language: "Python", bugType: "UAF" } as never,
      undefined,
      undefined,
      { cwd: "C:/workspace" } as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /UNSUPPORTED_LANGUAGE_BUG_COMBINATION/);
      assert.doesNotMatch(error.message, /raw diagnostic/);
      return true;
    },
  );
});
