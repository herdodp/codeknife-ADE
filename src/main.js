// SPDX-License-Identifier: GPL-3.0-or-later
// Codeknife - main process.
// Layout: left = workspace tree, center = Monaco editor, right = Snapgent AI assistant (BrowserView).
// The bridge is built in (stdio MCP to vscode_mcp.exe): no port, no WebSocket.
const { app, BrowserWindow, BrowserView, ipcMain, dialog, session, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");
const { BridgeCore, VERSION } = require("./bridge-core");
const { LanguageServiceManager } = require("./language-service");

const START_URL = "https://claude.ai/";
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build-tmp", "__pycache__", ".venv"]);
const MAX_OPEN_BYTES = 5 * 1024 * 1024;

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let win = null;
let view = null; // AI assistant
let aiBounds = { x: 0, y: 0, width: 0, height: 0 };

// ---------------------------------------------------------------- data dir
const DATA_DIR = path.join(app.getPath("userData"), "codeknife-data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "storage.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

let store = readJson(STORE_FILE, {});
let workspace = store.__workspace && fs.existsSync(store.__workspace) ? store.__workspace : "";

function logLine(m) {
  try { fs.appendFileSync(path.join(DATA_DIR, "app.log"), new Date().toISOString() + " " + m + "\n"); } catch {}
}
process.on("uncaughtException", (e) => logLine("uncaughtException: " + ((e && e.stack) || e)));
process.on("unhandledRejection", (e) => logLine("unhandledRejection: " + ((e && e.stack) || e)));
app.on("render-process-gone", (_e, wc, d) => logLine("render-process-gone: " + JSON.stringify(d)));
app.on("child-process-gone", (_e, d) => logLine("child-process-gone: " + JSON.stringify(d)));

// ---------------------------------------------------------------- built-in bridge
function binPath(name) {
  const packaged = path.join(process.resourcesPath || "", "bin", name);
  const dev = path.join(__dirname, "..", "bin", name);
  return fs.existsSync(packaged) ? packaged : dev;
}
function mcpConfig() {
  return {
    // Isolation: an empty ZS_WORKSPACE makes vscode_mcp fall back to the real VS Code's state.
    // Always pass a path; a nonexistent sentinel keeps every tool disabled until a folder is open.
    vscode: { command: binPath("vscode_mcp.exe"), args: [], env: { ZS_WORKSPACE: workspace || path.join(DATA_DIR, "__no-workspace__") }, cwd: workspace || DATA_DIR },
  };
}

// Editor tools: the call is forwarded to the renderer (Monaco) over IPC and answered by id.
const editorPending = new Map();
let editorReqId = 1;
function editorCall(op, args) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error("Editor window is not available."));
    const id = editorReqId++;
    const timer = setTimeout(() => { editorPending.delete(id); reject(new Error("Editor did not respond.")); }, 10000);
    editorPending.set(id, { resolve, reject, timer });
    win.webContents.send("editor:request", { id, op, args });
  });
}
ipcMain.on("editor:response", (e, id, res) => {
  if (!trustedRenderer(e)) return;
  const p = editorPending.get(id);
  if (!p) return;
  clearTimeout(p.timer); editorPending.delete(id);
  if (res && res.ok) p.resolve(JSON.stringify(res.data === undefined ? null : res.data, null, 2));
  else p.reject(new Error((res && res.error) || "Editor tool failed."));
});

