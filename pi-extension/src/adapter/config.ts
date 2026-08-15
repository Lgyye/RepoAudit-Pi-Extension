import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  RepoAuditBugType,
  RepoAuditLanguage,
  RepoAuditRunOptions,
} from "./contracts.js";
import { RepoAuditError } from "./errors.js";

export const RUNTIME_ENVIRONMENT_NAMES = {
  repoAuditRoot: "REPOAUDIT_ROOT",
  pythonExecutable: "REPOAUDIT_PYTHON",
  modelName: "REPOAUDIT_MODEL",
  timeoutMs: "REPOAUDIT_TIMEOUT_MS",
  requireApiKey: "REPOAUDIT_REQUIRE_API_KEY",
} as const;

export const SOURCE_EXTENSIONS: Record<RepoAuditLanguage, readonly string[]> = {
  Cpp: [".cpp", ".cc", ".hpp", ".c", ".h"],
  Java: [".java"],
  Python: [".py"],
  Go: [".go"],
};

export const SUPPORTED_COMBINATIONS: Record<
  RepoAuditLanguage,
  readonly RepoAuditBugType[]
> = {
  Cpp: ["MLK", "NPD", "UAF"],
  Java: ["NPD"],
  Python: ["NPD"],
  Go: ["NPD"],
};

export interface RepoAuditRuntimeConfig {
  repoAuditRoot: string;
  repoAuditSrcDirectory: string;
  repoAuditEntryPoint: string;
  pythonExecutable: string;
  treeSitterLibrary: string;
  defaultTimeoutMs: number;
  modelName: string;
  temperature: number;
  callDepth: number;
  maxSymbolicWorkers: number;
  maxNeuralWorkers: number;
  apiKeyEnvironmentName: string | null;
  requireApiKey: boolean;
  environment: NodeJS.ProcessEnv;
}

function findRepoAuditRoot(startDirectory: string): string {
  let current = path.resolve(startDirectory);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(current, "src", "repoaudit.py"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new RepoAuditError(
    "REPOAUDIT_NOT_FOUND",
    "无法从 Adapter 位置推导 RepoAudit repository root。",
    { recoverable: false },
  );
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RepoAuditError(
      "MODEL_CONFIGURATION_ERROR",
      `${name} 必须是正整数。`,
    );
  }
  return parsed;
}

function apiKeyNameForModel(modelName: string): string | null {
  const normalized = modelName.toLowerCase();
  if (normalized.includes("claude")) return "ANTHROPIC_API_KEY";
  if (normalized.includes("gpt") || normalized.includes("o3-mini")) {
    return "OPENAI_API_KEY";
  }
  if (normalized.includes("deepseek")) return "DEEPSEEK_API_KEY2";
  if (normalized.includes("gemini")) return "GOOGLE_API_KEY";
  return null;
}

export function createRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RepoAuditRuntimeConfig {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoAuditRoot = environment[RUNTIME_ENVIRONMENT_NAMES.repoAuditRoot]
    ? path.resolve(environment[RUNTIME_ENVIRONMENT_NAMES.repoAuditRoot] as string)
    : findRepoAuditRoot(moduleDirectory);
  const defaultPython =
    process.platform === "win32"
      ? path.join(repoAuditRoot, ".venv", "Scripts", "python.exe")
      : path.join(repoAuditRoot, ".venv", "bin", "python");
  const modelName = environment[RUNTIME_ENVIRONMENT_NAMES.modelName]?.trim() || "claude-3.7";

  return {
    repoAuditRoot,
    repoAuditSrcDirectory: path.join(repoAuditRoot, "src"),
    repoAuditEntryPoint: path.join(repoAuditRoot, "src", "repoaudit.py"),
    pythonExecutable: path.resolve(
      environment[RUNTIME_ENVIRONMENT_NAMES.pythonExecutable] || defaultPython,
    ),
    treeSitterLibrary: path.join(repoAuditRoot, "lib", "build", "my-languages.so"),
    defaultTimeoutMs: readPositiveInteger(
      environment[RUNTIME_ENVIRONMENT_NAMES.timeoutMs],
      30 * 60 * 1000,
      RUNTIME_ENVIRONMENT_NAMES.timeoutMs,
    ),
    modelName,
    temperature: 0,
    callDepth: 3,
    maxSymbolicWorkers: 30,
    maxNeuralWorkers: 1,
    apiKeyEnvironmentName: apiKeyNameForModel(modelName),
    requireApiKey:
      environment[RUNTIME_ENVIRONMENT_NAMES.requireApiKey]?.trim() === "1",
    environment,
  };
}

export function buildRepoAuditArgs(
  options: RepoAuditRunOptions,
  config: RepoAuditRuntimeConfig,
  canonicalRepoPath = options.repoPath,
): string[] {
  const projectPathArgument =
    process.platform === "win32"
      ? canonicalRepoPath.replaceAll("\\", "/")
      : canonicalRepoPath;
  const args = [
    "-u",
    config.repoAuditEntryPoint,
    "--scan-type",
    "dfbscan",
    "--project-path",
    projectPathArgument,
    "--language",
    options.language,
    "--model-name",
    config.modelName,
    "--temperature",
    String(config.temperature),
    "--call-depth",
    String(config.callDepth),
    "--max-symbolic-workers",
    String(config.maxSymbolicWorkers),
    "--max-neural-workers",
    String(config.maxNeuralWorkers),
    "--bug-type",
    options.bugType,
  ];
  if (options.bugType !== "MLK") {
    args.push("--is-reachable");
  }
  return args;
}

const CHILD_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
] as const;

export function buildChildEnvironment(
  config: RepoAuditRuntimeConfig,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    const value = config.environment[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  if (config.apiKeyEnvironmentName !== null) {
    const secret = config.environment[config.apiKeyEnvironmentName];
    if (secret !== undefined) childEnvironment[config.apiKeyEnvironmentName] = secret;
  }
  return childEnvironment;
}
