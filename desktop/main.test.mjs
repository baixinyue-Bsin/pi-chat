import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createJiti } from "jiti";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDesktopController, getFreePort } = await jiti.import("./main.ts");
const { resolveDesktopPaths, resolveNodeExecutable } = await jiti.import("./paths.ts");

test("does not use Electron as the backend Node executable", () => {
  assert.equal(resolveNodeExecutable({ env: { PI_CHAT_NODE_PATH: "/custom/node" }, electronVersion: "37" }), "/custom/node");
  assert.throws(
    () => resolveNodeExecutable({ env: { PATH: "" }, electronVersion: "37", platform: "darwin", execPath: "/Applications/Electron" }),
    /Node\.js executable not found/,
  );
});

test("keeps source and future packaged paths explicit", () => {
  const sourcePaths = resolveDesktopPaths({ projectRoot: root });
  assert.equal(sourcePaths.projectRoot, root);
  assert.equal(sourcePaths.buildPath, path.join(root, ".next"));
  assert.equal(sourcePaths.preloadPath, path.join(root, "desktop", "preload.cjs"));
  const packagedPaths = resolveDesktopPaths({ appPath: "/app.asar", isPackaged: true, resourcesPath: "/resources", nextCli: "/app.asar/node_modules/next/dist/bin/next" });
  assert.equal(packagedPaths.projectRoot, "/app.asar");
  assert.equal(packagedPaths.resourcesPath, "/resources");
});

function fakeApp() {
  const listeners = new Map();
  return {
    listeners,
    whenReady: async () => {},
    on(event, listener) { listeners.set(event, listener); },
    quitCalls: 0,
    quit() { this.quitCalls += 1; },
  };
}

function fakeElectron(app, windows, dialogs = [], loadURLBehavior) {
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.listeners = new Map();
      this.webContents = {
        listeners: new Map(),
        on: (event, listener) => this.webContents.listeners.set(event, listener),
        setWindowOpenHandler: () => {},
      };
      windows.push(this);
    }
    async loadURL(url) {
      this.loadedUrl = url;
      await loadURLBehavior?.(this, url);
    }
    on(event, listener) { this.listeners.set(event, listener); }
    once(event, listener) { this.listeners.set(event, listener); }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    trigger(event, ...args) { this.listeners.get(event)?.(...args); }
    triggerWebContents(event, ...args) { this.webContents.listeners.get(event)?.({}, ...args); }
  }
  return {
    app,
    BrowserWindow: FakeWindow,
    dialog: {
      async showMessageBox(options) { dialogs.push(options); },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("selects a random loopback port and waits for health before creating the window", async () => {
  const app = fakeApp();
  const windows = [];
  const managerCalls = [];
  const manager = {
    async waitUntilReady() { managerCalls.push("ready"); },
    async stopServer() { managerCalls.push("stop"); },
    getUrl() { return "http://127.0.0.1:43210"; },
  };
  const electron = fakeElectron(app, windows);
  const controller = createDesktopController(electron, {
    projectRoot: root,
    getFreePort: async () => 43210,
    createServerManager: (options) => {
      managerCalls.push(options);
      assert.equal(options.hostname, "127.0.0.1");
      assert.equal(options.port, 43210);
      assert.notEqual(options.port, 30141);
      return manager;
    },
  });
  const start = controller.start();
  assert.equal(windows.length, 0);
  await start;
  assert.equal(managerCalls[1], "ready");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].loadedUrl, "http://127.0.0.1:43210/");
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  await controller.start();
  assert.equal(windows.length, 1);
  assert.equal(managerCalls.filter((entry) => typeof entry === "object").length, 1);
  await controller.stop();
  assert.deepEqual(managerCalls.slice(-1), ["stop"]);
});

test("window close, window-all-closed, and before-quit share one shutdown", async () => {
  const app = fakeApp();
  const windows = [];
  let stopCalls = 0;
  const electron = fakeElectron(app, windows);
  const controller = createDesktopController(electron, {
    getFreePort: async () => 43212,
    createServerManager: () => ({
      async waitUntilReady() {},
      async stopServer() { stopCalls += 1; },
      getUrl() { return "http://127.0.0.1:43212"; },
    }),
  });

  await controller.start();
  windows[0].trigger("closed");
  app.listeners.get("window-all-closed")?.();
  app.listeners.get("before-quit")?.({ preventDefault() {} });
  await flush();
  windows[0].trigger("closed");
  app.listeners.get("before-quit")?.({ preventDefault() {} });
  await flush();
  assert.equal(stopCalls, 1);
  assert.equal(app.quitCalls, 1);
});

