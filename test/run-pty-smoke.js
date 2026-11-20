// SPDX-License-Identifier: GPL-3.0-or-later
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const electron = require("electron");

const result = spawnSync(electron, [path.join(__dirname, "pty-smoke.js")], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
