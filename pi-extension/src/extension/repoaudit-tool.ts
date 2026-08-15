import path from "node:path";

import type {
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { RepoAuditRunOptions } from "../adapter/contracts.js";
import { runRepoAudit } from "../adapter/run-repoaudit.js";
import {
  mapRepoAuditResult,
  progressResult,
  type RepoAuditToolDetails,
} from "./result-mapper.js";
import {
  repoAuditScanSchema,
  type RepoAuditScanParams,
} from "./schema.js";

export type RunRepoAudit = typeof runRepoAudit;
export type RepoAuditToolDefinition = ToolDefinition<
  typeof repoAuditScanSchema,
  RepoAuditToolDetails
>;

export const REPOAUDIT_TOOL_DESCRIPTION = `Analyze a source repository with RepoAudit for supported data-flow bugs.

Supported matrix:
- C/C++ (language=Cpp): NPD, UAF, MLK
- Java: NPD
- Python: NPD
- Go: NPD

Use for repository-level source-code security analysis of these supported data-flow bugs.
Do not use for Web pentesting, Network scanning, Binary/reverse analysis, Dependency vulnerability scanning, unsupported vulnerability classes, or Generic code review.`;

function toRunOptions(params: RepoAuditScanParams, cwd: string): RepoAuditRunOptions {
  const repoPath = path.isAbsolute(params.repoPath)
    ? params.repoPath
    : path.resolve(cwd, params.repoPath);
  return {
    repoPath,
    language: params.language,
    bugType: params.bugType,
  } as RepoAuditRunOptions;
}

export function createRepoAuditTool(
  runRepoAuditImplementation: RunRepoAudit = runRepoAudit,
): RepoAuditToolDefinition {
  return {
    name: "repoaudit_scan",
    label: "RepoAudit Scan",
    description: REPOAUDIT_TOOL_DESCRIPTION,
    parameters: repoAuditScanSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.(progressResult("preparing", "Preparing RepoAudit scan..."));
      const options = toRunOptions(params, ctx.cwd);
      onUpdate?.(progressResult("running", "Running RepoAudit analysis..."));
      const result = await runRepoAuditImplementation(
        options,
        signal === undefined ? {} : { signal },
      );
      onUpdate?.(progressResult("processing", "Processing RepoAudit result..."));
      return mapRepoAuditResult(result);
    },
  };
}
