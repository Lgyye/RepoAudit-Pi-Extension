import { constants as fsConstants } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type {
  RepoAuditBugType,
  RepoAuditLanguage,
  RepoAuditRunOptions,
} from "./contracts.js";
import {
  SOURCE_EXTENSIONS,
  SUPPORTED_COMBINATIONS,
  type RepoAuditRuntimeConfig,
} from "./config.js";
import { RepoAuditError } from "./errors.js";

const LANGUAGES = new Set<RepoAuditLanguage>(["Cpp", "Java", "Python", "Go"]);
const BUG_TYPES = new Set<RepoAuditBugType>(["MLK", "NPD", "UAF"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".vscode",
  ".idea",
  "build",
  "dist",
  "out",
  "bin",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  "env",
  "target",
  ".gradle",
  ".m2",
  ".settings",
  "classes",
  "CMakeFiles",
  ".deps",
  "Debug",
  "Release",
  "obj",
  "vendor",
  "pkg",
]);

export interface RepoAuditPreflightResult {
  repoPath: string;
  pythonVersion: string;
  apiKeyAvailable: boolean;
}

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

function probe(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, stdout, stderr, error });
    });
    child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
  });
}

export function validateRepoAuditOptions(options: RepoAuditRunOptions): void {
  const candidate = options as {
    repoPath?: unknown;
    language?: unknown;
    bugType?: unknown;
  };
  if (typeof candidate.language !== "string" || !LANGUAGES.has(candidate.language as RepoAuditLanguage)) {
    throw new RepoAuditError(
      "UNSUPPORTED_LANGUAGE",
      "language 必须是 Cpp、Java、Python 或 Go。",
    );
  }
  if (typeof candidate.bugType !== "string" || !BUG_TYPES.has(candidate.bugType as RepoAuditBugType)) {
    throw new RepoAuditError(
      "UNSUPPORTED_BUG_TYPE",
      "bugType 必须是 MLK、NPD 或 UAF。",
    );
  }
  const language = candidate.language as RepoAuditLanguage;
  const bugType = candidate.bugType as RepoAuditBugType;
  if (!SUPPORTED_COMBINATIONS[language].includes(bugType)) {
    throw new RepoAuditError(
      "UNSUPPORTED_LANGUAGE_BUG_COMBINATION",
      `${language} 不支持 ${bugType}；允许值为 ${SUPPORTED_COMBINATIONS[language].join(", ")}。`,
    );
  }
  if (
    typeof candidate.repoPath !== "string" ||
    candidate.repoPath.trim() === "" ||
    candidate.repoPath.includes("\0")
  ) {
    throw new RepoAuditError("REPO_NOT_FOUND", "repoPath 必须是非空目录路径。");
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeTargetPath(repoPath: string, config: RepoAuditRuntimeConfig): void {
  const protectedRuntimeDirectories = [
    config.repoAuditSrcDirectory,
    path.join(config.repoAuditRoot, "log"),
    path.join(config.repoAuditRoot, "result"),
    path.join(config.repoAuditRoot, ".venv"),
  ].map((value) => path.resolve(value));
  if (
    path.resolve(repoPath) === path.resolve(config.repoAuditRoot) ||
    protectedRuntimeDirectories.some((runtimePath) => isWithin(repoPath, runtimePath))
  ) {
    throw new RepoAuditError(
      "REPO_NOT_FOUND",
      "repoPath 不得指向 RepoAudit root 或其运行目录。",
    );
  }
}

async function hasAnalyzableFile(
  directory: string,
  extensions: readonly string[],
): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
      return true;
    }
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !EXCLUDED_DIRECTORIES.has(entry.name) &&
      (await hasAnalyzableFile(path.join(directory, entry.name), extensions))
    ) {
      return true;
    }
  }
  return false;
}

export async function validateRepositoryInput(
  options: RepoAuditRunOptions,
  config: RepoAuditRuntimeConfig,
): Promise<string> {
  validateRepoAuditOptions(options);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path.resolve(options.repoPath));
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new RepoAuditError(
      "REPO_NOT_FOUND",
      "repoPath 不存在或不是目录。",
      { cause: error },
    );
  }
  assertSafeTargetPath(canonicalPath, config);
  if (!(await hasAnalyzableFile(canonicalPath, SOURCE_EXTENSIONS[options.language]))) {
    throw new RepoAuditError(
      "NO_ANALYZABLE_FILES",
      `仓库中没有可供 ${options.language} 分析的源文件。`,
    );
  }
  return canonicalPath;
}

