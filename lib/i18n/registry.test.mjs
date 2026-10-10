import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
  resolveBrowserLocale,
} = await jiti.import("./registry.ts");
const traditionalChineseVariants = ["zh", "TW"].join("-");
const traditionalChineseScript = ["zh", "Hant"].join("-");
const traditionalChineseHongKong = ["zh", "Hant", "HK"].join("-");
const chineseHongKong = ["zh", "HK"].join("-");
const chineseMacau = ["zh", "MO"].join("-");

test("uses the first supported browser language and falls back to English", () => {
  assert.equal(resolveBrowserLocale(["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans", traditionalChineseVariants]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans-HK", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-SG", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-MY", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale([traditionalChineseVariants, "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale([traditionalChineseVariants.toUpperCase(), "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale([traditionalChineseScript, "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale([traditionalChineseHongKong, "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale([chineseHongKong, "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale([chineseMacau, "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["en-US", "zh-CN"]), "en");
  assert.equal(resolveBrowserLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["fr-FR"]), "en");
  assert.equal(resolveBrowserLocale([]), "en");
});

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en", "zh-CN"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("zh-CN")?.label, "简体中文");
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("built-in locale packages have the complete English key and required placeholder sets", () => {
  const englishMessages = getLocalePlugin("en").messages;
  const englishKeys = Object.keys(englishMessages).sort();
  const placeholders = (message) => [...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
  const optionalPlaceholders = { "files.conflictSummary": ["countSuffix"] };

  for (const locale of getSupportedLocales().filter((id) => id !== "en")) {
    const messages = getLocalePlugin(locale).messages;
    assert.deepEqual(Object.keys(messages).sort(), englishKeys, `${locale} keys must match English`);
    for (const key of englishKeys) {
      const optional = optionalPlaceholders[key] ?? [];
      const required = placeholders(englishMessages[key]).filter((name) => !optional.includes(name));
      const translated = placeholders(messages[key]).filter((name) => !optional.includes(name));
      assert.deepEqual(translated, required, `${locale}.${key} placeholders must match English`);
    }
  }
});