const EDITOR_TOOLS = {
  editor_open: {
    description: "Open a workspace file in a Codeknife editor tab and optionally jump to a line.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path" }, line: { type: "integer", description: "1-based line to reveal" } }, required: ["path"] },
    handler: (a) => editorCall("open", { path: a.path, line: a.line }),
  },
  editor_get_active: {
    description: "Get the active editor tab: file path, language, cursor position, selected text and unsaved state.",
    inputSchema: { type: "object", properties: {} },
    handler: () => editorCall("get_active", {}),
  },
  editor_list_tabs: {
    description: "List all open editor tabs with their unsaved (dirty) state.",
    inputSchema: { type: "object", properties: {} },
    handler: () => editorCall("list_tabs", {}),
  },
  editor_get_buffer: {
    description: "Get the current editor buffer of an open tab, including unsaved edits. Defaults to the active tab. Optional start_line/end_line (1-based) limit the range.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path of an open tab (default: active tab)" }, start_line: { type: "integer" }, end_line: { type: "integer" } } },
    handler: (a) => editorCall("get_buffer", { path: a.path, start_line: a.start_line, end_line: a.end_line }),
  },
  editor_get_diagnostics: {
    description: "Get Monaco diagnostics (errors/warnings) for an open tab, or for all open tabs when no path is given.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path of an open tab (default: all open tabs)" } } },
    handler: (a) => editorCall("get_diagnostics", { path: a.path }),
  },
  editor_replace_text: {
    description: "Replace an exact text snippet directly in the Monaco buffer of a tab (opens the file if needed). One undo step (Ctrl+Z reverts it). Does NOT write to disk until the tab is saved. By default old_text must match exactly once.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path (default: active tab)" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old_text", "new_text"] },
    handler: (a) => editorCall("replace_text", { path: a.path, old_text: a.old_text, new_text: a.new_text, replace_all: a.replace_all }),
  },
  editor_replace_lines: {
    description: "Replace lines start_line..end_line (1-based, inclusive) of a tab's Monaco buffer with text. Use end_line = start_line-1 to insert before start_line, or start_line = lineCount+1 to append. One undo step. Does NOT write to disk until saved.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path (default: active tab)" }, start_line: { type: "integer" }, end_line: { type: "integer" }, text: { type: "string" } }, required: ["start_line", "end_line", "text"] },
    handler: (a) => editorCall("replace_lines", { path: a.path, start_line: a.start_line, end_line: a.end_line, text: a.text }),
  },
  editor_save: {
    description: "Save an open tab (default: active tab) from the Monaco buffer to disk. Prompts the user if the file changed on disk meanwhile.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path of an open tab (default: active tab)" } } },
    handler: (a) => editorCall("save", { path: a.path }),
  },
};

const core = new BridgeCore({ log: logLine, onChange: () => broadcastStatus(), builtins: EDITOR_TOOLS });
const languageServices = new LanguageServiceManager({
  app,
  log: logLine,
  onStatus: (status) => {
    if (win && !win.isDestroyed()) win.webContents.send("lsp:status", status);
  },
  onDiagnostics: (diagnostics) => {
    if (win && !win.isDestroyed()) win.webContents.send("lsp:diagnostics", diagnostics);
  },
});

function statusObj() {
  return {
    type: "zs-status", connected: true, mcpAlive: core.mcpAlive(), bridgeVersion: VERSION,
    studio: null, studioApp: null, studioProc: null,
    tools: core.catalog.length, servers: core.serverStatus(),
  };
}
function broadcastStatus() {
  if (view && !view.webContents.isDestroyed()) view.webContents.send("zs:push", statusObj());
  if (win && !win.isDestroyed()) win.webContents.send("app:bridge-status", { alive: core.mcpAlive(), tools: core.catalog.length });
}

async function handleRuntimeMessage(msg) {
  switch (msg.type) {
    case "status": return statusObj();
    case "list_tools": return { ok: true, tools: core.catalog };
    case "call_tool": return core.callTool(msg);
    case "restart_mcp": {
      const r = await core.restart(mcpConfig());
      return { ...r, tools: core.catalog, servers: core.serverStatus() };
    }
    case "reconnect": return { ok: true };
    default: return { ok: false, error: "unknown message" };
  }
}

const PROVIDER_HOSTS = new Set([
  "chat.deepseek.com", "chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com",
  "www.kimi.ai", "kimi.ai", "chat.z.ai", "chat.qwen.ai", "coder.qwen.ai", "arena.ai", "www.meta.ai",
  "meta.ai", "ptero.pro", "grok.com", "chat.mistral.ai",
]);
function trustedSender(e) {
  try {
    if (!view || e.sender !== view.webContents) return false;
    if (e.senderFrame && e.senderFrame !== view.webContents.mainFrame) return false;
    const u = new URL(e.senderFrame ? e.senderFrame.url : view.webContents.getURL());
    return u.protocol === "https:" && PROVIDER_HOSTS.has(u.hostname);
  } catch { return false; }
}
const ALLOWED_RUNTIME = new Set(["status", "list_tools", "call_tool", "restart_mcp", "reconnect"]);

