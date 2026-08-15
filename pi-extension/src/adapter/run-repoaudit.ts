import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  RepoAuditBugType,
  RepoAuditExecutionInfo,
  RepoAuditLanguage,
  RepoAuditResult,
  RepoAuditRunOptions,
  RepoAuditRuntimeOptions,
} from "./contracts.js";
import {
  buildChildEnvironment,
  buildRepoAuditArgs,
  createRuntimeConfig,
  type RepoAuditRuntimeConfig,
} from "./config.js";
import { asRepoAuditError, RepoAuditError, toErrorSummary } from "./errors.js";
import { preflightRepoAudit } from "./preflight.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import {
  locateArtifacts,
  snapshotArtifacts,
  type LocatedArtifacts,
} from "./artifact-locator.js";
import { parseRunArtifacts } from "./result-parser.js";

let executionQueue: Promise<void> = Promise.resolve();

function fallbackRuntimeConfig(): RepoAuditRuntimeConfig {
  return {
    repoAuditRoot: "",
    repoAuditSrcDirectory: "",
    repoAuditEntryPoint: "",
    pythonExecutable: "",
    treeSitterLibrary: "",
    defaultTimeoutMs: 0,
    modelName: "unknown",
    temperature: 0,
    callDepth: 3,
    maxSymbolicWorkers: 1,
    maxNeuralWorkers: 1,
    apiKeyEnvironmentName: null,
    requireApiKey: false,
    environment: {},
  };
}

export async function withRepoAuditLock<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = executionQueue;
  let release!: () => void;
  executionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (signal?.aborted) {
      throw new RepoAuditError("ABORTED", "RepoAudit 扫描已取消。");
    }
    return await action();
  } finally {
    release();
  }
}

function safeRequestedPath(options: RepoAuditRunOptions): string {
  const candidate = (options as { repoPath?: unknown }).repoPath;
  return typeof candidate === "string" && candidate.trim() !== ""
    ? path.resolve(candidate)
    : "";
}

