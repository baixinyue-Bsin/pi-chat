#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const NODE_VERSION = "22.19.0";
export const NODE_PLATFORM = "darwin";
export const NODE_ARCH = "arm64";
export const NODE_ARCHIVE_NAME = `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}.tar.gz`;
export const NODE_DOWNLOAD_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}`;
export const NODE_SHA256 = "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeRoot = path.join(projectRoot, "desktop", "node-runtime");
export const targetNode = path.join(runtimeRoot, "bin", "node");

function safeMessage(error) {
  const home = os.homedir();
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(home, "~").slice(0, 2_000);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function isExecutableNode(filePath) {
  try {
    const file = await stat(filePath);
    if (!file.isFile() || (file.mode & 0o111) === 0) return false;
    const result = spawnSync(filePath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0 && result.stdout.trim() === `v${NODE_VERSION}`;
  } catch {
    return false;
  }
}

export async function validateExistingRuntime(filePath = targetNode) {
  return isExecutableNode(filePath);
}

async function downloadArchive(destination) {
  const response = await fetch(NODE_DOWNLOAD_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`下载 Node.js 失败：HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, data, { mode: 0o600 });
}

async function getVerifiedArchive(cachePath) {
  if (await pathExists(cachePath)) {
    if (await sha256(cachePath) === NODE_SHA256) return cachePath;
    await rm(cachePath, { force: true });
  }

  const temporaryPath = `${cachePath}.download-${process.pid}`;
  await rm(temporaryPath, { force: true });
  try {
    await downloadArchive(temporaryPath);
    const actual = await sha256(temporaryPath);
    if (actual !== NODE_SHA256) {
      throw new Error(`Node.js 压缩包 SHA-256 校验失败：${actual}`);
    }
    await rename(temporaryPath, cachePath);
    return cachePath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ensureInstallableRoot() {
  if (!(await pathExists(runtimeRoot))) return;
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  const allowed = entries.every((entry) => entry.name === "README.md" || entry.name === "bin");
  if (!allowed) throw new Error("desktop/node-runtime 已存在且内容异常，为避免覆盖未知 runtime，安装已停止。");
  if (entries.some((entry) => entry.name === "bin" && !entry.isDirectory())) {
    throw new Error("desktop/node-runtime/bin 不是目录，为避免覆盖未知 runtime，安装已停止。");
  }
  const binPath = path.join(runtimeRoot, "bin");
  if (await pathExists(binPath)) {
    const binEntries = await readdir(binPath);
    if (binEntries.length > 0) throw new Error("desktop/node-runtime/bin 已存在内容，为避免覆盖未知 runtime，安装已停止。");
  }
}

export async function installNodeRuntime() {
  if (process.platform !== NODE_PLATFORM || process.arch !== NODE_ARCH) {
    throw new Error(`当前平台为 ${process.platform}/${process.arch}，此脚本只支持 macOS arm64。`);
  }

  if (await pathExists(targetNode)) {
    if (await validateExistingRuntime()) {
      console.log(`Node.js ${NODE_VERSION} runtime 已验证，跳过下载。`);
      return targetNode;
    }
    throw new Error("desktop/node-runtime/bin/node 已存在但校验失败，为避免覆盖未知 runtime，安装已停止。");
  }

  await ensureInstallableRoot();
  const cacheDirectory = path.join(projectRoot, ".cache", "pi-chat-node");
  await mkdir(cacheDirectory, { recursive: true });
  const cachePath = path.join(cacheDirectory, NODE_ARCHIVE_NAME);
  const archivePath = await getVerifiedArchive(cachePath);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-chat-node-"));
  try {
    const extractionDirectory = path.join(temporaryDirectory, "extract");
    await mkdir(extractionDirectory);
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractionDirectory], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`解压 Node.js 失败：${safeMessage(result.stderr || result.stdout)}`);
    const extractedNode = path.join(extractionDirectory, `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}`, "bin", "node");
    if (!(await isExecutableNode(extractedNode))) throw new Error("解压后的 Node.js 未通过版本或可执行权限校验。");

    await mkdir(path.join(runtimeRoot, "bin"), { recursive: true });
    const stagedNode = path.join(runtimeRoot, "bin", `.node-${process.pid}.tmp`);
    try {
      await copyFile(extractedNode, stagedNode);
      await chmod(stagedNode, 0o755);
      await rename(stagedNode, targetNode);
    } finally {
      await rm(stagedNode, { force: true });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  if (!(await validateExistingRuntime())) throw new Error("安装后的 Node.js runtime 校验失败。");
  console.log(`Node.js ${NODE_VERSION} runtime 已安装到 desktop/node-runtime/bin/node。`);
  return targetNode;
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  installNodeRuntime().catch((error) => {
    console.error(`Node.js runtime 安装失败：${safeMessage(error)}`);
    process.exitCode = 1;
  });
}
