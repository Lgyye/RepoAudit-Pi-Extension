import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { runRepoAudit } from "./adapter/run-repoaudit.js";
import {
  createRepoAuditTool,
  type RepoAuditToolRuntimeOptions,
  type RunRepoAudit,
} from "./extension/repoaudit-tool.js";

export { runRepoAudit } from "./adapter/run-repoaudit.js";
export { createRepoAuditRunId } from "./adapter/run-repoaudit.js";
export {
  createRuntimeConfig,
  RUNTIME_DEFAULTS,
  RUNTIME_ENVIRONMENT_NAMES,
} from "./adapter/config.js";
export {
  runRepoAuditDoctor,
  type RepoAuditDoctorCheck,
  type RepoAuditDoctorOptions,
  type RepoAuditDoctorResult,
} from "./adapter/doctor.js";
export {
  acquireRepoAuditFileLock,
  type RepoAuditFileLock,
  type RepoAuditFileLockOptions,
  type RepoAuditLockMetadata,
} from "./adapter/file-lock.js";
export type {
  RepoAuditBugType,
  RepoAuditErrorCode,
  RepoAuditExecutionInfo,
  RepoAuditFinding,
  RepoAuditLanguage,
  RepoAuditResult,
  RepoAuditRunOptions,
  RepoAuditRuntimeOptions,
  RepoAuditProgress,
  RepoAuditStatus,
} from "./adapter/contracts.js";
export {
  mapRepoAuditResult,
  RepoAuditToolExecutionError,
  type RepoAuditToolDetails,
  type RepoAuditToolFinalDetails,
} from "./extension/result-mapper.js";
export {
  createRepoAuditTool,
  REPOAUDIT_PROMPT_GUIDELINES,
  REPOAUDIT_PROMPT_SNIPPET,
  REPOAUDIT_TOOL_DESCRIPTION,
  type RepoAuditToolDefinition,
  type RepoAuditToolRuntimeOptions,
} from "./extension/repoaudit-tool.js";
export {
  repoAuditScanSchema,
  type RepoAuditScanParams,
} from "./extension/schema.js";

export function createRepoAuditExtension(
  runRepoAuditImplementation: RunRepoAudit = runRepoAudit,
  toolRuntimeOptions: RepoAuditToolRuntimeOptions = {},
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(createRepoAuditTool(runRepoAuditImplementation, toolRuntimeOptions));
  };
}

const extension: ExtensionFactory = createRepoAuditExtension();

export default extension;
