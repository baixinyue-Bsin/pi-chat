import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type ServerManagerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ServerManagerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ServerManagerOptions = {
  command: string;
  args: string[];
  hostname: string;
  port: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  healthPath?: string;
  stopTimeoutMs?: number;
  fetchImpl?: ServerManagerFetch;
  spawnImpl?: ServerManagerSpawn;
  onHealthCheck?: (result: { ok: boolean; status?: number; error?: string }) => void;
  onExit?: (result: { code: number | null; signal: NodeJS.Signals | null; requested: boolean; error?: string }) => void;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 100;
const MAX_OUTPUT_LENGTH = 16_000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatHost(hostname: string): string {
  if (hostname.includes(":") && !hostname.startsWith("[")) return `[${hostname}]`;
  return hostname;
}

export class ServerManager {
  private readonly options: Required<Pick<
    ServerManagerOptions,
    "startupTimeoutMs" | "healthPath" | "stopTimeoutMs"
  >> & ServerManagerOptions;
  private readonly fetchImpl: ServerManagerFetch;
  private readonly spawnImpl: ServerManagerSpawn;
  private child: ChildProcess | null = null;
  private exited = false;
  private stopRequested = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastError: Error | undefined;
  private output = "";
  private healthReported = false;

  constructor(options: ServerManagerOptions) {
    this.options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      healthPath: options.healthPath ?? "/api/health",
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  }

  startServer(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child && !this.exited) return Promise.resolve();

    this.exited = false;
    this.stopRequested = false;
    this.lastError = undefined;
    this.output = "";
    this.healthReported = false;

    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveStart = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectStart = (error: unknown) => {
        const normalized = asError(error);
        this.lastError = normalized;
        if (settled) return;
        settled = true;
        reject(normalized);
      };

      let child: ChildProcess;
      try {
        child = this.spawnImpl(this.options.command, this.options.args, {
          cwd: this.options.cwd,
          env: { ...process.env, ...this.options.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        rejectStart(error);
        return;
      }

      this.child = child;
      child.stdout?.on("data", (chunk: Buffer | string) => this.recordOutput(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => this.recordOutput(chunk));
      child.once("error", (error) => {
        this.lastError = asError(error);
        rejectStart(error);
      });
      child.once("exit", (code, signal) => {
        this.exited = true;
        if (!this.stopRequested && !this.lastError) {
          this.lastError = new Error(
            `Pi Chat server exited before becoming ready (${signal ? `signal ${signal}` : `code ${code}`})${this.output ? `: ${this.output}` : ""}`,
          );
        }
        this.notifyExit({
          code,
          signal,
          requested: this.stopRequested,
          ...(this.lastError ? { error: this.lastError.message } : {}),
        });
        if (!settled) {
          rejectStart(this.lastError ?? new Error("Pi Chat server exited before starting"));
        }
      });

      // Node emits spawn asynchronously. Waiting for it catches an immediate
      // spawn error while keeping the method independent from health readiness.
      child.once("spawn", resolveStart);
      if (child.pid !== undefined) queueMicrotask(resolveStart);
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async waitUntilReady(): Promise<void> {
    await this.startServer();
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastHealthError: Error | undefined;

    while (Date.now() < deadline) {
      if (this.exited) {
        const error = this.lastError ?? new Error("Pi Chat server exited before becoming ready");
        this.notifyHealth({ ok: false, error: error.message });
        throw error;
      }

      const remaining = deadline - Date.now();
      const requestTimeout = Math.min(HEALTH_REQUEST_TIMEOUT_MS, Math.max(1, remaining));
      try {
        const response = await this.fetchImpl(this.healthUrl(), {
          signal: AbortSignal.timeout(requestTimeout),
        });
        if (response.ok) {
          this.notifyHealth({ ok: true, status: response.status });
          return;
        }
        lastHealthError = new Error(`Health check returned HTTP ${response.status}`);
      } catch (error) {
        lastHealthError = asError(error);
      }

      if (this.exited) {
        this.notifyHealth({
          ok: false,
          error: (this.lastError ?? lastHealthError ?? new Error("Pi Chat server exited before becoming ready")).message,
        });
        throw this.lastError ?? lastHealthError ?? new Error("Pi Chat server exited before becoming ready");
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }

    const detail = lastHealthError?.message ?? this.lastError?.message ?? "no successful health response";
    this.notifyHealth({ ok: false, error: detail });
    throw new Error(`Timed out waiting for Pi Chat server readiness after ${this.options.startupTimeoutMs}ms: ${detail}`);
  }

  getUrl(): string {
    return `http://${formatHost(this.options.hostname)}:${this.options.port}`;
  }

  getLastError(): Error | undefined {
    return this.lastError;
  }

  async stopServer(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child || this.exited) {
      this.child = null;
      return;
    }

    this.stopPromise = (async () => {
      this.stopRequested = true;
      if (!this.exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the state check and kill.
        }
        await this.waitForExit(child, this.options.stopTimeoutMs);
      }
      if (!this.exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have exited while the timeout was firing.
        }
        await this.waitForExit(child, this.options.stopTimeoutMs);
      }
      this.child = null;
    })().finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  private healthUrl(): string {
    const healthPath = this.options.healthPath.startsWith("/")
      ? this.options.healthPath
      : `/${this.options.healthPath}`;
    return `${this.getUrl()}${healthPath}`;
  }

  private recordOutput(chunk: Buffer | string): void {
    this.output = `${this.output}${chunk.toString()}`.slice(-MAX_OUTPUT_LENGTH).trim();
  }

  private notifyHealth(result: { ok: boolean; status?: number; error?: string }): void {
    if (this.healthReported && result.ok) return;
    this.healthReported = this.healthReported || result.ok;
    try {
      this.options.onHealthCheck?.(result);
    } catch {
      // Diagnostics must never change server lifecycle behavior.
    }
  }

  private notifyExit(result: { code: number | null; signal: NodeJS.Signals | null; requested: boolean; error?: string }): void {
    try {
      this.options.onExit?.(result);
    } catch {
      // Diagnostics must never change server lifecycle behavior.
    }
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (this.exited || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
