"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies, type SessionFamily } from "@/lib/session-family";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects, getSessionCategory, getSessionTopic, type ProjectGroupId } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SessionSearch } from "./SessionSearch";

// Standard session rows use this height; metadata-free rows use the compact
// height below. The list-index helper remains for standard virtualized lists.
const SESSION_LIST_ITEM_HEIGHT = 54;
const COMPACT_SESSION_LIST_ITEM_HEIGHT = 36;
type SidebarSectionId = ProjectGroupId | `activity-day-${number}`;

const sidebarMenuItemStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: 34,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "0 9px",
  border: 0,
  borderRadius: 7,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

function showMenuItemHover(event: React.MouseEvent<HTMLElement>) {
  event.currentTarget.style.background = "var(--bg-hover)";
}

function hideMenuItemHover(event: React.MouseEvent<HTMLElement>) {
  event.currentTarget.style.background = "transparent";
}

export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / SESSION_LIST_ITEM_HEIGHT) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / SESSION_LIST_ITEM_HEIGHT) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // Keep a focused row mounted so scrolling cannot discard an inline rename.
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
  onOpenSettings?: () => void;
  onOpenSkills?: () => void;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  canNavigateBack?: boolean;
  canNavigateForward?: boolean;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const PINNED_SESSIONS_STORAGE_KEY = "pi-web:pinned-session-ids";
const PINNED_TOPIC_STORAGE_KEY = "pi-web:pinned-topic-keys";
const USER_PROJECTS_STORAGE_KEY = "pi-web:user-projects";
const PINNED_USER_PROJECTS_STORAGE_KEY = "pi-web:pinned-user-project-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;

interface UserProject {
  id: string;
  name: string;
  sourceFolderPath: string | null;
  createdAt: string;
  updatedAt: string;
}

type ConversationProjectAssignments = Record<string, string>;

function loadUserProjects(): UserProject[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(USER_PROJECTS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): UserProject[] => {
      if (!item || typeof item !== "object") return [];
      const project = item as Partial<UserProject>;
      if (typeof project.id !== "string" || typeof project.name !== "string") return [];
      return [{
        id: project.id,
        name: project.name,
        sourceFolderPath: typeof project.sourceFolderPath === "string" ? project.sourceFolderPath : null,
        createdAt: typeof project.createdAt === "string" ? project.createdAt : "",
        updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : (typeof project.createdAt === "string" ? project.createdAt : ""),
      }];
    });
  } catch {
    return [];
  }
}

const CONVERSATION_PROJECT_ASSIGNMENTS_STORAGE_KEY = "pi-web:conversation-project-assignments";

function loadConversationProjectAssignments(): ConversationProjectAssignments {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONVERSATION_PROJECT_ASSIGNMENTS_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function saveConversationProjectAssignments(assignments: ConversationProjectAssignments): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONVERSATION_PROJECT_ASSIGNMENTS_STORAGE_KEY, JSON.stringify(assignments));
  } catch {
    // Persistence is best-effort, just like pinned sidebar state.
  }
}

function saveUserProjects(projects: readonly UserProject[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Persistence is best-effort, just like pinned sidebar state.
  }
}

function loadPinnedUserProjectIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PINNED_USER_PROJECTS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function savePinnedUserProjectIds(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(PINNED_USER_PROJECTS_STORAGE_KEY);
    else window.localStorage.setItem(PINNED_USER_PROJECTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Persistence is best-effort, just like other sidebar pin state.
  }
}

function folderName(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments.at(-1) || path;
}

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

function loadPinnedSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function savePinnedSessionIds(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(PINNED_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Persistence is best-effort.
  }
}

function loadPinnedTopicKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_TOPIC_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? new Set(parsed.filter((key): key is string => typeof key === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function savePinnedTopicKeys(keys: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (keys.size === 0) window.localStorage.removeItem(PINNED_TOPIC_STORAGE_KEY);
    else window.localStorage.setItem(PINNED_TOPIC_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Persistence is best-effort.
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange, onOpenSettings, onOpenSkills, sidebarOpen = true, onToggleSidebar, onNavigateBack, onNavigateForward, canNavigateBack = false, canNavigateForward = false }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [appMode, setAppMode] = useState<"daily" | "study">("daily");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [activityView, setActivityView] = useState(false);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => loadPinnedSessionIds());
  const [pinnedTopicKeys, setPinnedTopicKeys] = useState<Set<string>>(() => loadPinnedTopicKeys());
  const [userProjects, setUserProjects] = useState<UserProject[]>(() => loadUserProjects());
  const [pinnedUserProjectIds, setPinnedUserProjectIds] = useState<Set<string>>(() => loadPinnedUserProjectIds());
  const [conversationProjectAssignments, setConversationProjectAssignments] = useState<ConversationProjectAssignments>(() => loadConversationProjectAssignments());
  const [collapsedProjectGroups, setCollapsedProjectGroups] = useState<Partial<Record<SidebarSectionId, boolean>>>({});
  const [collapsedUserProjects, setCollapsedUserProjects] = useState<Record<string, boolean>>({});
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectPendingDeletion, setProjectPendingDeletion] = useState<UserProject | null>(null);
  const [hoveredUserProjectId, setHoveredUserProjectId] = useState<string | null>(null);
  const [projectMoreMenuId, setProjectMoreMenuId] = useState<string | null>(null);
  const [projectMoreMenuAnchor, setProjectMoreMenuAnchor] = useState<DOMRect | null>(null);
  const [draggedConversationId, setDraggedConversationId] = useState<string | null>(null);
  const [hoveredTopicKey, setHoveredTopicKey] = useState<string | null>(null);
  const [hoveredSectionId, setHoveredSectionId] = useState<SidebarSectionId | null>(null);
  const [sidebarScrolling, setSidebarScrolling] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [sessionListVersion, setSessionListVersion] = useState<number | null>(null);
  const sessionListVersionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectFolderPickerOpen, setProjectFolderPickerOpen] = useState(false);
  const [pendingProjectConversationId, setPendingProjectConversationId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectSourceFolder, setNewProjectSourceFolder] = useState<string | null>(null);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const projectMoreMenuRef = useRef<HTMLDivElement>(null);
  const sidebarScrollFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const projectRenameInputRef = useRef<HTMLInputElement>(null);

  const handleSidebarScroll = useCallback(() => {
    setSidebarScrolling(true);
    if (sidebarScrollFadeTimerRef.current) clearTimeout(sidebarScrollFadeTimerRef.current);
    sidebarScrollFadeTimerRef.current = setTimeout(() => setSidebarScrolling(false), 700);
  }, []);
  useEffect(() => () => {
    if (sidebarScrollFadeTimerRef.current) clearTimeout(sidebarScrollFadeTimerRef.current);
  }, []);
  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setSessionListVersion(data.sessionListVersion);
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    savePinnedSessionIds(pinnedSessionIds);
  }, [pinnedSessionIds]);

  useEffect(() => {
    savePinnedTopicKeys(pinnedTopicKeys);
  }, [pinnedTopicKeys]);

  useEffect(() => {
    saveUserProjects(userProjects);
  }, [userProjects]);

  useEffect(() => {
    savePinnedUserProjectIds(pinnedUserProjectIds);
  }, [pinnedUserProjectIds]);

  useEffect(() => {
    saveConversationProjectAssignments(conversationProjectAssignments);
  }, [conversationProjectAssignments]);

  useEffect(() => {
    if (!renamingProjectId) return;
    const frame = requestAnimationFrame(() => projectRenameInputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [renamingProjectId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          sessionListVersion: number;
          runningSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        if (data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSessions]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
      if (projectMoreMenuRef.current && !projectMoreMenuRef.current.contains(e.target as Node)) {
        setProjectMoreMenuId(null);
        setProjectMoreMenuAnchor(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!projectMoreMenuId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setProjectMoreMenuId(null);
      setProjectMoreMenuAnchor(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [projectMoreMenuId]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId, blockIndex);
  }, [onSelectSession]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  const closeProjectDialog = useCallback(() => {
    setProjectDialogOpen(false);
    setProjectFolderPickerOpen(false);
    setNewProjectName("");
    setNewProjectSourceFolder(null);
    setPendingProjectConversationId(null);
  }, []);

  // This is the only association mutation used by the menu, drag-and-drop,
  // removal, and create-from-conversation flows. One conversation ID maps to
  // one project ID (or no entry), so it cannot be rendered in two projects.
  const moveConversationToProject = useCallback((conversationId: string, projectId: string | null) => {
    setConversationProjectAssignments((current) => {
      const next = { ...current };
      if (projectId) next[conversationId] = projectId;
      else delete next[conversationId];
      return next;
    });
    setDraggedConversationId(null);
  }, []);

  const createUserProject = useCallback(() => {
    const name = newProjectName.trim();
    if (!name) return;
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setUserProjects((current) => [...current, {
      id,
      name,
      sourceFolderPath: newProjectSourceFolder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);
    if (pendingProjectConversationId) moveConversationToProject(pendingProjectConversationId, id);
    closeProjectDialog();
  }, [closeProjectDialog, moveConversationToProject, newProjectName, newProjectSourceFolder, pendingProjectConversationId]);

  const selectProjectSourceFolder = useCallback((path: string) => {
    setNewProjectSourceFolder(path);
    setNewProjectName((current) => current.trim() ? current : folderName(path));
    setProjectFolderPickerOpen(false);
  }, []);

  const startProjectRename = useCallback((project: UserProject) => {
    setRenamingProjectId(project.id);
    setProjectRenameValue(project.name);
  }, []);

  const commitProjectRename = useCallback(() => {
    const id = renamingProjectId;
    const name = projectRenameValue.trim();
    setRenamingProjectId(null);
    if (!id || !name) return;
    setUserProjects((current) => current.map((project) => project.id === id
      ? { ...project, name, updatedAt: new Date().toISOString() }
      : project));
  }, [projectRenameValue, renamingProjectId]);

  const confirmProjectDeletion = useCallback(() => {
    const project = projectPendingDeletion;
    if (!project) return;
    // A project is only a container. Remove its association entries first so
    // every conversation survives as an unclassified conversation.
    setConversationProjectAssignments((current) => Object.fromEntries(
      Object.entries(current).filter(([, projectId]) => projectId !== project.id),
    ));
    setUserProjects((current) => current.filter((entry) => entry.id !== project.id));
    setPinnedUserProjectIds((current) => {
      const next = new Set(current);
      next.delete(project.id);
      return next;
    });
    setCollapsedUserProjects((current) => {
      const next = { ...current };
      delete next[project.id];
      return next;
    });
    setProjectPendingDeletion(null);
  }, [projectPendingDeletion]);

  const toggleUserProjectPin = useCallback((projectId: string) => {
    setPinnedUserProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const recentProjects = getRecentProjects(allSessions);
  const sessionFamilies = useMemo(() => listSessionFamilies(allSessions), [allSessions]);
  const projectSessionFamilies = useMemo(() => {
    const familiesByProject = new Map<string, SessionFamily[]>();
    for (const family of sessionFamilies) {
      const projectId = conversationProjectAssignments[family.root.id];
      if (!projectId) continue;
      const families = familiesByProject.get(projectId) ?? [];
      families.push(family);
      familiesByProject.set(projectId, families);
    }
    return familiesByProject;
  }, [conversationProjectAssignments, sessionFamilies]);
  const createProjectSession = useCallback((project: UserProject) => {
    // Prefer the project's source folder, then an existing conversation's
    // working directory. Projects created before source folders were supported
    // can still start a chat from the currently selected working directory.
    const cwd = project.sourceFolderPath
      ?? projectSessionFamilies.get(project.id)?.[0]?.root.cwd
      ?? selectedCwd;
    if (!cwd) return;

    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    moveConversationToProject(tempId, project.id);
    setUserProjects((current) => current.map((entry) => entry.id === project.id
      ? { ...entry, updatedAt: new Date().toISOString() }
      : entry));
    setSelectedCwd(cwd);
    onNewSession?.(tempId, cwd);
  }, [moveConversationToProject, onNewSession, projectSessionFamilies, selectedCwd]);
  const pinnedUserProjects = useMemo(
    () => userProjects.filter((project) => pinnedUserProjectIds.has(project.id)),
    [pinnedUserProjectIds, userProjects],
  );
  const unpinnedUserProjects = useMemo(
    () => userProjects.filter((project) => !pinnedUserProjectIds.has(project.id)),
    [pinnedUserProjectIds, userProjects],
  );
  const pinnedSessionFamilies = useMemo(
    () => sessionFamilies.filter((family) => pinnedSessionIds.has(family.root.id)),
    [sessionFamilies, pinnedSessionIds],
  );
  const recentSessionFamilies = useMemo(
    // Recent is deliberately a short shortcut, never a second full history.
    () => sessionFamilies.slice(0, 5),
    [sessionFamilies],
  );
  const topicSessionGroups = useMemo(() => {
    const groups = new Map<string, SessionFamily[]>();
    for (const family of sessionFamilies) {
      const topic = getSessionCategory(family.root);
      const current = groups.get(topic) ?? [];
      current.push(family);
      groups.set(topic, current);
    }
    return [...groups.entries()]
      .map(([topic, families]) => ({ topic, families }))
      .sort((a, b) => b.families[0].latestModified.localeCompare(a.families[0].latestModified));
  }, [sessionFamilies]);
  const pinnedTopicGroups = useMemo(
    () => topicSessionGroups.filter(({ topic }) => pinnedTopicKeys.has(topic)),
    [topicSessionGroups, pinnedTopicKeys],
  );
  const pinnedStandaloneFamilies = useMemo(
    () => pinnedSessionFamilies.filter((family) => !pinnedTopicKeys.has(getSessionCategory(family.root))),
    [pinnedSessionFamilies, pinnedTopicKeys],
  );
  const activitySessionGroups = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekdayLabels = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const dayGroups = Array.from({ length: 7 }, (_, offset) => {
      const start = new Date(today);
      start.setDate(today.getDate() - offset);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      return {
        id: `activity-day-${offset}` as SidebarSectionId,
        label: offset === 0 ? "今天" : offset === 1 ? "昨天" : weekdayLabels[start.getDay()],
        families: sessionFamilies.filter((family) => {
          const modified = new Date(family.latestModified).getTime();
          return Number.isFinite(modified) && modified >= start.getTime() && modified < end.getTime();
        }),
      };
    });
    return [...dayGroups, {
      id: "older" as const,
      label: "更早",
      families: sessionFamilies.filter((family) => {
        const modified = new Date(family.latestModified).getTime();
        return !Number.isFinite(modified) || modified < new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6).getTime();
      }),
    }];
  }, [sessionFamilies]);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((project) => project.root.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectFor(selectedCwd);
  const projectMoreMenuProject = projectMoreMenuId
    ? userProjects.find((project) => project.id === projectMoreMenuId) ?? null
    : null;

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  // Daily chat does not expose Git-root or worktree controls in the sidebar.
  const showWorktreeSwitcher = false;
  const inactiveWorktreeSelector = useMemo<{ label: string; title: string } | null>(() => null, []);

  const toggleSessionPin = useCallback((sessionId: string) => {
    setPinnedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);
  const toggleTopicPin = useCallback((topic: string) => {
    setPinnedTopicKeys((current) => {
      const next = new Set(current);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }, []);

  const renderSessionFamily = (
    family: SessionFamily,
    key: string,
    indent = 0,
    projectLabel?: string,
    options?: { showChatIcon?: boolean; hideMeta?: boolean },
  ) => {
    const familySessions = [family.root, ...family.subagents];
    const displaySession = family.latestModified === family.root.modified
      ? family.root
      : { ...family.root, modified: family.latestModified };
    return (
      <SessionItem
        key={key}
        session={displaySession}
        isSelected={familySessions.some((session) => session.id === selectedSessionId)}
        isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
        isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
        isPinned={pinnedSessionIds.has(family.root.id)}
        onTogglePin={() => toggleSessionPin(family.root.id)}
        projectLabel={projectLabel}
        showChatIcon={options?.showChatIcon ?? false}
        hideMeta={options?.hideMeta ?? true}
        indent={indent}
        onClick={() => handleSelectSessionFromList(family.root)}
        onRenamed={loadSessions}
        onDeleted={(id) => {
          onSessionDeleted?.(id);
          loadSessions();
        }}
        moveProjects={userProjects}
        assignedProjectId={conversationProjectAssignments[family.root.id] ?? null}
        onMoveToProject={moveConversationToProject}
        onCreateProjectForConversation={(conversationId) => {
          setPendingProjectConversationId(conversationId);
          setProjectDialogOpen(true);
        }}
        onDragConversationStart={setDraggedConversationId}
      />
    );
  };

  const renderTopicRow = (topic: string, families: SessionFamily[], key: string, showChildren: boolean) => {
    const pinned = pinnedTopicKeys.has(topic);
    const showPin = hoveredTopicKey === topic;
    return (
      <div key={key}>
        <div
          onMouseEnter={(event) => { setHoveredTopicKey(topic); event.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(event) => { setHoveredTopicKey(null); event.currentTarget.style.background = "transparent"; }}
          style={{ display: "flex", alignItems: "center", gap: 12, height: 36, padding: "0 12px", color: "var(--text)", borderRadius: 12 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" />
          </svg>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 500, lineHeight: "22px" }}>{topic}</span>
          <button
            type="button"
            onClick={() => toggleTopicPin(topic)}
            title={pinned ? "取消置顶项目" : "置顶项目"}
            aria-label={pinned ? "取消置顶项目" : "置顶项目"}
            style={{ display: "grid", placeItems: "center", width: 22, height: 22, padding: 0, border: 0, borderRadius: 5, background: "transparent", color: pinned ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", opacity: showPin ? 1 : 0, visibility: showPin ? "visible" : "hidden", transition: "opacity 0.12s", flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" />
              <path d="M12 15v6" />
            </svg>
          </button>
        </div>
        {showChildren && families.map((family) => renderSessionFamily(family, `${key}-${family.root.id}`, 1, undefined, { showChatIcon: false, hideMeta: true }))}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", padding: "0 8px", boxSizing: "border-box", background: "var(--bg-panel)" }}>
      <style>{`.sidebar-session-scroll { scrollbar-width: none; } .sidebar-session-scroll::-webkit-scrollbar { width: 0; height: 0; } .sidebar-session-scroll.is-scrolling { scrollbar-width: thin; } .sidebar-session-scroll.is-scrolling::-webkit-scrollbar { width: 6px; } .sidebar-session-scroll.is-scrolling::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; } .sidebar-session-scroll.is-scrolling::-webkit-scrollbar-track { background: transparent; }`}</style>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {projectFolderPickerOpen && (
        <DirectoryPicker
          initialPath={newProjectSourceFolder ?? undefined}
          zIndex={1300}
          onCancel={() => setProjectFolderPickerOpen(false)}
          onSelect={selectProjectSourceFolder}
        />
      )}
      {projectDialogOpen && typeof document !== "undefined" && createPortal(
        <div
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeProjectDialog();
          }}
          style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="create-project-title" style={{ width: 460, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px 12px" }}>
              <div id="create-project-title" style={{ color: "var(--text)", fontSize: 16, fontWeight: 700 }}>创建项目</div>
              <button type="button" onClick={closeProjectDialog} aria-label="关闭" title="关闭" style={{ width: 28, height: 28, padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--text-muted)", fontSize: 22, lineHeight: 1, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: "4px 18px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, height: 42, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" /></svg>
                <input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newProjectName.trim()) createUserProject(); }} placeholder="项目名称" aria-label="项目名称" maxLength={120} style={{ minWidth: 0, flex: 1, border: 0, outline: 0, background: "transparent", color: "var(--text)", fontSize: 14 }} />
              </div>
              <div style={{ marginTop: 18, marginBottom: 8, color: "var(--text-muted)", fontSize: 13, fontWeight: 600 }}>源文件夹</div>
              <button type="button" onClick={() => setProjectFolderPickerOpen(true)} style={{ width: "100%", minHeight: 112, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 9, padding: 14, border: "1px dashed var(--border)", borderRadius: 10, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" /><path d="M12 10v6M9 13h6" /></svg>
                <span style={{ fontSize: 13 }}>{newProjectSourceFolder ? newProjectSourceFolder : "添加 Pi Chat 可读取和编辑的文件夹"}</span>
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
              <button type="button" onClick={closeProjectDialog} style={{ height: 34, padding: "0 13px", border: "1px solid var(--border)", borderRadius: 7, background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>取消</button>
              <button type="button" onClick={createUserProject} disabled={!newProjectName.trim()} style={{ height: 34, padding: "0 14px", border: 0, borderRadius: 7, background: "var(--accent)", color: "var(--accent-contrast)", fontSize: 13, fontWeight: 600, cursor: newProjectName.trim() ? "pointer" : "default", opacity: newProjectName.trim() ? 1 : 0.5 }}>创建项目</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {projectPendingDeletion && typeof document !== "undefined" && createPortal(
        <div role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setProjectPendingDeletion(null); }} style={{ position: "fixed", inset: 0, zIndex: 1250, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-project-title" style={{ width: 420, maxWidth: "100%", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)" }}>
            <div style={{ padding: "18px 18px 14px" }}>
              <div id="delete-project-title" style={{ color: "var(--text)", fontSize: 16, fontWeight: 700 }}>删除项目？</div>
              <div style={{ marginTop: 9, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55 }}>项目「{projectPendingDeletion.name}」将被删除。项目下的对话不会被删除，只会从该项目中移出。</div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
              <button type="button" onClick={() => setProjectPendingDeletion(null)} style={{ height: 34, padding: "0 13px", border: "1px solid var(--border)", borderRadius: 7, background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>取消</button>
              <button type="button" onClick={confirmProjectDeletion} style={{ height: 34, padding: "0 14px", border: 0, borderRadius: 7, background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>删除</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {projectMoreMenuProject && projectMoreMenuAnchor && typeof document !== "undefined" && createPortal(
        <div ref={projectMoreMenuRef} role="menu" onMouseDown={(event) => event.stopPropagation()} style={{ position: "fixed", zIndex: 1400, top: projectMoreMenuAnchor.top, left: window.innerWidth - projectMoreMenuAnchor.right >= 178 ? projectMoreMenuAnchor.right + 6 : Math.max(8, projectMoreMenuAnchor.left - 170), width: 164, padding: 4, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.16)", color: "var(--text)" }}>
          <button type="button" role="menuitem" onClick={() => { startProjectRename(projectMoreMenuProject); setProjectMoreMenuId(null); setProjectMoreMenuAnchor(null); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
            重命名项目
          </button>
          <button type="button" role="menuitem" onClick={() => { toggleUserProjectPin(projectMoreMenuProject.id); setProjectMoreMenuId(null); setProjectMoreMenuAnchor(null); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill={pinnedUserProjectIds.has(projectMoreMenuProject.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v6" /></svg>
            {pinnedUserProjectIds.has(projectMoreMenuProject.id) ? "取消置顶项目" : "置顶项目"}
          </button>
          <button type="button" role="menuitem" onClick={() => { setProjectPendingDeletion(projectMoreMenuProject); setProjectMoreMenuId(null); setProjectMoreMenuAnchor(null); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4h6v2" /></svg>
            删除项目
          </button>
        </div>,
        document.body,
      )}
      {/* Header */}
      <div
        style={{
          minHeight: 92,
          padding: "4px 8px 0",
          borderBottom: "none",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        <div aria-label="侧边栏和会话导航" style={{ display: "flex", alignItems: "center", gap: 2, height: 32 }}>
          <ToolbarIconButton onClick={() => onToggleSidebar?.()} title={sidebarOpen ? t("sidebar.hide") : t("sidebar.show")} disabled={!onToggleSidebar} color="var(--text-dim)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
          </ToolbarIconButton>
          <ToolbarIconButton onClick={() => onNavigateBack?.()} title="返回上一个会话" disabled={!canNavigateBack} color="var(--text-dim)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
          </ToolbarIconButton>
          <ToolbarIconButton onClick={() => onNavigateForward?.()} title="前进到下一个会话" disabled={!canNavigateForward} color="var(--text-dim)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
          </ToolbarIconButton>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 44 }}>
          <div ref={modeMenuRef} style={{ position: "relative" }}>
            <button type="button" onClick={() => setModeMenuOpen((open) => !open)} aria-expanded={modeMenuOpen} aria-haspopup="menu" style={{ display: "flex", alignItems: "center", gap: 6, height: 44, padding: 0, border: 0, borderRadius: 10, background: modeMenuOpen ? "var(--bg-hover)" : "transparent", color: "var(--text)", cursor: "pointer", fontSize: 22, fontWeight: 700, lineHeight: "24px", letterSpacing: "-0.02em" }}>
              {appMode === "daily" ? "Pi Chat" : "Pi Study"}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {modeMenuOpen && <div role="menu" style={{ position: "absolute", top: 48, left: 0, zIndex: 110, width: 252, padding: 6, borderRadius: 16, background: "var(--bg)", boxShadow: "0 10px 30px rgba(0,0,0,0.14)" }}>
              {(["daily", "study"] as const).map((mode) => {
                const active = appMode === mode;
                const title = mode === "daily" ? "Pi Chat" : "Pi Study";
                const description = mode === "daily" ? "创建、学习和探索" : "课程、论文和知识整理";
                return <button key={mode} type="button" role="menuitemradio" aria-checked={active} onClick={() => { setAppMode(mode); setModeMenuOpen(false); }} style={{ display: "flex", alignItems: "flex-start", gap: 10, width: "100%", padding: "10px 11px", border: 0, borderRadius: 11, background: active ? "var(--bg-hover)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ flex: 1 }}><span style={{ display: "block", fontSize: 14, fontWeight: 650 }}>{title}</span><span style={{ display: "block", marginTop: 3, color: "var(--text-dim)", fontSize: 12, lineHeight: 1.35 }}>{description}</span></span>
                  {active && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="5 12 10 17 20 7" /></svg>}
                </button>;
              })}
            </div>}
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button type="button" onClick={() => setSessionSearchOpen((open) => !open)} title={t("sidebar.toggleSessionSearch")} aria-label={t("sidebar.toggleSessionSearch")} aria-expanded={sessionSearchOpen} aria-controls="session-search-input" style={{ display: "grid", placeItems: "center", width: 36, height: 36, border: 0, borderRadius: 8, background: sessionSearchOpen ? "var(--bg-hover)" : "transparent", color: "var(--text-muted)", cursor: "pointer" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg></button>
            <button type="button" onClick={() => setActivityView((active) => !active)} aria-pressed={activityView} aria-label="按时间查看" title={activityView ? "按时间查看" : "按任务查看"} style={{ display: "grid", placeItems: "center", width: 36, height: 36, border: 0, borderRadius: 8, background: activityView ? "var(--bg-hover)" : "transparent", color: "var(--text-muted)", cursor: "pointer" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg></button>
          </div>
        </div>

        <label style={{ display: "none", alignItems: "center", gap: 7, height: 38, padding: "0 11px", borderRadius: 13, background: "var(--bg-hover)", color: "var(--text-dim)" }}><span aria-hidden="true">⌕</span><input value={sessionSearchQuery} onFocus={() => setSessionSearchOpen(true)} onChange={(event) => { setSessionSearchQuery(event.target.value); setSessionSearchOpen(true); }} placeholder="搜索对话" aria-label="搜索对话" style={{ width: "100%", border: 0, outline: 0, background: "transparent", color: "var(--text)", font: "inherit", fontSize: 13 }} /></label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 0 0" }}>
          <button type="button" onClick={handleNewSession} disabled={!selectedCwd} title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")} style={{ display: "flex", alignItems: "center", gap: 10, height: 40, padding: "0 10px", border: 0, borderRadius: 10, background: "transparent", color: selectedCwd ? "var(--text)" : "var(--text-dim)", cursor: selectedCwd ? "pointer" : "not-allowed", fontSize: 14, fontWeight: 500, lineHeight: "20px", textAlign: "left" }} onMouseEnter={(event) => { if (selectedCwd) event.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" /></svg>新聊天</button>
        </div>

        {/* CWD picker stays available internally but is not part of the daily UI. */}
        <div ref={dropdownRef} style={{ display: "none", position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 {initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject")}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  marginLeft: 6,
                  background: "var(--accent)",
                }}
              />
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
                    autoFocus
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => (
                  <button
                    key={project.key}
                    onClick={() => {
                      setSelectedCwd(project.root);
                      setProjectFilter("");
                      setCustomPathOpen(false);
                      setCustomPathError(null);
                      setDropdownOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: project.key === selectedProject?.key ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={project.root}
                  >
                    {project.key === selectedProject?.key && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {project.key !== selectedProject?.key && <span style={{ width: 10, flexShrink: 0 }} />}
                    <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                    {showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                ))}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
        </div>

        {sessionSearchOpen && (
          <input
            id="session-search-input"
            type="search"
            autoFocus
            value={sessionSearchQuery}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder={t("sidebar.searchSessions")}
            onChange={(event) => setSessionSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSessionSearchQuery("");
              }
            }}
            className="mt-[6px] block h-[29px] w-full min-w-0 rounded-[7px] border border-border bg-bg px-[10px] text-xs text-text focus:outline-2 focus:outline-accent"
            style={{ font: "inherit", fontSize: 13, lineHeight: 1.4 }}
          />
        )}

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {!sessionSearchOpen && showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                 title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWorktree?.isMain && (
                   <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "var(--accent-contrast)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {!sessionSearchOpen && inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>

      {/* Project list — the clock only changes how this one catalog is grouped. */}
      <SessionSearch open={sessionSearchOpen} query={sessionSearchQuery} refreshKey={sessionListVersion} selectedSessionId={selectedSessionId} onSelectSession={handleSelectSessionFromList}>
      <div
        className={`sidebar-session-scroll${sidebarScrolling ? " is-scrolling" : ""}`}
        onScroll={handleSidebarScroll}
        style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0 0 20px", minHeight: 80 }}
      >
        <div style={{ padding: "0 0 4px" }}>
          <button type="button" onClick={() => onOpenSkills?.()} title="技能" style={{ display: "flex", alignItems: "center", gap: 10, height: 40, padding: "0 10px", border: 0, borderRadius: 10, background: "transparent", color: "var(--text)", cursor: "pointer", fontSize: 14, fontWeight: 500, lineHeight: "20px", textAlign: "left" }} onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3-1.5 5.5L5 10l5.5 1.5L12 17l1.5-5.5L19 10l-5.5-1.5L12 3Z" /><path d="m19 15-.7 2.3L16 18l2.3.7L19 21l.7-2.3L22 18l-2.3-.7L19 15Z" /></svg>技能</button>
        </div>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && !activityView && sessionFamilies.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {!loading && !error && activityView && activitySessionGroups.map((group) => {
          const collapsed = Boolean(collapsedProjectGroups[group.id]);
          return (
            <section key={group.id} style={{ padding: "20px 0 0" }}>
              <button
                type="button"
                onClick={() => setCollapsedProjectGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                aria-expanded={!collapsed}
                onMouseEnter={() => setHoveredSectionId(group.id)}
                onMouseLeave={() => setHoveredSectionId(null)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "calc(100% - 24px)", height: 20,
                  margin: "0 12px 8px", padding: 0, border: 0, background: "transparent", color: "#9b9b9b",
                  cursor: "pointer", fontSize: 14, fontWeight: 600, lineHeight: "20px", textAlign: "left",
                }}
              >
                <span>{group.label}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s, opacity 0.12s", flexShrink: 0, opacity: collapsed || hoveredSectionId === group.id ? 1 : 0 }} aria-hidden="true">
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>
              {!collapsed && group.families.map((family) => renderSessionFamily(family, `${group.id}-${family.root.id}`, 0, getSessionTopic(family.root)))}
              {!collapsed && group.families.length === 0 && <div style={{ height: 36, display: "flex", alignItems: "center", padding: "0 12px", color: "var(--text)", fontSize: 15, fontWeight: 500, lineHeight: "22px" }}>暂无活动</div>}
            </section>
          );
        })}
        {!loading && !error && !activityView && [
          { id: "pinned" as const, label: "置顶", families: pinnedStandaloneFamilies, topics: pinnedTopicGroups },
          { id: "projects" as const, label: "项目", projects: unpinnedUserProjects },
          { id: "recent" as const, label: "最近对话", families: recentSessionFamilies },
        ].map((group) => {
          const collapsed = Boolean(collapsedProjectGroups[group.id]);
          const isProjectList = group.id === "pinned" || group.id === "projects";
          const sectionProjects = group.id === "pinned"
            ? pinnedUserProjects
            : ("projects" in group ? group.projects ?? [] : []);
          const showProjectActions = group.id === "projects" && hoveredSectionId === group.id;
          return (
            <section key={group.id} style={{ padding: group.id === "pinned" ? "8px 0 0" : "20px 0 0" }}>
              <div onMouseEnter={() => setHoveredSectionId(group.id)} onMouseLeave={() => setHoveredSectionId(null)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "calc(100% - 24px)", height: 20, margin: "0 12px 8px", color: "#9b9b9b" }}>
                <button
                  type="button"
                  onClick={() => setCollapsedProjectGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                  aria-expanded={!collapsed}
                  style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, height: 20, padding: 0, border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14, fontWeight: 600, lineHeight: "20px", textAlign: "left" }}
                >
                  <span>{group.label}</span>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s, opacity 0.12s", flexShrink: 0, opacity: collapsed || hoveredSectionId === group.id ? 1 : 0 }} aria-hidden="true">
                    <polyline points="2 3.5 5 6.5 8 3.5" />
                  </svg>
                </button>
                {group.id === "projects" && <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: showProjectActions ? 1 : 0, transition: "opacity 0.12s" }}>
                  <button type="button" title="创建项目" aria-label="创建项目" onClick={() => setProjectDialogOpen(true)} style={{ width: 20, height: 20, padding: 0, border: 0, borderRadius: 5, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 20, fontWeight: 400, lineHeight: "18px" }}>+</button>
                </div>}
              </div>
              {!collapsed && group.id === "pinned" && (group.families ?? []).map((family) => renderSessionFamily(family, `${group.id}-${family.root.id}`, 0, undefined, { showChatIcon: true, hideMeta: true }))}
              {!collapsed && group.id === "pinned" && (group.topics ?? []).map(({ topic, families }) => renderTopicRow(topic, families, `${group.id}-topic-${topic}`, true))}
              {!collapsed && group.id === "recent" && (group.families ?? []).map((family) => renderSessionFamily(family, `${group.id}-${family.root.id}`, 0, undefined, { showChatIcon: false, hideMeta: true }))}
              {!collapsed && group.id === "recent" && (group.families ?? []).length === 0 && <div style={{ padding: "0 12px", color: "var(--text-dim)", fontSize: 12 }}>暂无最近对话</div>}
              {!collapsed && isProjectList && sectionProjects.map((project) => (
                <div key={project.id} style={{ position: "relative" }}>
                  <div
                    title={project.sourceFolderPath ?? project.name}
                    onClick={() => setCollapsedUserProjects((current) => ({ ...current, [project.id]: !current[project.id] }))}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const conversationId = event.dataTransfer.getData("text/pi-web-session-id") || draggedConversationId;
                      if (conversationId) moveConversationToProject(conversationId, project.id);
                    }}
                    onMouseEnter={(event) => { setHoveredUserProjectId(project.id); event.currentTarget.style.background = draggedConversationId ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "var(--bg-hover)"; }}
                    onMouseLeave={(event) => { setHoveredUserProjectId(null); event.currentTarget.style.background = "transparent"; }}
                    style={{ width: "100%", height: 36, display: "flex", alignItems: "center", gap: 12, padding: "0 12px", borderRadius: 12, background: draggedConversationId ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 15, fontWeight: 500 }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" /></svg>
                    {renamingProjectId === project.id ? (
                      <input ref={projectRenameInputRef} value={projectRenameValue} onClick={(event) => event.stopPropagation()} onChange={(event) => setProjectRenameValue(event.target.value)} onBlur={commitProjectRename} onKeyDown={(event) => { if (event.key === "Enter") commitProjectRename(); if (event.key === "Escape") setRenamingProjectId(null); }} aria-label="项目名称" style={{ minWidth: 0, flex: 1, height: 28, padding: "0 7px", border: "1px solid var(--accent)", borderRadius: 5, outline: 0, background: "var(--bg)", color: "var(--text)", fontSize: 14 }} />
                    ) : <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>}
                    {renamingProjectId !== project.id && (() => {
                      const isPinned = pinnedUserProjectIds.has(project.id);
                      const projectSessions = projectSessionFamilies.get(project.id) ?? [];
                      const isSelected = projectSessions.some((family) => [family.root, ...family.subagents].some((session) => session.id === selectedSessionId));
                      const showOtherActions = hoveredUserProjectId === project.id || isSelected;
                      const sessionCwd = project.sourceFolderPath ?? projectSessions[0]?.root.cwd ?? selectedCwd;
                      return <div style={{ width: 92, display: "flex", alignItems: "center", gap: 4, marginLeft: "auto", flexShrink: 0 }}>
                      <button type="button" onClick={(event) => { event.stopPropagation(); createProjectSession(project); }} disabled={!sessionCwd} title={sessionCwd ? "在此项目中新建聊天" : "请先为项目添加源文件夹"} aria-label="在此项目中新建聊天" style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: sessionCwd ? "pointer" : "not-allowed", opacity: showOtherActions ? 1 : 0, visibility: showOtherActions ? "visible" : "hidden", transition: "opacity 0.12s" }} onMouseEnter={(event) => { if (sessionCwd) event.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                      </button>
                      <button type="button" onClick={(event) => { event.stopPropagation(); toggleUserProjectPin(project.id); }} title={isPinned ? "取消置顶" : "置顶"} aria-label={isPinned ? "取消置顶项目" : "置顶项目"} style={{ width: 28, height: 28, display: "grid", placeItems: "center", padding: 0, border: 0, borderRadius: 6, background: "transparent", color: isPinned ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", opacity: showOtherActions ? 1 : 0, visibility: showOtherActions ? "visible" : "hidden", transition: "opacity 0.12s" }} onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v6" /></svg>
                      </button>
                      <div style={{ opacity: showOtherActions ? 1 : 0, visibility: showOtherActions ? "visible" : "hidden", transition: "opacity 0.12s" }}>
                        <button type="button" onClick={(event) => { event.stopPropagation(); setProjectMoreMenuAnchor(event.currentTarget.getBoundingClientRect()); setProjectMoreMenuId((id) => id === project.id ? null : project.id); }} title="项目更多操作" aria-label="项目更多操作" aria-haspopup="menu" aria-expanded={projectMoreMenuId === project.id} style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }} onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                        </button>
                      </div>
                    </div>;
                    })()}
                  </div>
                  {!collapsedUserProjects[project.id] && (projectSessionFamilies.get(project.id) ?? []).map((family) => renderSessionFamily(family, `project-${project.id}-${family.root.id}`, 1, undefined, { showChatIcon: false, hideMeta: true }))}
                </div>
              ))}
              {!collapsed && group.id === "projects" && unpinnedUserProjects.length === 0 && pinnedUserProjects.length === 0 && (
                <div style={{ height: 36, display: "flex", alignItems: "center", padding: "0 12px", color: "var(--text)", fontSize: 15, fontWeight: 400, lineHeight: "22px" }}>暂无项目</div>
              )}
            </section>
          );
        })}
      </div>
      </SessionSearch>

      {/* File management is intentionally absent from the daily sidebar. */}
      {false && (selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("files.explorer")}
            </button>
            {onOpenTerminal && (
              <ToolbarIconButton
                onClick={() => onOpenTerminal?.(selectedCwd ?? selectedCwdProp!)}
                title={t("terminal.open")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => {
                  setFileSearchOpen((open) => !open);
                }}
                title={t("sidebar.searchFiles")}
                ariaPressed={fileSearchOpen}
                color={fileSearchOpen ? "var(--accent)" : "var(--text-dim)"}
                background={fileSearchOpen ? "var(--bg-selected)" : "none"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </ToolbarIconButton>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          )}
        </div>
      )}
      <div style={{ position: "relative", flexShrink: 0, padding: "8px 10px 10px" }}>
        {userMenuOpen && <div style={{ position: "absolute", right: 10, bottom: 58, left: 10, zIndex: 20, padding: 7, border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg-panel)", boxShadow: "0 14px 34px rgba(0,0,0,.16)" }}>
          <button type="button" onClick={() => { setUserMenuOpen(false); onOpenSettings?.(); }} style={{ display: "block", width: "100%", height: 34, padding: "0 9px", border: 0, borderRadius: 9, background: "transparent", color: "var(--text)", cursor: "pointer", font: "inherit", fontSize: 13, textAlign: "left" }}>{t("common.settings")}</button>
          <button type="button" onClick={() => router.push("/login")} style={{ display: "block", width: "100%", height: 34, padding: "0 9px", border: 0, borderRadius: 9, background: "transparent", color: "var(--text)", cursor: "pointer", font: "inherit", fontSize: 13, textAlign: "left" }}>{t("auth.logOut")}</button>
        </div>}
        <button type="button" onClick={() => setUserMenuOpen((open) => !open)} aria-expanded={userMenuOpen} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", height: 42, padding: "0 8px", border: 0, borderRadius: 11, background: "transparent", color: "var(--text)", cursor: "pointer", font: "inherit", fontSize: 14, textAlign: "left" }} onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}>
          <span style={{ display: "grid", width: 28, height: 28, placeItems: "center", border: "1px solid var(--border)", borderRadius: "50%", background: "var(--bg-selected)", color: "var(--text)", fontSize: 12, fontWeight: 600 }}>P</span>{t("sidebar.account")}
        </button>
      </div>
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  isPinned = false,
  onTogglePin,
  projectLabel,
  showChatIcon = false,
  hideMeta = false,
  compact = hideMeta,
  onClick,
  onRenamed,
  onDeleted,
  moveProjects = [],
  assignedProjectId = null,
  onMoveToProject,
  onCreateProjectForConversation,
  onDragConversationStart,
  depth = 0,
  indent = depth,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  projectLabel?: string;
  showChatIcon?: boolean;
  hideMeta?: boolean;
  compact?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  moveProjects?: UserProject[];
  assignedProjectId?: string | null;
  onMoveToProject?: (conversationId: string, projectId: string | null) => void;
  onCreateProjectForConversation?: (conversationId: string) => void;
  onDragConversationStart?: (conversationId: string | null) => void;
  depth?: number;
  /** Visual nesting can be used without marking a row as a subagent. */
  indent?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMenuAnchor, setMoreMenuAnchor] = useState<DOMRect | null>(null);
  const [projectSubmenuOpen, setProjectSubmenuOpen] = useState(false);
  const [projectSubmenuAnchor, setProjectSubmenuAnchor] = useState<DOMRect | null>(null);
  const [projectSubmenuHeight, setProjectSubmenuHeight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const measureProjectSubmenu = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const { height } = node.getBoundingClientRect();
    setProjectSubmenuHeight((current) => current === height ? current : height);
  }, []);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const rawTitle = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);
  const title = /^(~\/|\/|[A-Za-z]:[\\/])/.test(rawTitle)
    ? getSessionTopic({ ...session, firstMessage: displayFirstMessage })
    : rawTitle;
  const viewportPadding = 8;
  const moreMenuHeight = onMoveToProject ? 180 : onTogglePin ? 120 : 86;
  const moreMenuTop = moreMenuAnchor
    ? Math.max(viewportPadding, Math.min(moreMenuAnchor.top, window.innerHeight - moreMenuHeight - viewportPadding))
    : viewportPadding;

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreMenuOpen(false);
    setProjectSubmenuOpen(false);
    setProjectSubmenuAnchor(null);
    setConfirmDelete(true);
  }, []);

  const openProjectSubmenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    setProjectSubmenuAnchor(event.currentTarget.getBoundingClientRect());
    setProjectSubmenuHeight(0);
    setProjectSubmenuOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const close = () => { setMoreMenuOpen(false); setProjectSubmenuOpen(false); setProjectSubmenuAnchor(null); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuOpen]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      draggable={!session.transient && Boolean(onDragConversationStart) && !renaming}
      onDragStart={(event) => {
        if (session.transient || !onDragConversationStart) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/pi-web-session-id", session.id);
        onDragConversationStart(session.id);
      }}
      onDragEnd={() => onDragConversationStart?.(null)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: compact ? COMPACT_SESSION_LIST_ITEM_HEIGHT : SESSION_LIST_ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        margin: 0,
        paddingLeft: compact ? 12 + indent * 26 : indent > 0 ? indent * 12 + 14 : 12,
        paddingRight: compact ? 12 : 12,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: "none",
        borderRadius: compact ? 12 : 12,
        transition: "background 0.1s, border-radius 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 12,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Subagent indicator for child sessions */}
          {!compact && depth > 0 && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          )}
          {showChatIcon && depth === 0 && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.8 8.8 0 0 1-3.6-.8L4 20l1.3-3.4A7.3 7.3 0 0 1 4.5 13 7.5 7.5 0 0 1 12 5.5a7.5 7.5 0 0 1 8 6Z" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                minWidth: 0,
                fontSize: 15,
                fontWeight: 400,
                lineHeight: "22px",
                color: "var(--text)",
              }}
              title={title}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
            {!hideMeta && <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {projectLabel ? (
                <>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectLabel}</span>
                  <span title={session.modified}>{formatRelativeTime(session.modified, locale)}</span>
                </>
              ) : isRunning ? (
                <RunningSessionIndicator />
              ) : isUnread ? (
                <UnreadSessionIndicator />
              ) : (
                <span title={session.modified}>{formatRelativeTime(session.modified, locale)}</span>
              )}
              <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
              {session.isWorktree && session.branch && (
                <span
                  title={`Worktree: ${session.cwd}`}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.branch}</span>
                </span>
              )}
            </div>}
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {!session.transient && (
            <div style={{ width: 60, display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {onTogglePin && <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onTogglePin(); }}
              title={isPinned ? "取消置顶" : "置顶"}
              aria-label={isPinned ? "取消置顶对话" : "置顶对话"}
              style={{
                display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, flexShrink: 0,
                border: "none", borderRadius: 5, background: "transparent", color: isPinned ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer", opacity: hovered ? 1 : 0, visibility: hovered ? "visible" : "hidden", transition: "opacity 0.12s",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" />
                <path d="M12 15v6" />
              </svg>
            </button>}
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setMoreMenuAnchor(event.currentTarget.getBoundingClientRect()); setMoreMenuOpen((open) => !open); setProjectSubmenuOpen(false); setProjectSubmenuAnchor(null); }}
              title="更多操作"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              style={{ display: "grid", placeItems: "center", width: 28, height: 28, padding: 0, flexShrink: 0, border: "none", borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer", opacity: hovered ? 1 : 0, visibility: hovered ? "visible" : "hidden", transition: "opacity 0.12s" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
            </button>
            </div>
          )}
        </>
      )}
      {moreMenuOpen && moreMenuAnchor && typeof document !== "undefined" && createPortal(
        <div role="menu" onMouseDown={(event) => event.stopPropagation()} style={{ position: "fixed", zIndex: 1400, top: moreMenuTop, left: window.innerWidth - moreMenuAnchor.right >= 186 ? moreMenuAnchor.right + 6 : Math.max(8, moreMenuAnchor.left - 178), width: 172, maxHeight: "calc(100vh - 16px)", overflowY: "auto", padding: 4, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.16)", color: "var(--text)" }}>
          <button type="button" role="menuitem" onClick={(event) => { startRename(event); setMoreMenuOpen(false); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
            重命名
          </button>
          {onTogglePin && <button type="button" role="menuitem" onClick={() => { onTogglePin(); setMoreMenuOpen(false); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3h8l-1 7 3 3v2H6v-2l3-3-1-7Z" /><path d="M12 15v6" /></svg>
            {isPinned ? "取消置顶" : "置顶"}
          </button>}
          <button type="button" role="menuitem" onClick={handleDeleteClick} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4h6v2" /></svg>
            删除
          </button>
          {onMoveToProject && <>
            <div role="separator" style={{ height: 1, margin: "4px 3px", background: "var(--border)" }} />
            <div role="menuitem" onMouseEnter={openProjectSubmenu} onClick={openProjectSubmenu} style={{ ...sidebarMenuItemStyle, justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 9 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" /></svg>项目</span><span aria-hidden="true">›</span>
            </div>
          </>}
        </div>,
        document.body,
      )}
      {projectSubmenuOpen && projectSubmenuAnchor && typeof document !== "undefined" && createPortal(
        <div ref={measureProjectSubmenu} role="menu" onMouseDown={(event) => event.stopPropagation()} style={{ position: "fixed", zIndex: 1401, top: Math.max(8, Math.min(projectSubmenuAnchor.top, window.innerHeight - projectSubmenuHeight - 8)), left: window.innerWidth - projectSubmenuAnchor.right >= 200 ? projectSubmenuAnchor.right + 6 : Math.max(8, projectSubmenuAnchor.left - 194), width: 188, maxHeight: "calc(100vh - 16px)", overflowY: "auto", padding: 4, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.16)", color: "var(--text)" }}>
          <div style={{ padding: "5px 9px", color: "var(--text-dim)", fontSize: 11, fontWeight: 600 }}>移动到项目</div>
          {moveProjects.map((project) => <button key={project.id} type="button" role="menuitem" onClick={() => { onMoveToProject?.(session.id, project.id); setMoreMenuOpen(false); setProjectSubmenuOpen(false); setProjectSubmenuAnchor(null); }} style={{ ...sidebarMenuItemStyle, background: project.id === assignedProjectId ? "var(--bg-selected)" : "transparent" }} onMouseEnter={showMenuItemHover} onMouseLeave={(event) => { event.currentTarget.style.background = project.id === assignedProjectId ? "var(--bg-selected)" : "transparent"; }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l1.7 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" /></svg><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>{project.id === assignedProjectId && <span aria-hidden="true">✓</span>}</button>)}
          {onCreateProjectForConversation && <button type="button" role="menuitem" onClick={() => { onCreateProjectForConversation(session.id); setMoreMenuOpen(false); setProjectSubmenuOpen(false); setProjectSubmenuAnchor(null); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}><span style={{ fontSize: 18, lineHeight: 1 }}>+</span>新建项目</button>}
          {assignedProjectId && <><div role="separator" style={{ height: 1, margin: "4px 3px", background: "var(--border)" }} /><button type="button" role="menuitem" onClick={() => { onMoveToProject?.(session.id, null); setMoreMenuOpen(false); setProjectSubmenuOpen(false); setProjectSubmenuAnchor(null); }} style={sidebarMenuItemStyle} onMouseEnter={showMenuItemHover} onMouseLeave={hideMenuItemHover}>从项目中移出</button></>}
        </div>,
        document.body,
      )}
    </div>
  );
}
