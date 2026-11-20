// SPDX-License-Identifier: GPL-3.0-or-later
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");
const { createMessageConnection } = require("vscode-jsonrpc/node");

const LANGUAGE_SERVERS = {
  python: { name: "Python", languages: ["python"], bundled: true },
  cpp: { name: "C/C++", languages: ["c", "cpp"], command: "clangd" },
  go: { name: "Go", languages: ["go"], command: "gopls", args: ["serve"] },
  rust: { name: "Rust", languages: ["rust"], command: "rust-analyzer" },
};
const SERVER_FOR_LANGUAGE = new Map(
  Object.entries(LANGUAGE_SERVERS).flatMap(([server, config]) => config.languages.map((language) => [language, server])),
);
const REQUEST_METHODS = new Set([
  "textDocument/completion",
  "textDocument/hover",
  "textDocument/definition",
]);

function findExecutable(command) {
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())]
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {}
    }
  }
  return "";
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, milliseconds);
    child.once("exit", onExit);
  });
}

class LanguageServiceManager {
  constructor({ app, log, onStatus, onDiagnostics }) {
    this.app = app;
    this.log = log;
    this.onStatus = onStatus;
    this.onDiagnostics = onDiagnostics;
    this.workspace = "";
    this.sessions = new Map();
    this.starting = new Map();
  }

  async setWorkspace(workspace) {
    this.workspace = workspace || "";
    const sessions = [...this.sessions.values()];
    const pendingStarts = [...this.starting.values()];
    this.sessions.clear();
    this._publishStatus();
    await Promise.all(sessions.map((session) => this._stopSession(session)));
    await Promise.allSettled(pendingStarts);
  }

  status() {
    return [
      { id: "monaco", name: "JavaScript/TypeScript, HTML, CSS, JSON", state: "built-in", detail: "Monaco language services" },
      ...Object.entries(LANGUAGE_SERVERS).map(([id, config]) => {
        const session = this.sessions.get(id);
        const executable = config.bundled ? this._pyrightPath() : findExecutable(config.command);
        const state = session && session.ready
          ? "running"
          : session
            ? "starting"
            : executable && fs.existsSync(executable)
              ? (config.bundled ? "bundled" : "installed")
              : "not installed";
        const detail = config.bundled
          ? "Bundled Pyright"
          : executable || `Install ${config.command} and add it to PATH`;
        return { id, name: config.name, state, detail };
      }),
    ];
  }

  async openDocument({ path: relativePath, languageId, text }) {
    const serverId = SERVER_FOR_LANGUAGE.get(languageId);
    if (!serverId) return { ok: false, error: `No external language server is configured for ${languageId}.` };
    if (typeof text !== "string") throw new Error("Document text must be a string.");
    const absolutePath = this._workspacePath(relativePath);
    const uri = pathToFileURL(absolutePath).href;
    try {
      const session = await this._ensure(serverId);
      if (session.root !== this.workspace) throw new Error("Workspace changed while the language server was starting.");
      const previous = session.documents.get(uri);
      const version = previous ? previous.version + 1 : 1;
      const document = { path: relativePath, languageId, version };
      session.documents.set(uri, document);
      session.connection.sendNotification(previous ? "textDocument/didChange" : "textDocument/didOpen", previous
        ? { textDocument: { uri, version }, contentChanges: [{ text }] }
        : { textDocument: { uri, languageId, version, text } });
      return { ok: true, uri, version };
    } catch (error) {
      this.log(`language server ${serverId} failed to open ${relativePath}: ${error.message || error}`);
      return { ok: false, error: String(error.message || error) };
    }
  }

  async changeDocument({ path: relativePath, languageId, version, text }) {
    const serverId = SERVER_FOR_LANGUAGE.get(languageId);
    const session = serverId && this.sessions.get(serverId);
    if (!session || !session.ready || session.root !== this.workspace) return { ok: false, error: "Language server is not running." };
    if (typeof text !== "string" || !Number.isInteger(version)) throw new Error("Invalid document change.");
    const uri = pathToFileURL(this._workspacePath(relativePath)).href;
    if (!session.documents.has(uri)) return { ok: false, error: "Document is not open in the language server." };
    session.documents.set(uri, { path: relativePath, languageId, version });
    session.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return { ok: true };
  }

  async closeDocument({ path: relativePath, languageId }) {
    const serverId = SERVER_FOR_LANGUAGE.get(languageId);
    const session = serverId && this.sessions.get(serverId);
    if (!session || session.root !== this.workspace) return { ok: true };
    const uri = pathToFileURL(this._workspacePath(relativePath)).href;
    if (session.documents.delete(uri) && session.ready) {
      session.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
      this.onDiagnostics({ path: relativePath, diagnostics: [] });
    }
    return { ok: true };
  }

  async request({ languageId, method, params }) {
    if (!REQUEST_METHODS.has(method)) throw new Error(`Language server request is not allowed: ${method}`);
    const serverId = SERVER_FOR_LANGUAGE.get(languageId);
    const session = serverId && this.sessions.get(serverId);
    if (!session || !session.ready || session.root !== this.workspace) throw new Error("Language server is not running.");
    const uri = params && params.textDocument && params.textDocument.uri;
    if (typeof uri !== "string" || !session.documents.has(uri)) throw new Error("Document is not open in the language server.");
    return session.connection.sendRequest(method, params);
  }

