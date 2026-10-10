import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

test("health endpoint reports stable readiness metadata without Pi state", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const testAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-health-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
  delete process.env.PI_WEB_PASSWORD;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
    await rm(testAgentDir, { recursive: true, force: true });
  });

  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["app", "ok", "piVersion", "version"]);
  assert.equal(body.ok, true);
  assert.equal(body.app, "pi-chat");
  assert.equal(body.version, "1.1.0");
  assert.equal(body.piVersion, "0.85.1");

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /api[_-]?key/i);
  assert.doesNotMatch(serialized, /(?:^|[\\/])(?:Users|home)[\\/]/i);
  assert.doesNotMatch(serialized, /(?:session|\.pi\/agent)/i);
});
