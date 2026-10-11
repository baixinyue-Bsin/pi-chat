import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const componentSource = await readFile(new URL("./OnboardingDialog.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

function onboardingStyles() {
  return cssSource.slice(cssSource.indexOf(".onboarding-backdrop"), cssSource.indexOf("@media (max-width: 520px)", cssSource.indexOf(".onboarding-backdrop")));
}

test("keeps onboarding actions wired and uses the existing monochrome Pi Chat mark", async () => {
  assert.match(shellSource, /onboardingVisible && \(\s*<OnboardingDialog/);
  assert.match(shellSource, /onConfigure=\{\(\) => \{ void finishOnboarding\(true\); \}\}/);
  assert.match(shellSource, /onLater=\{\(\) => \{ void finishOnboarding\(false\); \}\}/);
  assert.match(componentSource, /onClick=\{onConfigure\}/);
  assert.match(componentSource, /onClick=\{onLater\}/);
  assert.match(componentSource, /src="\/pi-chat-mark\.png"/);
  await access(new URL("../public/pi-chat-mark.png", import.meta.url));
});

test("scopes neutral colors to the onboarding dialog", () => {
  const styles = onboardingStyles();
  assert.match(styles, /background: #ffffff/);
  assert.match(styles, /background: #111111/);
  assert.match(styles, /color: #ffffff/);
  assert.doesNotMatch(styles, /var\(--accent/);
  assert.doesNotMatch(styles, /#(?:245bce|1d4ed8)/i);
});

test("keeps onboarding copy in both supported locales", () => {
  assert.match(enSource, /"onboarding\.description": "Use your AI coding agent locally\. Configure a provider and model to get started\."/);
  assert.match(enSource, /"onboarding\.configure": "Configure now"/);
  assert.match(enSource, /"onboarding\.later": "Later"/);
  assert.match(zhSource, /"onboarding\.description": "在本地使用你的 AI 编程助手。配置一个 Provider 和模型后即可开始使用。"/);
  assert.match(zhSource, /"onboarding\.configure": "开始配置"/);
  assert.match(zhSource, /"onboarding\.later": "稍后设置"/);
});