ipcMain.handle("zs:runtime", (e, msg) => {
  if (!trustedSender(e)) return { ok: false, error: "untrusted sender" };
  if (!msg || typeof msg !== "object" || !ALLOWED_RUNTIME.has(msg.type)) return { ok: false, error: "message not allowed" };
  if (msg.type === "call_tool") {
    if (typeof msg.name !== "string" || (msg.server && msg.server !== "vscode")) return { ok: false, error: "tool not allowed" };
    msg = { ...msg, server: "vscode" };
  }
  return handleRuntimeMessage(msg);
});
ipcMain.handle("zs:storage-get", (e, keys) => {
  if (!trustedSender(e)) return {};
  if (keys == null) return Object.fromEntries(Object.entries(store).filter(([k]) => !k.startsWith("__")));
  const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const out = {};
  for (const k of list) if (!String(k).startsWith("__") && k in store) out[k] = store[k];
  return out;
});
ipcMain.handle("zs:storage-set", (e, items) => {
  if (!trustedSender(e)) return false;
  if (!items || typeof items !== "object") return false;
  for (const [k, v] of Object.entries(items)) { if (!k.startsWith("__")) store[k] = v; }
  writeJson(STORE_FILE, store);
  return true;
});

// ---------------------------------------------------------------- workspace file system (renderer-only)
function trustedRenderer(e) {
  return !!win && !win.isDestroyed() && e.sender === win.webContents;
}
// Resolve a workspace-relative path; refuse anything that escapes the workspace.
function safePath(rel) {
  if (!workspace) throw new Error("No folder is open.");
  const abs = path.resolve(workspace, rel || ".");
  const root = path.resolve(workspace);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("Path is outside the workspace.");
  return abs;
}
function toRel(abs) { return path.relative(workspace, abs).split(path.sep).join("/"); }

