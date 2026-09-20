import { getBase64DecodedByteLength } from "./image-attachments";

export const MAX_ATTACHED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHED_FILES = 10;

export interface Base64FileAttachment {
  name: string;
  data: string;
  mimeType: string;
}

export function safeAttachmentFileName(name: string): string | null {
  const baseName = name.replace(/\\/g, "/").split("/").pop()?.trim();
  if (!baseName || baseName === "." || baseName === ".." || baseName.length > 255) return null;
  return baseName.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

export function isBase64FileWithinLimits(value: unknown): value is Base64FileAttachment {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<Base64FileAttachment>;
  if (typeof file.name !== "string" || !safeAttachmentFileName(file.name) || typeof file.data !== "string" || typeof file.mimeType !== "string") return false;
  const bytes = getBase64DecodedByteLength(file.data);
  return bytes !== null && bytes <= MAX_ATTACHED_FILE_BYTES;
}

export function validateAgentFiles(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "files must be an array";
  if (value.length > MAX_ATTACHED_FILES) return `A message can include at most ${MAX_ATTACHED_FILES} files`;
  if (!value.every(isBase64FileWithinLimits)) {
    return `Each file must be valid base64 data of ${MAX_ATTACHED_FILE_BYTES / (1024 * 1024)}MB or smaller`;
  }
  return null;
}
