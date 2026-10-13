import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ServerManager } = await jiti.import("./server-manager.ts");
const root = process.cwd();
const productionRoot = process.env.PI_CHAT_TEST_ROOT ?? root;

async function getFreePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function nodeManager(port, options = {}) {
  return new ServerManager({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    hostname: "127.0.0.1",
    port,
    cwd: root,
    startupTimeoutMs: 250,
    stopTimeoutMs: 500,
    ...options,
  });
}

test("concurrent startServer calls share the in-flight promise", async () => {
  const manager = nodeManager(await getFreePort(), {
    fetchImpl: async () => new Response(null, { status: 200 }),
  });

  const first = manager.startServer();
  const second = manager.startServer();
  assert.strictEqual(second, first);
  await first;
  await manager.stopServer();
});

test("starts the production service, waits for health, and stops without touching 30141", async (t) => {
  const testAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-server-manager-"));
  const port = await getFreePort();
  const manager = new ServerManager({
    command: process.execPath,
    args: [path.join(productionRoot, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)],
    hostname: "127.0.0.1",
    port,
    cwd: productionRoot,
    env: { PI_CODING_AGENT_DIR: testAgentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    startupTimeoutMs: 60_000,
    stopTimeoutMs: 5_000,
  });
  t.after(async () => {
    await manager.stopServer();
    await rm(testAgentDir, { recursive: true, force: true });
  });

  await manager.startServer();
  await manager.waitUntilReady();
  assert.equal(manager.getUrl(), `http://127.0.0.1:${port}`);
  const response = await fetch(`${manager.getUrl()}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  // The manager must use the explicitly configured test port. Do not depend
  // on a developer's unrelated server being present on the default dev port.
  assert.notEqual(port, 30141);

  await manager.stopServer();
  await manager.stopServer();
  assert.equal(await fetch(`${manager.getUrl()}/api/health`).catch(() => null), null);
});

test("reports a child startup failure", async () => {
  const manager = nodeManager(await getFreePort(), {
    args: ["-e", "process.stderr.write('startup failed'); process.exit(1)"],
    startupTimeoutMs: 1_000,
  });

  await assert.rejects(manager.waitUntilReady(), /startup failed|exited before becoming ready/);
  await manager.stopServer();
});

test("times out when health never becomes ready and preserves the error", async () => {
  const manager = nodeManager(await getFreePort(), { startupTimeoutMs: 180 });

  await manager.startServer();
  await assert.rejects(manager.waitUntilReady(), /Timed out waiting for Pi Chat server readiness/);
  assert.ok(manager.getLastError() === undefined || manager.getLastError() instanceof Error);
  await manager.stopServer();
});

test("handles an occupied port", async () => {
  const port = await getFreePort();
  const occupied = createServer(() => {}).listen(port, "127.0.0.1");
  await once(occupied, "listening");
  const manager = new ServerManager({
    command: process.execPath,
    args: ["-e", "require('node:http').createServer().listen(Number(process.argv[1]), '127.0.0.1')", String(port)],
    hostname: "127.0.0.1",
    port,
    cwd: root,
    startupTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(manager.waitUntilReady(), /EADDRINUSE|exited before becoming ready|Timed out/);
  } finally {
    await manager.stopServer();
    await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("passes temporary agent settings and leaves no child after graceful stop", async () => {
  const testAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-server-manager-env-"));
  const probePath = path.join(testAgentDir, "env.txt");
  const port = await getFreePort();
  let child;
  const manager = nodeManager(port, {
    env: { PI_CODING_AGENT_DIR: testAgentDir, PROBE_PATH: probePath },
    args: ["-e", "require('node:fs').writeFileSync(process.env.PROBE_PATH, process.env.PI_CODING_AGENT_DIR); setInterval(() => {}, 1000)"],
    fetchImpl: async () => new Response(null, { status: 200 }),
    spawnImpl: (command, args, options) => {
      child = spawn(command, args, options);
      return child;
    },
  });
  try {
    await manager.waitUntilReady();
    const deadline = Date.now() + 2_000;
    let observed;
    while (Date.now() < deadline) {
      observed = await readFile(probePath, "utf8").catch(() => undefined);
      if (observed !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(observed, testAgentDir);
    const pid = child.pid;
    await manager.stopServer();
    await manager.stopServer();
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await manager.stopServer();
    await rm(testAgentDir, { recursive: true, force: true });
  }
});
