"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");

const config = { ...(packageJson.build ?? {}) };
config.files = [...(config.files ?? []), "!desktop/node-runtime/**/*"];
const bundledNodeRoot = path.join(__dirname, "node-runtime");
const bundledNode = path.join(bundledNodeRoot, "bin", process.platform === "win32" ? "node.exe" : "node");

if (!fs.existsSync(bundledNode)) {
  throw new Error("desktop/node-runtime/bin/node 不存在，请先运行 npm run desktop:download-node");
}
config.extraResources = [
  ...(config.extraResources ?? []),
  { from: "desktop/node-runtime", to: "node", filter: ["**/*"] },
];

module.exports = config;
