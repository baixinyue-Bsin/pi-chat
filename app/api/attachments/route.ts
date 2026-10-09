import { NextResponse } from "next/server";
import { readdir, rm, stat } from "fs/promises";
import path from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function attachmentRoot(cwd: string): string {
  return path.join(cwd, ".pi-web", "attachments");
}

function isSafeManagedPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function listFiles(directory: string, root: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(candidate, root));
    else if (entry.isFile() && isSafeManagedPath(candidate, root)) result.push(path.relative(root, candidate).split(path.sep).join("/"));
  }
  return result;
}

async function validateCwd(cwd: string): Promise<NextResponse | null> {
  const roots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, roots)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  return null;
}

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const denied = await validateCwd(cwd);
  if (denied) return denied;
  const root = attachmentRoot(cwd);
  const files = (await listFiles(root, root)).sort((a, b) => a.localeCompare(b));
  return NextResponse.json({ files });
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body = await req.json() as { cwd?: unknown; file?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const file = typeof body.file === "string" ? body.file : "";
    if (!cwd || !file) return NextResponse.json({ error: "cwd and file required" }, { status: 400 });
    const denied = await validateCwd(cwd);
    if (denied) return denied;
    const root = attachmentRoot(cwd);
    const target = path.resolve(root, file);
    if (!isSafeManagedPath(target, root)) return NextResponse.json({ error: "Only Pi Chat uploaded files can be deleted" }, { status: 403 });
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return NextResponse.json({ error: "Managed upload not found" }, { status: 404 });
    await rm(target);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
