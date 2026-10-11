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

export type NodeResolution = {
  executable: string;
  source: "environment" | "bundled" | "path" | "process";
  candidates: string[];
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

export function resolveNodeExecutableInfo(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  electronVersion?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
} = {}): NodeResolution {
  const env = options.env ?? process.env;
  const configured = env.PI_CHAT_NODE_PATH?.trim();
  const platform = options.platform ?? process.platform;
  const candidates: string[] = [];
  if (configured) {
    const executable = isAbsolute(configured) ? normalize(configured) : configured;
    return { executable, source: "environment", candidates: [executable] };
  }

  const packaged = options.isPackaged ?? Boolean(options.resourcesPath);
  if (packaged && options.resourcesPath) {
    const nodeName = platform === "win32" ? "node.exe" : "node";
    const bundled = join(options.resourcesPath, "node", "bin", nodeName);
    candidates.push(bundled);
    try {
      accessSync(bundled, constants.X_OK);
      return { executable: bundled, source: "bundled", candidates };
    } catch {
      // Continue to the PATH fallback when an app bundle has no Node runtime.
    }
  }

  // Electron's process.execPath points to Electron, so prefer a PATH lookup
  // while running in the Electron main process. This keeps Next.js in a plain
  // Node process while retaining a fallback for development and old bundles.
  if (options.electronVersion || options.isPackaged || process.versions.electron) {
    const nodeName = platform === "win32" ? "node.exe" : "node";
    const executable = executableOnPath(nodeName, env.PATH);
    if (executable) return {
      executable,
      source: "path",
      candidates: [...candidates, executable],
    };
    throw new Error("未找到可用的 Node.js。请设置 PI_CHAT_NODE_PATH，或将 Node 放入应用资源目录。(Node.js executable not found in PATH)");
  }

  return {
    executable: options.execPath ?? process.execPath,
    source: "process",
    candidates,
  };
}

export function resolveNodeExecutable(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  electronVersion?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
} = {}): string {
  return resolveNodeExecutableInfo(options).executable;
}

export function resolveNextCli(projectRoot: string): string {
  return require.resolve("next/dist/bin/next", { paths: [projectRoot] });
}
