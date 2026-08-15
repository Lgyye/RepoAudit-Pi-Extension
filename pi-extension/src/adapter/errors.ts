import type { RepoAuditErrorCode, RepoAuditErrorSummary } from "./contracts.js";

const RECOVERABLE_CODES = new Set<RepoAuditErrorCode>([
  "REPO_NOT_FOUND",
  "NO_ANALYZABLE_FILES",
  "PYTHON_VERSION_UNSUPPORTED",
  "DEPENDENCY_ERROR",
  "TREE_SITTER_NOT_READY",
  "API_KEY_MISSING",
  "UNSUPPORTED_LANGUAGE",
  "UNSUPPORTED_BUG_TYPE",
  "UNSUPPORTED_LANGUAGE_BUG_COMBINATION",
  "MODEL_CONFIGURATION_ERROR",
  "RESULT_NOT_FOUND",
  "RESULT_AMBIGUOUS",
  "RESULT_PARSE_ERROR",
  "ABORTED",
  "TIMEOUT",
]);

export class RepoAuditError extends Error {
  readonly code: RepoAuditErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: RepoAuditErrorCode,
    message: string,
    options?: { cause?: unknown; recoverable?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RepoAuditError";
    this.code = code;
    this.recoverable = options?.recoverable ?? RECOVERABLE_CODES.has(code);
  }
}

export function asRepoAuditError(error: unknown): RepoAuditError {
  if (error instanceof RepoAuditError) {
    return error;
  }
  return new RepoAuditError(
    "ANALYSIS_FAILED",
    "RepoAudit Adapter 遇到未预期的执行错误。",
    { cause: error, recoverable: false },
  );
}

export function toErrorSummary(error: RepoAuditError): RepoAuditErrorSummary {
  return {
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
  };
}