async function assertRuntimePaths(config: RepoAuditRuntimeConfig): Promise<void> {
  try {
    if (!(await stat(config.repoAuditRoot)).isDirectory()) throw new Error("not a directory");
    if (!(await stat(config.repoAuditSrcDirectory)).isDirectory()) throw new Error("src missing");
    if (!(await stat(config.repoAuditEntryPoint)).isFile()) throw new Error("entry missing");
  } catch (error) {
    throw new RepoAuditError(
      "REPOAUDIT_NOT_FOUND",
      "RepoAudit root 或 src/repoaudit.py 不存在。",
      { cause: error, recoverable: false },
    );
  }
}

async function getPythonVersion(config: RepoAuditRuntimeConfig): Promise<string> {
  try {
    if (!(await stat(config.pythonExecutable)).isFile()) throw new Error("not a file");
    await access(config.pythonExecutable, fsConstants.X_OK);
  } catch (error) {
    throw new RepoAuditError("PYTHON_NOT_FOUND", "Python executable 不存在或不可执行。", {
      cause: error,
      recoverable: false,
    });
  }
  const result = await probe(
    config.pythonExecutable,
    ["--version"],
    config.repoAuditSrcDirectory,
  );
  if (result.error || result.exitCode !== 0) {
    throw new RepoAuditError("PYTHON_NOT_FOUND", "无法执行配置的 Python runtime。", {
      cause: result.error,
      recoverable: false,
    });
  }
  const versionText = `${result.stdout}\n${result.stderr}`.trim();
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/i.exec(versionText);
  if (!match) {
    throw new RepoAuditError(
      "PYTHON_VERSION_UNSUPPORTED",
      "无法识别 Python runtime 版本。",
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 3 || minor !== 13) {
    throw new RepoAuditError(
      "PYTHON_VERSION_UNSUPPORTED",
      `RepoAudit 当前已验证 Python 3.13，检测到 ${match[1]}.${match[2]}.${match[3]}。`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

async function assertDependencies(config: RepoAuditRuntimeConfig): Promise<void> {
  const script = [
    "import tree_sitter",
    "import tqdm",
    "import networkx",
    "import openai",
    "import anthropic",
    "import google.generativeai",
    "import tiktoken",
    "import boto3",
    "import botocore",
  ].join("; ");
  const result = await probe(
    config.pythonExecutable,
    ["-c", script],
    config.repoAuditSrcDirectory,
  );
  if (result.error || result.exitCode !== 0) {
    throw new RepoAuditError(
      "DEPENDENCY_ERROR",
      "RepoAudit Python runtime 缺少必要依赖。",
      { cause: result.error },
    );
  }
}

async function assertTreeSitter(
  language: RepoAuditLanguage,
  config: RepoAuditRuntimeConfig,
): Promise<void> {
  try {
    if (!(await stat(config.treeSitterLibrary)).isFile()) throw new Error("missing");
  } catch (error) {
    throw new RepoAuditError(
      "TREE_SITTER_NOT_READY",
      "Tree-sitter library 尚未构建；请运行 RepoAudit/lib/build.py。",
      { cause: error },
    );
  }
  const grammar = { Cpp: "cpp", Java: "java", Python: "python", Go: "go" }[language];
  const result = await probe(
    config.pythonExecutable,
    [
      "-c",
      "import sys; from tree_sitter import Language; Language(sys.argv[1], sys.argv[2])",
      config.treeSitterLibrary,
      grammar,
    ],
    config.repoAuditSrcDirectory,
  );
  if (result.error || result.exitCode !== 0) {
    throw new RepoAuditError(
      "TREE_SITTER_NOT_READY",
      `Tree-sitter ${language} grammar 无法加载。`,
      { cause: result.error },
    );
  }
}

export async function preflightRepoAudit(
  options: RepoAuditRunOptions,
  config: RepoAuditRuntimeConfig,
): Promise<RepoAuditPreflightResult> {
  const repoPath = await validateRepositoryInput(options, config);
  await assertRuntimePaths(config);
  const pythonVersion = await getPythonVersion(config);
  await assertDependencies(config);
  await assertTreeSitter(options.language, config);
  const apiKeyAvailable =
    config.apiKeyEnvironmentName === null ||
    Boolean(config.environment[config.apiKeyEnvironmentName]?.trim());
  if (config.apiKeyEnvironmentName === null) {
    throw new RepoAuditError(
      "MODEL_CONFIGURATION_ERROR",
      `无法识别模型 ${config.modelName} 的凭证配置。`,
    );
  }
  if (config.requireApiKey && !apiKeyAvailable) {
    throw new RepoAuditError(
      "API_KEY_MISSING",
      `缺少 ${config.apiKeyEnvironmentName}。`,
    );
  }
  return { repoPath, pythonVersion, apiKeyAvailable };
}
