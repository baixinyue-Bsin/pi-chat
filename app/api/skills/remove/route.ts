import { NextResponse } from "next/server";
import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getGlobalSkillsLockPath } from "@/lib/skill-lock";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import type { SkillInstallScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function within(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function lockPath(cwd: string, scope: SkillInstallScope): string {
  return scope === "global" ? getGlobalSkillsLockPath() : path.join(cwd, "skills-lock.json");
}

function removeLockEntry(filePath: string, skillName: string): void {
  if (!existsSync(filePath)) return;
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { skills?: Record<string, unknown> };
  if (!parsed.skills || typeof parsed.skills !== "object") return;
  const key = Object.keys(parsed.skills).find((item) => item.toLowerCase() === skillName.toLowerCase());
  if (!key) return;
  delete parsed.skills[key];
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body = await req.json() as { cwd?: unknown; filePath?: unknown; scope?: unknown; name?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const scope = body.scope === "global" || body.scope === "project" ? body.scope : null;
    const name = typeof body.name === "string" ? body.name : "";
    if (!cwd || !filePath || !scope || !name) return NextResponse.json({ error: "cwd, filePath, scope and name are required" }, { status: 400 });
    const roots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, roots)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    const installed = (await loadSkillsWithInstallInfo(cwd)).skills.find((skill) =>
      skill.filePath === filePath && skill.name === name && skill.install?.scope === scope,
    );
    if (!installed?.install) return NextResponse.json({ error: "Skill installation record not found" }, { status: 404 });
    const installRoot = scope === "project" ? path.join(cwd, ".pi", "skills") : path.join(getAgentDir(), "skills");
    const globalRoot = path.join(homedir(), ".agents", "skills");
    const skillDir = path.dirname(filePath);
    const safeRoot = within(skillDir, installRoot) ? installRoot : scope === "global" && within(skillDir, globalRoot) ? globalRoot : null;
    if (!safeRoot || !existsSync(filePath)) return NextResponse.json({ error: "Skill is not managed by Pi Chat" }, { status: 403 });
    const skillStat = lstatSync(skillDir);
    if (skillStat.isSymbolicLink()) unlinkSync(skillDir);
    else rmSync(skillDir, { recursive: true, force: false });
    removeLockEntry(lockPath(cwd, scope), name);
    const refreshed = await loadSkillsWithInstallInfo(cwd);
    return NextResponse.json({ success: true, skills: refreshed.skills });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
