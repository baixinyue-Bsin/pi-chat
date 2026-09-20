import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { safeAttachmentFileName, type Base64FileAttachment } from "./file-attachment-validation";

export type { Base64FileAttachment } from "./file-attachment-validation";

export async function persistAgentFiles(cwd: string, sessionId: string, files: Base64FileAttachment[]): Promise<string[]> {
  if (!files.length) return [];
  const directory = join(cwd, ".pi-web", "attachments", sessionId);
  await mkdir(directory, { recursive: true });
  const usedNames = new Set<string>();
  const paths: string[] = [];
  for (const file of files) {
    const originalName = safeAttachmentFileName(file.name);
    if (!originalName) throw new Error("Invalid attachment file name");
    const extIndex = originalName.lastIndexOf(".");
    const stem = extIndex > 0 ? originalName.slice(0, extIndex) : originalName;
    const extension = extIndex > 0 ? originalName.slice(extIndex) : "";
    let name = originalName;
    let index = 2;
    while (usedNames.has(name)) name = `${stem} (${index++})${extension}`;
    usedNames.add(name);
    const path = join(directory, name);
    await writeFile(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}