function guard(fn) {
  return async (e, ...args) => {
    if (!trustedRenderer(e)) return { ok: false, error: "untrusted sender" };
    try { return { ok: true, ...(await fn(...args)) }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  };
}

ipcMain.handle("fs:list", guard(async (rel) => {
  const dir = safePath(rel);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = entries
    .filter((d) => !(d.isDirectory() && IGNORED_DIRS.has(d.name)))
    .map((d) => ({ name: d.name, path: toRel(path.join(dir, d.name)), dir: d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { items };
}));
ipcMain.handle("fs:read", guard(async (rel) => {
  const abs = safePath(rel);
  const st = await fs.promises.stat(abs);
  if (st.size > MAX_OPEN_BYTES) throw new Error("File is larger than 5 MB.");
  const buf = await fs.promises.readFile(abs);
  if (buf.includes(0)) throw new Error("Binary file cannot be opened in the editor.");
  return { content: buf.toString("utf-8"), mtime: st.mtimeMs };
}));
ipcMain.handle("fs:write", guard(async (rel, content) => {
  if (typeof content !== "string") throw new Error("Invalid content.");
  const abs = safePath(rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, "utf-8");
  const st = await fs.promises.stat(abs);
  return { mtime: st.mtimeMs };
}));
ipcMain.handle("fs:create-file", guard(async (rel) => {
  const abs = safePath(rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, "", { encoding: "utf-8", flag: "wx" });
  return {};
}));
ipcMain.handle("fs:create-dir", guard(async (rel) => {
  await fs.promises.mkdir(safePath(rel), { recursive: true });
  return {};
}));
ipcMain.handle("fs:rename", guard(async (from, to) => {
  const a = safePath(from), b = safePath(to);
  if (fs.existsSync(b)) throw new Error("Destination already exists.");
  await fs.promises.rename(a, b);
  return {};
}));
ipcMain.handle("fs:delete", guard(async (rel) => {
  const abs = safePath(rel);
  if (abs === path.resolve(workspace)) throw new Error("Refusing to delete the workspace root.");
  await shell.trashItem(abs); // to the recycle bin, so it can be recovered
  return {};
}));
ipcMain.handle("fs:reveal", guard(async (rel) => { shell.showItemInFolder(safePath(rel)); return {}; }));

// ---------------------------------------------------------------- integrated PTY terminal
let termProc = null;
let termIsPowerShell = false;
function termSend(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function terminalShell() {
  const windowsPowerShell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(windowsPowerShell)) return { command: windowsPowerShell, args: ["-NoLogo"], powershell: true };
  if (process.env.ComSpec && fs.existsSync(process.env.ComSpec)) {
    return { command: process.env.ComSpec, args: [], powershell: false };
  }
  throw new Error("No supported terminal shell was found.");
}
function openTerminal(cols, rows) {
  if (termProc) return { shell: termProc.process, cwd: workspace || app.getPath("home") };
  const shellConfig = terminalShell();
  const cwd = workspace || app.getPath("home");
  termProc = pty.spawn(shellConfig.command, shellConfig.args, {
    name: "xterm-256color",
    cols: Math.max(2, Math.min(500, Number(cols) || 80)),
    rows: Math.max(2, Math.min(300, Number(rows) || 24)),
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    // WinPTY avoids ConPTY's console-list helper failing for a GUI parent.
    useConpty: false,
  });
  termIsPowerShell = shellConfig.powershell;
  const proc = termProc;
  proc.onData((data) => termSend("term:data", data));
  proc.onExit((result) => {
    if (termProc === proc) termProc = null;
    termSend("term:exit", result);
  });
  return { shell: shellConfig.command, cwd };
}
function closeTerminal() {
  if (!termProc) return;
  const proc = termProc;
  termProc = null;
  try { proc.kill(); }
  catch (error) { logLine("terminal close failed: " + (error.message || error)); }
}
function powershellQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
ipcMain.handle("term:open", guard(async (size) => openTerminal(size && size.cols, size && size.rows)));
ipcMain.on("term:input", (e, data) => {
  if (!trustedRenderer(e) || !termProc || typeof data !== "string") return;
  if (data.length > 1024 * 1024) {
    termSend("term:data", "\r\n[terminal input exceeded 1 MB]\r\n");
    return;
  }
  termProc.write(data);
});
ipcMain.on("term:resize", (e, size) => {
  if (!trustedRenderer(e) || !termProc || !size) return;
  const cols = Number(size.cols), rows = Number(size.rows);
  if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) {
    termProc.resize(cols, rows);
  }
});
ipcMain.handle("term:run-file", guard(async (rel) => {
  const abs = safePath(rel);
  const ext = path.extname(abs).toLowerCase();
  const command = [".js", ".mjs", ".cjs"].includes(ext) ? "node" : ext === ".py" ? "python" : "";
  if (!command) throw new Error("Run Active File supports JavaScript and Python files.");
  if (!termProc) openTerminal(80, 24);
  if (!termIsPowerShell) throw new Error("Run Active File requires PowerShell.");
  termProc.write(`& ${powershellQuote(command)} ${powershellQuote(abs)}\r`);
  return {};
}));
ipcMain.handle("term:interrupt", (e) => {
  if (trustedRenderer(e) && termProc) termProc.write("\x03");
  return true;
});
ipcMain.handle("term:close", (e) => {
  if (trustedRenderer(e)) closeTerminal();
  return true;
});

// ---------------------------------------------------------------- language servers
function languageHandler(fn) {
  return async (e, ...args) => {
    if (!trustedRenderer(e)) return { ok: false, error: "untrusted sender" };
    try { return await fn(...args); }
    catch (error) {
      const message = String((error && error.message) || error);
      logLine("language service request failed: " + message);
      return { ok: false, error: message };
    }
  };
}
ipcMain.handle("lsp:open", languageHandler((doc) => languageServices.openDocument(doc)));
ipcMain.handle("lsp:change", languageHandler((doc) => languageServices.changeDocument(doc)));
ipcMain.handle("lsp:close", languageHandler((doc) => languageServices.closeDocument(doc)));
ipcMain.handle("lsp:request", languageHandler(async (request) => ({
  ok: true,
  result: await languageServices.request(request),
})));
ipcMain.handle("lsp:resolve", languageHandler((uri) => languageServices.resolveUri(uri)));
ipcMain.handle("lsp:status", (e) => (trustedRenderer(e) ? languageServices.status() : []));

// ---------------------------------------------------------------- realtime watcher
let watcher = null;
let pendingChanges = new Set();
let flushTimer = null;
function stopWatcher() {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  pendingChanges.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}
function startWatcher() {
  stopWatcher();
  if (!workspace) return;
  try {
    watcher = fs.watch(workspace, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join("/");
      if (rel.split("/").some((seg) => IGNORED_DIRS.has(seg))) return;
      pendingChanges.add(rel);
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const changed = [...pendingChanges]; pendingChanges.clear();
        if (win && !win.isDestroyed()) win.webContents.send("fs:changed", changed);
      }, 120);
    });
    watcher.on("error", (e) => logLine("watcher error: " + e));
  } catch (e) { logLine("watcher failed: " + e); }
}

