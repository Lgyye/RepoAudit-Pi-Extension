import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  aborted: boolean;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

const CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;

function appendCapture(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= CAPTURE_LIMIT_BYTES) return next;
  return next.slice(-CAPTURE_LIMIT_BYTES);
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForClose(child, 2_000);
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await waitForClose(child, 750);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await waitForClose(child, 2_000);
  }
}

export function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  return new Promise((resolve) => {
    const startedAtDate = new Date();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let aborted = request.signal?.aborted ?? false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;

    if (aborted) {
      const endedAtDate = new Date();
      resolve({
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        exitCode: null,
        signal: null,
        startedAt: startedAtDate.toISOString(),
        endedAt: endedAtDate.toISOString(),
        durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
        aborted: true,
        timedOut: false,
        spawnError,
      });
      return;
    }

    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      const endedAtDate = new Date();
      resolve({
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        exitCode,
        signal,
        startedAt: startedAtDate.toISOString(),
        endedAt: endedAtDate.toISOString(),
        durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
        aborted,
        timedOut,
        spawnError,
      });
    };

    const onAbort = (): void => {
      aborted = true;
      void terminateProcessTree(child);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = appendCapture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = appendCapture(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
}
