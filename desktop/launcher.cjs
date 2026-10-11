"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { createJiti } = require("jiti");
const electron = require("electron");
const { appendFileSync, mkdirSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const jiti = createJiti(__filename, { interopDefault: true });

function logLauncherFailure(error) {
  try {
    const directory = join(homedir(), "Library", "Logs", "Pi Chat");
    mkdirSync(directory, { recursive: true });
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message
      .replace(/(api[-_ ]?key|token|password|authorization|secret)\s*([:=])\s*[^\s,;]+/gi, "$1$2<redacted>")
      .replace(/\b(?:sk|pk|rk|xox[baprs])-?[A-Za-z0-9_-]+\b/g, "<redacted>")
      .replace(new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "~")
      .slice(0, 2_000);
    appendFileSync(join(directory, "pi-chat.log"), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "launcher_failure",
      error: safeMessage,
    })}\n`, "utf8");
  } catch {
    // A diagnostic failure must not mask the original startup failure.
  }
}

void jiti.import("./main.ts")
  .then(({ startElectronApp }) => startElectronApp(electron))
  .catch((error) => {
    logLauncherFailure(error);
    electron.app.quit();
  });