// ---------------------------------------------------------------- workspace selection
async function setWorkspace(dir) {
  workspace = dir;
  store.__workspace = dir; writeJson(STORE_FILE, store);
  await languageServices.setWorkspace(dir);
  startWatcher();
  if (win && !win.isDestroyed()) {
    win.webContents.send("app:workspace", workspace);
    win.setTitle("Codeknife - " + path.basename(dir));
  }
  core.restart(mcpConfig());
}
async function pickWorkspace() {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Open folder" });
  if (r.canceled || !r.filePaths[0]) return workspace;
  await setWorkspace(r.filePaths[0]);
  return workspace;
}
ipcMain.handle("app:get-workspace", (e) => (trustedRenderer(e) ? workspace : ""));
ipcMain.handle("app:pick-workspace", (e) => (trustedRenderer(e) ? pickWorkspace() : ""));
ipcMain.handle("app:restart-bridge", async (e) => {
  if (!trustedRenderer(e)) return { ok: false };
  return core.restart(mcpConfig());
});
ipcMain.handle("app:bridge-status", (e) => (trustedRenderer(e) ? { alive: core.mcpAlive(), tools: core.catalog.length } : { alive: false, tools: 0 }));
ipcMain.handle("app:open-docs", async (e) => {
  if (!trustedRenderer(e)) return false;
  await shell.openExternal("https://github.com/herdodp/codeknife-ADE#readme");
  return true;
});

