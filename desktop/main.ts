import { createServer } from "node:net";
import { once } from "node:events";
import { ServerManager } from "../lib/server-manager";
import { resolveDesktopPaths, resolveNodeExecutable } from "./paths";
import { completeOnboarding, readOnboardingState } from "./onboarding-state";

type WindowEvent = (...args: unknown[]) => void;

export type ElectronApi = {
  app: {
    whenReady(): Promise<void>;
    requestSingleInstanceLock?(): boolean;
    getAppPath?(): string;
    getPath?(name: "userData"): string;
    isPackaged?: boolean;
    on(event: string, listener: WindowEvent): void;
    quit(): void;
    exit?(code?: number): void;
  };
  BrowserWindow: new (options: Record<string, unknown>) => {
    loadURL(url: string): Promise<void>;
    on(event: string, listener: WindowEvent): void;
    once?(event: string, listener: WindowEvent): void;
    show?(): void;
    focus?(): void;
    isDestroyed?(): boolean;
    webContents?: {
      setWindowOpenHandler?(handler: (details: { url: string }) => { action: "deny" }): void;
      on?(event: string, listener: WindowEvent): void;
    };
  };
  dialog: {
    showMessageBox(options: { type: "error"; title: string; message: string; buttons: string[] }): Promise<unknown>;
    showErrorBox?(title: string, content: string): void;
  };
  ipcMain?: {
    handle(channel: string, listener: (...args: unknown[]) => unknown): void;
    removeHandler?(channel: string): void;
  };
};

export type DesktopOptions = {
  projectRoot?: string;
  hostname?: string;
  port?: number;
  nodeExecutable?: string;
  nextCli?: string;
  agentDirectory?: string;
  createServerManager?: (options: ConstructorParameters<typeof ServerManager>[0]) => ServerManager;
  getFreePort?: (hostname: string) => Promise<number>;
};

export type DesktopController = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number | undefined;
  getWindow(): unknown;
};

export const ONBOARDING_GET_CHANNEL = "pi-chat:onboarding:get-state";
export const ONBOARDING_COMPLETE_CHANNEL = "pi-chat:onboarding:complete";

export function registerOnboardingIpc(electron: ElectronApi): void {
  const ipcMain = electron.ipcMain;
  const userDataPath = electron.app.getPath?.("userData");
  if (!ipcMain || !userDataPath) return;
  ipcMain.removeHandler?.(ONBOARDING_GET_CHANNEL);
  ipcMain.removeHandler?.(ONBOARDING_COMPLETE_CHANNEL);
  ipcMain.handle(ONBOARDING_GET_CHANNEL, async () => readOnboardingState(userDataPath));
  ipcMain.handle(ONBOARDING_COMPLETE_CHANNEL, async () => {
    await completeOnboarding(userDataPath);
    return { completed: true };
  });
}

export async function getFreePort(hostname = "127.0.0.1"): Promise<number> {
  const probe = createServer();
  probe.listen(0, hostname);
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not select a local port");
  return port;
}

function safeStartupMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Keep user-visible errors short and free of credentials or full local paths.
  if (/timed out/i.test(message)) return "Pi Chat 后端启动超时。\n请确认应用文件完整，然后重新打开应用。";
  if (/enoent|eacces|node(?:\.js)? executable|cannot find module|production build/i.test(message)) {
    return "Pi Chat 尚未准备好。\n请先完成应用构建，或重新安装 Pi Chat。";
  }
  return "Pi Chat 无法启动。\n请重新打开应用。";
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|token|password|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/(?:\/Users\/|\/home\/)[^\n]*/g, "<path>")
    .replace(/[A-Za-z]:[\\/][^\n]*/g, "<path>")
    .slice(0, 2_000);
}

function localUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/") {
    throw new Error("Pi Chat server URL was not a validated loopback URL");
  }
  return parsed.toString();
}

export function createDesktopController(electron: ElectronApi, options: DesktopOptions = {}): DesktopController {
  const app = electron.app;
  const hostname = options.hostname ?? "127.0.0.1";
  let port: number | undefined;
  let window: InstanceType<ElectronApi["BrowserWindow"]> | undefined;
  let manager: ServerManager | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let startupFailureReported = false;
  let windowLoadSucceeded = false;

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (manager) await manager.stopServer();
      manager = undefined;
    })().finally(() => { stopPromise = undefined; });
    return stopPromise;
  };

  const stopAndQuit = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await stop();
      app.quit();
    })();
    return shutdownPromise;
  };

  const reportStartupFailure = async (error: unknown): Promise<void> => {
    if (startupFailureReported || shutdownPromise) return;
    startupFailureReported = true;
    console.error("[pi-chat] desktop startup failed:", safeDiagnostic(error));
    await electron.dialog.showMessageBox({
      type: "error",
      title: "Pi Chat 启动失败",
      message: safeStartupMessage(error),
      buttons: ["退出"],
    });
    await stopAndQuit();
  };

  const start = async (): Promise<void> => {
    if (manager && window) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      port = options.port ?? await (options.getFreePort ?? getFreePort)(hostname);
      const runtimePaths = resolveDesktopPaths({
        projectRoot: options.projectRoot,
        appPath: app.getAppPath?.(),
        isPackaged: app.isPackaged,
        resourcesPath: (process as unknown as { resourcesPath?: string }).resourcesPath,
      });
      const nodeExecutable = options.nodeExecutable ?? resolveNodeExecutable({ electronVersion: process.versions.electron });
      const nextCli = options.nextCli ?? runtimePaths.nextCli;
      const serverOptions = {
        command: nodeExecutable,
        args: [nextCli, "start", "-H", hostname, "-p", String(port)],
        hostname,
        port,
        cwd: runtimePaths.projectRoot,
        env: {
          ...process.env,
          ...(options.agentDirectory ? { PI_CODING_AGENT_DIR: options.agentDirectory } : {}),
          NEXT_TELEMETRY_DISABLED: "1",
        },
      };
      manager = options.createServerManager?.(serverOptions) ?? new ServerManager(serverOptions);
      await manager.waitUntilReady();

      const serverUrl = localUrl(manager.getUrl());
      window = new electron.BrowserWindow({
          width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        webPreferences: {
          preload: runtimePaths.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));
      window.webContents?.on?.("did-fail-load", (...args: unknown[]) => {
        if (args[4] === true && !windowLoadSucceeded) {
          void reportStartupFailure(new Error("Pi Chat main document failed to load"));
        }
      });
      window.once?.("closed", () => { void stopAndQuit(); });
      await window.loadURL(serverUrl);
      windowLoadSucceeded = true;
      window.show?.();
    })().catch(async (error) => {
      await reportStartupFailure(error);
      throw error;
    }).finally(() => { startPromise = undefined; });
    return startPromise;
  };

  app.on("window-all-closed", () => { void stopAndQuit(); });
  app.on("before-quit", (event: unknown) => {
    if (!shutdownPromise) (event as { preventDefault?: () => void }).preventDefault?.();
    void stopAndQuit();
  });

  return {
    start,
    stop: stopAndQuit,
    getPort: () => port,
    getWindow: () => window,
  };
}

export async function startElectronApp(electron: ElectronApi): Promise<void> {
  const { app } = electron;
  if (app.requestSingleInstanceLock && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const controller = createDesktopController(electron);
  app.on("second-instance", () => {
    const window = controller.getWindow() as { show?: () => void; focus?: () => void } | undefined;
    window?.show?.();
    window?.focus?.();
  });
  await app.whenReady();
  registerOnboardingIpc(electron);
  await controller.start().catch(() => undefined);
}
