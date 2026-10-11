import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DesktopLogger = {
  log(event: string, fields?: Record<string, unknown>): void;
};

export type DesktopLoggerOptions = {
  directory?: string;
  fileName?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  const home = homedir();
  return message
    .replace(/(api[-_ ]?key|token|password|authorization|secret|cookie)\s*([:=])\s*["']?[^\s,;"']+/gi, "$1$2<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|pk|rk|xox[baprs])-?[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(new RegExp(escapeRegExp(home), "g"), "~")
    .replace(/\/(?:Users|home)\/[^\s,;"']+/g, "<user-path>")
    .replace(/(?:[A-Za-z]:[\\/]|\/private\/var\/)[^\s,;"']+/g, "<private-path>")
    .slice(0, 2_000);
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnostic(value);
  if (value instanceof Error) return redactDiagnostic(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

export function defaultDesktopLogDirectory(): string {
  return join(homedir(), "Library", "Logs", "Pi Chat");
}

export function createDesktopLogger(options: DesktopLoggerOptions = {}): DesktopLogger {
  const directory = options.directory ?? defaultDesktopLogDirectory();
  const filePath = join(directory, options.fileName ?? "pi-chat.log");
  return {
    log(event, fields = {}) {
      try {
        mkdirSync(directory, { recursive: true });
        const record = {
          timestamp: new Date().toISOString(),
          event: redactDiagnostic(event),
          ...sanitize(fields) as Record<string, unknown>,
        };
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // Diagnostics must never prevent the desktop app from starting.
      }
    },
  };
}