test("only a main document load failure reports startup failure", async () => {
  const app = fakeApp();
  const windows = [];
  const dialogs = [];
  const electron = fakeElectron(app, windows, dialogs, async (window) => {
    window.triggerWebContents("did-fail-load", -6, "failed", "http://127.0.0.1:43213/", true);
  });
  let stopCalls = 0;
  const controller = createDesktopController(electron, {
    getFreePort: async () => 43213,
    createServerManager: () => ({
      async waitUntilReady() {},
      async stopServer() { stopCalls += 1; },
      getUrl() { return "http://127.0.0.1:43213"; },
    }),
  });

  await controller.start();
  await flush();
  assert.equal(dialogs.length, 1);
  assert.equal(stopCalls, 1);
  assert.equal(app.quitCalls, 1);
});

test("loadURL rejection and did-fail-load produce one failure response", async () => {
  const app = fakeApp();
  const windows = [];
  const dialogs = [];
  const electron = fakeElectron(app, windows, dialogs, async (window) => {
    window.triggerWebContents("did-fail-load", -6, "failed", "http://127.0.0.1:43215/", true);
    throw new Error("loadURL failed with token=secret-value");
  });
  let stopCalls = 0;
  const controller = createDesktopController(electron, {
    getFreePort: async () => 43215,
    createServerManager: () => ({
      async waitUntilReady() {},
      async stopServer() { stopCalls += 1; },
      getUrl() { return "http://127.0.0.1:43215"; },
    }),
  });

  await controller.start().catch(() => {});
  await flush();
  assert.equal(dialogs.length, 1);
  assert.equal(stopCalls, 1);
  assert.equal(app.quitCalls, 1);
});

test("subresource load failures and post-load main-frame events are ignored", async () => {
  const app = fakeApp();
  const windows = [];
  const dialogs = [];
  const electron = fakeElectron(app, windows, dialogs);
  let stopCalls = 0;
  const controller = createDesktopController(electron, {
    getFreePort: async () => 43214,
    createServerManager: () => ({
      async waitUntilReady() {},
      async stopServer() { stopCalls += 1; },
      getUrl() { return "http://127.0.0.1:43214"; },
    }),
  });

  await controller.start();
  windows[0].triggerWebContents("did-fail-load", -6, "failed", "http://127.0.0.1:43214/app.js", false);
  windows[0].triggerWebContents("did-fail-load", -6, "failed", "http://127.0.0.1:43214/", true);
  await flush();
  assert.equal(dialogs.length, 0);
  assert.equal(stopCalls, 0);
  await controller.stop();
});

test("startup failure shows an error and never creates a normal window", async () => {
  const app = fakeApp();
  const windows = [];
  const dialogs = [];
  const electron = fakeElectron(app, windows, dialogs);
  const controller = createDesktopController(electron, {
    getFreePort: async () => 43211,
    createServerManager: () => ({
      async waitUntilReady() { throw new Error("Timed out waiting for Pi Chat server readiness"); },
      async stopServer() {},
      getUrl() { return "http://127.0.0.1:43211"; },
    }),
  });
  await controller.start().catch(() => {});
  assert.equal(windows.length, 0);
  assert.equal(dialogs.length, 1);
  assert.equal(app.quitCalls, 1);
});

test("real production integration uses a temporary agent directory and leaves 30141 alone", { timeout: 90_000 }, async (t) => {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-chat-desktop-test-"));
  const port = await getFreePort();
  const app = fakeApp();
  const windows = [];
  const electron = fakeElectron(app, windows);
  const controller = createDesktopController(electron, {
    projectRoot: root,
    port,
    agentDirectory,
  });
  t.after(async () => {
    await controller.stop();
    await rm(agentDirectory, { recursive: true, force: true });
  });

  await controller.start();
  assert.equal(windows.length, 1);
  assert.equal(new URL(windows[0].loadedUrl).port, String(port));
  assert.equal((await fetch(`${windows[0].loadedUrl}api/health`)).status, 200);
  assert.equal((await fetch("http://127.0.0.1:30141/api/health")).status, 200);
  await controller.stop();
  await assert.rejects(fetch(`${windows[0].loadedUrl}api/health`));
  assert.equal((await fetch("http://127.0.0.1:30141/api/health")).status, 200);
});