function baseExecution(
  runId: string,
  config: RepoAuditRuntimeConfig,
  startedAt: Date,
): RepoAuditExecutionInfo {
  const endedAt = new Date();
  return {
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    exitCode: null,
    signal: null,
    pythonExecutable: config.pythonExecutable,
    pythonVersion: "unknown",
    modelName: config.modelName,
    workingDirectory: config.repoAuditSrcDirectory,
    resultDirectory: null,
    logDirectory: null,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

function executionFromProcess(
  runId: string,
  config: RepoAuditRuntimeConfig,
  pythonVersion: string,
  processResult: ProcessRunResult,
  artifacts?: LocatedArtifacts,
): RepoAuditExecutionInfo {
  return {
    runId,
    startedAt: processResult.startedAt,
    endedAt: processResult.endedAt,
    durationMs: processResult.durationMs,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    pythonExecutable: config.pythonExecutable,
    pythonVersion,
    modelName: config.modelName,
    workingDirectory: config.repoAuditSrcDirectory,
    resultDirectory: artifacts?.resultDirectory ?? null,
    logDirectory: artifacts?.logDirectory ?? null,
    stdoutBytes: processResult.stdoutBytes,
    stderrBytes: processResult.stderrBytes,
  };
}

function failedResult(
  options: RepoAuditRunOptions,
  repoPath: string,
  execution: RepoAuditExecutionInfo,
  error: RepoAuditError,
  artifacts?: LocatedArtifacts,
): RepoAuditResult {
  return {
    status: "failed",
    tool: "repoaudit",
    bugType: (options as { bugType: RepoAuditBugType }).bugType,
    language: (options as { language: RepoAuditLanguage }).language,
    repoPath,
    findingCount: 0,
    findings: [],
    reportPath: artifacts?.reportPath ?? null,
    logPath: artifacts?.logPath ?? null,
    execution,
    error: toErrorSummary(error),
  };
}

async function executeRepoAudit(
  options: RepoAuditRunOptions,
  runtimeOptions: RepoAuditRuntimeOptions,
): Promise<RepoAuditResult> {
  const runId = randomUUID();
  const startedAt = new Date();
  let config: RepoAuditRuntimeConfig;
  try {
    config = createRuntimeConfig();
  } catch (error) {
    const fallbackConfig = fallbackRuntimeConfig();
    return failedResult(
      options,
      safeRequestedPath(options),
      baseExecution(runId, fallbackConfig, startedAt),
      asRepoAuditError(error),
    );
  }

  let repoPath = safeRequestedPath(options);
  let pythonVersion = "unknown";
  let processResult: ProcessRunResult | undefined;
  let artifacts: LocatedArtifacts | undefined;
  try {
    if (
      runtimeOptions.timeoutMs !== undefined &&
      (!Number.isSafeInteger(runtimeOptions.timeoutMs) || runtimeOptions.timeoutMs <= 0)
    ) {
      throw new RepoAuditError("TIMEOUT", "timeoutMs 必须是正整数。");
    }
    const preflight = await preflightRepoAudit(options, config);
    repoPath = preflight.repoPath;
    pythonVersion = preflight.pythonVersion;
    const before = await snapshotArtifacts(options, repoPath, config);
    processResult = await runProcess({
      command: config.pythonExecutable,
      args: buildRepoAuditArgs(options, config, repoPath),
      cwd: config.repoAuditSrcDirectory,
      env: buildChildEnvironment(config),
      timeoutMs: runtimeOptions.timeoutMs ?? config.defaultTimeoutMs,
      ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
    });
    let execution = executionFromProcess(runId, config, pythonVersion, processResult);
    if (processResult.aborted) {
      throw new RepoAuditError("ABORTED", "RepoAudit 扫描已取消。");
    }
    if (processResult.timedOut) {
      throw new RepoAuditError("TIMEOUT", "RepoAudit 扫描已超时。");
    }
    if (processResult.spawnError !== null) {
      const code = processResult.spawnError.code === "ENOENT" ? "PYTHON_NOT_FOUND" : "ANALYSIS_FAILED";
      throw new RepoAuditError(code, "无法启动 RepoAudit Python 进程。", {
        cause: processResult.spawnError,
      });
    }
    if (processResult.exitCode !== 0) {
      throw new RepoAuditError("ANALYSIS_FAILED", "RepoAudit Python 进程以非零状态退出。");
    }
    const after = await snapshotArtifacts(options, repoPath, config);
    artifacts = await locateArtifacts(before, after, config);
    execution = executionFromProcess(runId, config, pythonVersion, processResult, artifacts);
    const parsed = await parseRunArtifacts(artifacts, processResult.stdout, options.bugType);
    return {
      status: parsed.status,
      tool: "repoaudit",
      bugType: options.bugType,
      language: options.language,
      repoPath,
      findingCount: parsed.findings.length,
      findings: parsed.findings,
      reportPath: artifacts.reportPath,
      logPath: artifacts.logPath,
      execution,
    };
  } catch (error) {
    const execution = processResult === undefined
      ? baseExecution(runId, config, startedAt)
      : executionFromProcess(runId, config, pythonVersion, processResult, artifacts);
    return failedResult(options, repoPath, execution, asRepoAuditError(error), artifacts);
  }
}

export async function runRepoAudit(
  options: RepoAuditRunOptions,
  runtimeOptions: RepoAuditRuntimeOptions = {},
): Promise<RepoAuditResult> {
  return withRepoAuditLock(
    () => executeRepoAudit(options, runtimeOptions),
    runtimeOptions.signal,
  ).catch((error: unknown) => {
    let config: RepoAuditRuntimeConfig;
    try {
      config = createRuntimeConfig();
    } catch {
      config = fallbackRuntimeConfig();
    }
    const startedAt = new Date();
    return failedResult(
      options,
      safeRequestedPath(options),
      baseExecution(randomUUID(), config, startedAt),
      asRepoAuditError(error),
    );
  });
}
