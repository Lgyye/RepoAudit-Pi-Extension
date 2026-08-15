import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { runRepoAudit } from "./adapter/run-repoaudit.js";
import {
  createRepoAuditTool,
  type RunRepoAudit,
} from "./extension/repoaudit-tool.js";

export { runRepoAudit } from "./adapter/run-repoaudit.js";
export type {
  RepoAuditBugType,
  RepoAuditErrorCode,
  RepoAuditExecutionInfo,
  RepoAuditFinding,
  RepoAuditLanguage,
  RepoAuditResult,
  RepoAuditRunOptions,
  RepoAuditRuntimeOptions,
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
  REPOAUDIT_TOOL_DESCRIPTION,
  type RepoAuditToolDefinition,
} from "./extension/repoaudit-tool.js";
export {
  repoAuditScanSchema,
  type RepoAuditScanParams,
} from "./extension/schema.js";

export function createRepoAuditExtension(
  runRepoAuditImplementation: RunRepoAudit = runRepoAudit,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(createRepoAuditTool(runRepoAuditImplementation));
  };
}

const extension: ExtensionFactory = createRepoAuditExtension();

export default extension;
