"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piChatDesktop", {
  isElectron: true,
  getOnboardingState: () => ipcRenderer.invoke("pi-chat:onboarding:get-state"),
  completeOnboarding: () => ipcRenderer.invoke("pi-chat:onboarding:complete"),
});
