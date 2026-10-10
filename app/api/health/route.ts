import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

type PackageMetadata = { version?: unknown };

function readPackageVersion(packagePath: string): string {
  try {
    const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as PackageMetadata;
    return typeof metadata.version === "string" ? metadata.version : "unknown";
  } catch {
    return "unknown";
  }
}

const projectRoot = process.cwd();
const appVersion = process.env.NEXT_PUBLIC_APP_VERSION
  ?? readPackageVersion(join(projectRoot, "package.json"));
const piVersion = process.env.NEXT_PUBLIC_PI_VERSION
  ?? readPackageVersion(join(
    projectRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  ));

export function GET() {
  return NextResponse.json({
    ok: true,
    app: "pi-chat",
    version: appVersion,
    piVersion,
  });
}
