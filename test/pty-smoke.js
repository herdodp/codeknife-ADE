// SPDX-License-Identifier: GPL-3.0-or-later
const pty = require("node-pty");
const shell = process.env.ComSpec || "cmd.exe";
const terminal = pty.spawn(shell, [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  useConpty: false,
});
let output = "";
let finished = false;
let timeout;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  terminal.kill();
  setTimeout(() => process.exit(code), 100);
}
terminal.onData((data) => {
  output += data;
  if (output.includes("CODEKNIFE_PTY_OK")) {
    console.log("PTY shell round trip succeeded.");
    finish(0);
  }
});
terminal.onExit(({ exitCode }) => {
  if (!finished) {
    console.error(output || "PTY shell exited without producing output.");
    finish(exitCode || 1);
  }
});
terminal.write("echo CODEKNIFE_PTY_OK\r");
timeout = setTimeout(() => {
  console.error(output || "PTY shell did not respond.");
  finish(1);
}, 10000);
