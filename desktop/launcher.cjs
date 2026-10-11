"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { createJiti } = require("jiti");
const electron = require("electron");
const jiti = createJiti(__filename, { interopDefault: true });

void jiti.import("./main.ts")
  .then(({ startElectronApp }) => startElectronApp(electron))
  .catch((error) => {
    console.error("[pi-chat] could not load the Electron main process", error);
    electron.app.quit();
  });
