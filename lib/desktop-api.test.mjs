import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getDesktopApi } = await createJiti(import.meta.url).import("./desktop-api.ts");

test("browser mode has no desktop onboarding API", () => {
  const previousWindow = globalThis.window;
  try {
    delete globalThis.window;
    assert.equal(getDesktopApi(), undefined);
    globalThis.window = {};
    assert.equal(getDesktopApi(), undefined);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("only the explicit Electron bridge enables onboarding", () => {
  const previousWindow = globalThis.window;
  const api = { isElectron: true, getOnboardingState: async () => ({ completed: false }), completeOnboarding: async () => {} };
  try {
    globalThis.window = { piChatDesktop: { isElectron: false } };
    assert.equal(getDesktopApi(), undefined);
    globalThis.window = { piChatDesktop: api };
    assert.equal(getDesktopApi(), api);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
