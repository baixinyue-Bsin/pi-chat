import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const {
  getProjectActivity,
  getActivityTimeGroupId,
  getProjectGroups,
  getRecentProjects,
  getSessionTopic,
  sessionsForProject,
} = await jiti.import("./project-groups.ts");

function session(id, projectRoot, modified) {
  return {
    id,
    path: `${id}.jsonl`,
    cwd: projectRoot,
    projectRoot,
    projectKey: projectIdentityKey(projectRoot, "win32"),
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
  };
}

test("Windows path variants form one recent project using the newest display path", () => {
  const older = session("older", "C:\\Users\\Alex\\Project\\Study\\ELM", "2026-08-12T00:00:00.000Z");
  const newer = session("newer", "c:/users/ALEX/project/study/elm", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(getRecentProjects([older, newer]), [{
    key: older.projectKey,
    root: newer.projectRoot,
    modified: newer.modified,
  }]);
});

test("project filtering includes every session with the stable identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");
  const other = session("other", "D:\\Elsewhere", "2026-08-13T01:00:00.000Z");

  assert.deepEqual(
    sessionsForProject([first, second, other], first.projectKey).map((item) => item.id),
    ["first", "second"],
  );
});

test("running and unread counts aggregate under the stable project identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");
  const activity = getProjectActivity([first, second], new Set(["first", "second"]), new Set(["second"]));

  assert.deepEqual(activity.get(first.projectKey), { running: 2, unread: 1 });
  assert.equal(activity.size, 1);
});

const projects = [
  { key: "today", root: "/today", modified: "2026-09-13T03:00:00.000Z" },
  { key: "yesterday", root: "/yesterday", modified: "2026-09-12T03:00:00.000Z" },
  { key: "week", root: "/week", modified: "2026-09-08T03:00:00.000Z" },
  { key: "older", root: "/older", modified: "2026-09-05T03:00:00.000Z" },
];

test("project view keeps recent projects as a second grouping of the same catalog", () => {
  const groups = getProjectGroups(projects, new Set(["today"]));
  assert.deepEqual(groups.map((group) => [group.id, group.projects.map((project) => project.key)]), [
    ["pinned", ["today"]],
    ["projects", ["yesterday", "week", "older"]],
    ["recent", ["today", "yesterday", "week", "older"]],
  ]);
});

test("activity time buckets depend only on the last activity time", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");
  assert.deepEqual(projects.map((project) => getActivityTimeGroupId(project.modified, now)), [
    "today", "yesterday", "past-7-days", "older",
  ]);
});

test("topic labels come from chat content and never expose cwd paths", () => {
  assert.equal(getSessionTopic({ id: "one", firstMessage: "整理产品发布清单。包含上线步骤", name: undefined }), "整理产品发布清单");
  assert.equal(getSessionTopic({ id: "two", firstMessage: "/Users/betty/pi-cwd-20260908", name: undefined }), "未命名对话");
});