  resolveUri(uri) {
    if (!this.workspace || typeof uri !== "string") throw new Error("A workspace file URI is required.");
    const root = path.resolve(this.workspace);
    const absolutePath = path.resolve(fileURLToPath(uri));
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(".." + path.sep) || path.isAbsolute(relativePath)) {
      throw new Error("Language server location is outside the workspace.");
    }
    return { ok: true, path: relativePath.split(path.sep).join("/") };
  }

  async dispose() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this._stopSession(session)));
  }

  _workspacePath(relativePath) {
    if (!this.workspace || typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("A workspace-relative file path is required.");
    }
    const root = path.resolve(this.workspace);
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
      throw new Error("Path is outside the workspace.");
    }
    return absolutePath;
  }

  _pyrightPath() {
    return this.app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "pyright", "langserver.index.js")
      : path.join(__dirname, "..", "node_modules", "pyright", "langserver.index.js");
  }

  _serverCommand(serverId) {
    const config = LANGUAGE_SERVERS[serverId];
    if (config.bundled) {
      const script = this._pyrightPath();
      if (!fs.existsSync(script)) throw new Error(`Bundled Pyright server was not found: ${script}`);
      return { command: process.execPath, args: [script, "--stdio"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
    }
    const command = findExecutable(config.command);
    if (!command) throw new Error(`${config.command} was not found on PATH.`);
    return { command, args: config.args || [], env: process.env };
  }

  _ensure(serverId) {
    const current = this.sessions.get(serverId);
    if (current && current.ready) return Promise.resolve(current);
    if (this.starting.has(serverId)) return this.starting.get(serverId);
    const pending = this._start(serverId).finally(() => this.starting.delete(serverId));
    this.starting.set(serverId, pending);
    return pending;
  }

  async _start(serverId) {
    const root = this.workspace;
    const config = this._serverCommand(serverId);
    const child = spawn(config.command, config.args, {
      cwd: root,
      env: config.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const connection = createMessageConnection(child.stdout, child.stdin);
    const session = { serverId, child, connection, documents: new Map(), ready: false, root };
    this.sessions.set(serverId, session);

    connection.onRequest("workspace/configuration", ({ items }) => items.map(() => ({})));
    connection.onRequest("workspace/workspaceFolders", () => session.root
      ? [{ uri: pathToFileURL(session.root).href, name: path.basename(session.root) }]
      : []);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onNotification("window/logMessage", (message) => this.log(`language server ${serverId}: ${message.message || ""}`));
    connection.onNotification("window/showMessage", (message) => this.log(`language server ${serverId}: ${message.message || ""}`));
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      try {
        const absolutePath = fileURLToPath(params.uri);
        const relativePath = path.relative(this.workspace, absolutePath).split(path.sep).join("/");
        if (relativePath && !relativePath.startsWith("../")) {
          this.onDiagnostics({ path: relativePath, version: params.version, diagnostics: params.diagnostics || [] });
        }
      } catch (error) {
        this.log(`language server ${serverId} sent invalid diagnostics URI: ${error.message || error}`);
      }
    });
    connection.onError(([error, message, count]) => {
      this.log(`language server ${serverId} protocol error (${count}, ${message}): ${error.message || error}`);
    });
    connection.onClose(() => {
      if (this.sessions.get(serverId) === session) {
        this.sessions.delete(serverId);
        session.ready = false;
        this._publishStatus();
      }
    });
    child.stderr.on("data", (chunk) => this.log(`language server ${serverId}: ${chunk.toString("utf8").slice(0, 2000).trimEnd()}`));
    child.on("error", (error) => this.log(`language server ${serverId} process error: ${error.message || error}`));
    child.on("exit", (code, signal) => {
      if (this.sessions.get(serverId) === session) {
        this.sessions.delete(serverId);
        session.ready = false;
        this.log(`language server ${serverId} exited (${code === null ? signal : code}).`);
        this._publishStatus();
      }
    });

    connection.listen();
    try {
      await withTimeout(new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }), 10000, `Could not start ${config.command || "Pyright"}.`);
      await withTimeout(connection.sendRequest("initialize", {
        processId: process.pid,
        clientInfo: { name: "Codeknife", version: this.app.getVersion() },
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            completion: { dynamicRegistration: false, completionItem: { snippetSupport: false }, completionItemKind: { valueSet: Array.from({ length: 25 }, (_, index) => index + 1) } },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: false, linkSupport: true },
            publishDiagnostics: { relatedInformation: true },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      }), 20000, `${config.command || "Pyright"} did not initialize in time.`);
      if (this.workspace !== root) throw new Error("Workspace changed while the language server was starting.");
      connection.sendNotification("initialized", {});
      session.ready = true;
      this._publishStatus();
      return session;
    } catch (error) {
      if (this.sessions.get(serverId) === session) this.sessions.delete(serverId);
      await this._stopSession(session);
      this._publishStatus();
      throw error;
    }
  }

  async _stopSession(session) {
    let graceful = false;
    if (session.ready) {
      try {
        await withTimeout(session.connection.sendRequest("shutdown"), 1000, "Language server shutdown timed out.");
        session.connection.sendNotification("exit");
        graceful = true;
      } catch (error) {
        this.log(`language server ${session.serverId} shutdown: ${error.message || error}`);
      }
    }
    if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
      if (graceful && await waitForExit(session.child, 1500)) {
        session.connection.dispose();
        return;
      }
      session.connection.dispose();
      if (!session.child.killed) {
        try { session.child.kill(); }
        catch (error) { this.log(`language server ${session.serverId} kill failed: ${error.message || error}`); }
      }
      await waitForExit(session.child, 1000);
      return;
    }
    session.connection.dispose();
  }

  _publishStatus() {
    if (this.onStatus) this.onStatus(this.status());
  }
}

module.exports = { LanguageServiceManager };
