import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export interface RecentProject {
  /** Stable server-provided identity used for comparison and Map keys. */
  key: string;
  /** Original project path used for display and filesystem operations. */
  root: string;
  /** Latest activity across every session in this project. */
  modified: string;
}

/** Projects sorted by most recent activity and deduplicated by stable key. */
export function getRecentProjects(sessions: readonly SessionInfo[]): RecentProject[] {
  const latestByProject = new Map<string, { root: string; modified: string }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const key = workspaceKeyOf(session);
    const previous = latestByProject.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByProject.set(key, { root, modified: session.modified });
    }
  }
  return [...latestByProject.entries()]
    .sort((a, b) => b[1].modified.localeCompare(a[1].modified))
    .map(([key, { root, modified }]) => ({ key, root, modified }));
}

export type ProjectGroupId = "pinned" | "projects" | "recent" | "today" | "yesterday" | "past-7-days" | "older";
export type ActivityTimeGroupId = Extract<ProjectGroupId, "today" | "yesterday" | "past-7-days" | "older">;

export interface ProjectGroup {
  id: ProjectGroupId;
  label: string;
  projects: RecentProject[];
}

/** A short, user-facing topic derived from the chat rather than its cwd. */
export function getSessionTopic(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  const fallback = session.firstMessage;
  const candidate = (session.name || fallback)
    .replace(/\s+/g, " ")
    .replace(/^[#>\-\s]+/, "")
    .split(/[。！？!?\n]/, 1)[0]
    .trim();
  // A cwd is bookkeeping, not a useful topic label.
  const title = /^(~\/|\/|[A-Za-z]:[\\/])/.test(candidate) ? fallback.trim() : candidate;
  if (!title || /^(~\/|\/|[A-Za-z]:[\\/])/.test(title)) return "未命名对话";
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
}

/** A neutral grouping label for pinned conversations. */
export function getSessionCategory(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  // Keep the accepted shape so sidebar callers do not need to change, but do
  // not infer a personal category from private conversation content.
  void session;
  return "置顶对话";
}

function startOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * Reorganizes one project catalog without changing the projects themselves.
 * Activity buckets are local-calendar based and intentionally ignore pinning.
 */
export function getProjectGroups(
  projects: readonly RecentProject[],
  pinnedProjectKeys: ReadonlySet<string>,
): ProjectGroup[] {
  return [
    { id: "pinned", label: "置顶", projects: projects.filter((project) => pinnedProjectKeys.has(project.key)) },
    { id: "projects", label: "项目", projects: projects.filter((project) => !pinnedProjectKeys.has(project.key)) },
    // Recent is intentionally a second view of the same project catalog.
    { id: "recent", label: "最近", projects: [...projects] },
  ];
}

export function getActivityTimeGroupId(modifiedAt: string, now = new Date()): ActivityTimeGroupId {
  const todayStart = startOfDay(now).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const pastSevenDaysStart = todayStart - 7 * 24 * 60 * 60 * 1000;
  const modified = new Date(modifiedAt).getTime();
  if (!Number.isFinite(modified) || modified < pastSevenDaysStart) return "older";
  if (modified >= todayStart) return "today";
  if (modified >= yesterdayStart) return "yesterday";
  return "past-7-days";
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const counts = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    let entry = counts.get(key);
    if (!entry) {
      entry = { running: 0, unread: 0 };
      counts.set(key, entry);
    }
    if (runningSessionIds.has(session.id)) entry.running++;
    if (unreadSessionIds.has(session.id)) entry.unread++;
  }
  return counts;
}

export function sessionsForProject(
  sessions: readonly SessionInfo[],
  projectKey: string,
): SessionInfo[] {
  return sessions.filter((session) => workspaceKeyOf(session) === projectKey);
}
