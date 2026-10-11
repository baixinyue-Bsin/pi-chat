import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export type DesktopPathOptions = {
  projectRoot?: string;
  desktopDirectory?: string;
  appPath?: string;
  resourcesPath?: string;
  isPackaged?: boolean;
  nextCli?: string;
};

export type DesktopPaths = {
  projectRoot: string;
  resourcesPath?: string;
  buildPath: string;
  publicPath: string;
  nextCli: string;
  preloadPath: string;
};

export function projectRootFromDesktop(desktopDirectory: string = dirname(fileURLToPath(import.meta.url))): string {
  return resolve(desktopDirectory, "..");
}

export function resolveDesktopPaths(options: DesktopPathOptions = {}): DesktopPaths {
  const projectRoot = options.projectRoot
    ?? (options.isPackaged && options.appPath
      ? options.appPath
      : projectRootFromDesktop(options.desktopDirectory));
  return {
    projectRoot,
    resourcesPath: options.resourcesPath,
    buildPath: join(projectRoot, ".next"),
    publicPath: join(projectRoot, "public"),
    nextCli: options.nextCli ?? resolveNextCli(projectRoot),
    preloadPath: join(projectRoot, "desktop", "preload.cjs"),
  };
}

function executableOnPath(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return undefined;
}

export function resolveNodeExecutable(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  electronVersion?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const configured = env.PI_CHAT_NODE_PATH?.trim();
  if (configured) return isAbsolute(configured) ? normalize(configured) : configured;

  // Electron's process.execPath points to Electron, so prefer a PATH lookup
  // while running in the Electron main process. This keeps Next.js in a plain
  // Node process and leaves packaged-app overrides available through env.
  if (options.electronVersion || process.versions.electron) {
    const nodeName = options.platform === "win32" || process.platform === "win32" ? "node.exe" : "node";
    const executable = executableOnPath(nodeName, env.PATH);
    if (executable) return executable;
    throw new Error("Node.js executable not found in PATH; set PI_CHAT_NODE_PATH");
  }

  return options.execPath ?? process.execPath;
}

export function resolveNextCli(projectRoot: string): string {
  return require.resolve("next/dist/bin/next", { paths: [projectRoot] });
}
