import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const state = await jiti.import("./onboarding-state.ts");
const main = await jiti.import("./main.ts");

async function tempUserData(t, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `pi-chat-onboarding-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("missing and malformed state files are treated as first launch", async (t) => {
  const userData = await tempUserData(t, "missing");
  assert.deepEqual(await state.readOnboardingState(userData), { version: 1, completed: false });
  await writeFile(state.onboardingStatePath(userData), "{not-json", "utf8");
  assert.deepEqual(await state.readOnboardingState(userData), { version: 1, completed: false });
  await writeFile(state.onboardingStatePath(userData), JSON.stringify({ completed: "yes" }), "utf8");
  assert.deepEqual(await state.readOnboardingState(userData), { version: 1, completed: false });
});

test("completion is atomic, repeatable, and stores no sensitive data", async (t) => {
  const userData = await tempUserData(t, "complete");
  await state.completeOnboarding(userData);
  await state.completeOnboarding(userData);
  assert.deepEqual(await state.readOnboardingState(userData), { version: 1, completed: true });
  assert.deepEqual(JSON.parse(await readFile(state.onboardingStatePath(userData), "utf8")), { version: 1, completed: true });
  assert.deepEqual((await readdir(userData)).sort(), ["onboarding.json"]);
});

test("registers only the two minimal onboarding IPC handlers", async (t) => {
  const userData = await tempUserData(t, "ipc");
  const handlers = new Map();
  const electron = {
    app: { getPath: () => userData },
    ipcMain: {
      removeHandler(channel) { handlers.delete(channel); },
      handle(channel, listener) { handlers.set(channel, listener); },
    },
  };
  main.registerOnboardingIpc(electron);
  assert.deepEqual([...handlers.keys()].sort(), [main.ONBOARDING_COMPLETE_CHANNEL, main.ONBOARDING_GET_CHANNEL].sort());
  assert.deepEqual(await handlers.get(main.ONBOARDING_GET_CHANNEL)(), { version: 1, completed: false });
  assert.deepEqual(await handlers.get(main.ONBOARDING_COMPLETE_CHANNEL)(), { completed: true });
  assert.deepEqual(await handlers.get(main.ONBOARDING_GET_CHANNEL)(), { version: 1, completed: true });
});

test("preload exposes no privileged Node APIs", async () => {
  const source = await readFile(path.join(process.cwd(), "desktop", "preload.cjs"), "utf8");
  assert.match(source, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(source, /require\(["'](?:fs|path|process|child_process)["']\)/);
  assert.doesNotMatch(source, /process\./);
  assert.doesNotMatch(source, /child_process/);
});
