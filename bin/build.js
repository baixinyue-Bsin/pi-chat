#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Prevent an inherited Turbopack flag from conflicting with the release build.
delete process.env.TURBOPACK;
delete process.env.NEXT_TURBOPACK;

const nextBin = path.join(__dirname, "..", "node_modules", "next", "dist", "bin", "next");
const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
