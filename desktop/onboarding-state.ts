import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type OnboardingState = {
  version: 1;
  completed: boolean;
};

const STATE_FILE_NAME = "onboarding.json";
const DEFAULT_STATE: OnboardingState = { version: 1, completed: false };

export function onboardingStatePath(userDataPath: string): string {
  return join(userDataPath, STATE_FILE_NAME);
}

export async function readOnboardingState(userDataPath: string): Promise<OnboardingState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(onboardingStatePath(userDataPath), "utf8"));
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STATE };
    const value = parsed as { version?: unknown; completed?: unknown };
    if (value.version !== 1 || typeof value.completed !== "boolean") return { ...DEFAULT_STATE };
    return { version: 1, completed: value.completed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function completeOnboarding(userDataPath: string): Promise<void> {
  const filePath = onboardingStatePath(userDataPath);
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(userDataPath, { recursive: true });
  const contents = `${JSON.stringify({ version: 1, completed: true }, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await rename(temporaryPath, filePath);
    } catch (cause) {
      // Windows may refuse to replace an existing destination with rename.
      // Keep the normal path atomic and use a narrow fallback for that case.
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw cause;
      await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
    }
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}
