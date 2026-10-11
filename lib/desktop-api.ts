export type PiChatDesktopApi = {
  isElectron: true;
  getOnboardingState(): Promise<{ completed: boolean }>;
  completeOnboarding(): Promise<void>;
};

declare global {
  interface Window {
    piChatDesktop?: PiChatDesktopApi;
  }
}

export function getDesktopApi(): PiChatDesktopApi | undefined {
  return typeof window !== "undefined" && window.piChatDesktop?.isElectron === true
    ? window.piChatDesktop
    : undefined;
}