// ---------------------------------------------------------------- AI panel
function applyAiBounds() {
  if (!view) return;
  const b = aiBounds;
  view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
}
ipcMain.on("ai:bounds", (e, b) => {
  if (!trustedRenderer(e) || !b || typeof b !== "object") return;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  aiBounds = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) };
  applyAiBounds();
});
ipcMain.handle("ai:navigate", (e, url) => { if (trustedRenderer(e) && view && /^https?:\/\//i.test(String(url))) view.webContents.loadURL(url); });
ipcMain.handle("ai:get-url", (e) => (trustedRenderer(e) && view ? view.webContents.getURL() : ""));
ipcMain.handle("ai:back", (e) => { if (trustedRenderer(e) && view && view.webContents.canGoBack()) view.webContents.goBack(); });
ipcMain.handle("ai:forward", (e) => { if (trustedRenderer(e) && view && view.webContents.canGoForward()) view.webContents.goForward(); });
ipcMain.handle("ai:reload", (e) => { if (trustedRenderer(e) && view) view.webContents.reload(); });

// ---------------------------------------------------------------- menu
function sendAction(action) { if (win && !win.isDestroyed()) win.webContents.send("menu:action", action); }
function buildMenu() {
  const template = [
    { label: "File", submenu: [
      { label: "Open Folder...", accelerator: "CmdOrCtrl+O", click: () => pickWorkspace() },
      { label: "New File", accelerator: "CmdOrCtrl+N", click: () => sendAction("new-file") },
      { label: "New Folder", accelerator: "CmdOrCtrl+Shift+N", click: () => sendAction("new-folder") },
      { type: "separator" },
      { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendAction("save") },
      { label: "Save All", accelerator: "CmdOrCtrl+Alt+S", click: () => sendAction("save-all") },
      { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => sendAction("close-tab") },
      { type: "separator" },
      { label: "Preferences", submenu: [
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => sendAction("settings") },
        { label: "Keyboard Shortcuts", click: () => sendAction("settings-shortcuts") },
      ] },
      { type: "separator" },
      { role: "quit" },
    ] },
    { label: "Edit", submenu: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => sendAction("undo") },
      { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: () => sendAction("redo") },
      { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { type: "separator" },
      { label: "Find", accelerator: "CmdOrCtrl+F", click: () => sendAction("find") },
      { label: "Replace", accelerator: "CmdOrCtrl+H", click: () => sendAction("replace") },
    ] },
    { label: "Selection", submenu: [
      { label: "Select All", accelerator: "CmdOrCtrl+A", click: () => sendAction("select-all") },
      { label: "Expand Selection", click: () => sendAction("expand-selection") },
      { label: "Shrink Selection", click: () => sendAction("shrink-selection") },
    ] },
    { label: "View", submenu: [
      { label: "Toggle Explorer", accelerator: "CmdOrCtrl+B", click: () => sendAction("toggle-explorer") },
      { label: "Toggle AI Assistant", accelerator: "CmdOrCtrl+Shift+A", click: () => sendAction("toggle-ai") },
      { label: "Toggle Terminal", accelerator: "CmdOrCtrl+`", click: () => sendAction("toggle-terminal") },
      { type: "separator" },
      { label: "Appearance", submenu: [
        { label: "Dark Theme", click: () => sendAction("theme-dark") },
        { label: "Light Theme", click: () => sendAction("theme-light") },
        { label: "Toggle Status Bar", click: () => sendAction("toggle-status") },
      ] },
      { label: "Command Palette", accelerator: "F1", click: () => sendAction("palette") },
      { type: "separator" },
      { label: "Restart MCP Bridge", click: () => sendAction("restart-bridge") },
      { role: "reload" }, { role: "toggleDevTools" }, { role: "togglefullscreen" },
      { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
    ] },
    { label: "Go", submenu: [
      { label: "Go to Line...", accelerator: "CmdOrCtrl+G", click: () => sendAction("go-line") },
      { label: "Go to Definition", accelerator: "F12", click: () => sendAction("go-definition") },
      { type: "separator" },
      { label: "Next Editor", accelerator: "CmdOrCtrl+Tab", click: () => sendAction("next-tab") },
      { label: "Previous Editor", accelerator: "CmdOrCtrl+Shift+Tab", click: () => sendAction("previous-tab") },
    ] },
    { label: "Run", submenu: [
      { label: "Run Active File", accelerator: "CmdOrCtrl+F5", click: () => sendAction("run-file") },
      { label: "Stop Running Command", click: () => sendAction("stop-command") },
    ] },
    { label: "Terminal", submenu: [
      { label: "Toggle Terminal", accelerator: "CmdOrCtrl+Shift+`", click: () => sendAction("toggle-terminal") },
      { label: "Clear", click: () => sendAction("clear-terminal") },
      { label: "Stop Running Command", click: () => sendAction("stop-command") },
    ] },
    { label: "Help", submenu: [
      { label: "Keyboard Shortcuts", click: () => sendAction("settings-shortcuts") },
      { label: "Documentation", click: () => shell.openExternal("https://github.com/herdodp/codeknife-ADE#readme") },
      { type: "separator" },
      { label: "About Codeknife", click: () => sendAction("settings-about") },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560, title: "Codeknife",
    icon: path.join(__dirname, "..", "icon.png"),
    backgroundColor: "#1e1e1e",
    webPreferences: { preload: path.join(__dirname, "renderer-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false, // extension scripts must share the page DOM
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: "persist:codeknife-ai",
    },
  });
  win.setBrowserView(view);
  applyAiBounds();
  win.on("closed", () => { win = null; view = null; stopWatcher(); });

  view.webContents.on("did-navigate", (_e, url) => {
    store.__lastUrl = url; writeJson(STORE_FILE, store);
    if (win) win.webContents.send("ai:url", url);
  });
  view.webContents.on("did-navigate-in-page", (_e, url) => { if (win) win.webContents.send("ai:url", url); });
  view.webContents.setWindowOpenHandler(({ url }) => {
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    if (host === "accounts.google.com") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 500, height: 680, parent: win, title: "Sign in",
          webPreferences: { partition: "persist:codeknife-ai", contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) view.webContents.loadURL(url);
    return { action: "deny" };
  });

  // Google refuses sign-in from embedded browsers that announce "Electron".
  const ua = view.webContents.getUserAgent().replace(/\sElectron\/\S+/, "").replace(/\scodeknife\/\S+/, "");
  view.webContents.setUserAgent(ua);
  session.fromPartition("persist:codeknife-ai").setUserAgent(ua);

  let startUrl = START_URL;
  try {
    const u = new URL(store.__lastUrl || "");
    if (u.protocol === "https:" && PROVIDER_HOSTS.has(u.hostname)) startUrl = u.href;
  } catch {}
  view.webContents.loadURL(startUrl);
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  languageServices.setWorkspace(workspace).catch((error) => logLine("language services workspace setup failed: " + error));
  startWatcher();
  core.start(mcpConfig()).then(broadcastStatus);
});

app.on("before-quit", () => {
  stopWatcher();
  closeTerminal();
  languageServices.dispose().catch((error) => logLine("language services shutdown failed: " + error));
  core.stop();
});
app.on("window-all-closed", () => app.quit());
