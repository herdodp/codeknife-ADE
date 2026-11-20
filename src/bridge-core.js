// SPDX-License-Identifier: GPL-3.0-or-later
// In-process replacement for bridge.py. No port, no WebSocket: the app's main
// process talks MCP (JSON-RPC lines) straight to its own child processes over stdio.
// Response shapes match what core/main.js expects from extension background.js.
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");

const PROTOCOL = "2024-11-05";
const VERSION = "app-1.1";
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_MCP_LINE_BYTES = 128 * 1024 * 1024;
const BIG_PAYLOAD_THREAD_BYTES = 256 * 1024;

// Isolation: the MCP child (and every program it runs) gets only a minimal allowlisted
// environment, so tokens and API keys from the host machine never leak into it.
const ENV_ALLOW = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "USERNAME", "USERDOMAIN",
  "LANG", "LC_ALL", "TERM", "SHELL", "USER",
]);
function cleanEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOW.has(k.toUpperCase())) out[k] = v;
  }
  out.PYTHONIOENCODING = "utf-8";
  return out;
}

function parseLargeJson(line) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(
      `const { parentPort, workerData } = require("worker_threads");
       try {
         parentPort.postMessage({ ok: true, value: JSON.parse(Buffer.from(workerData).toString("utf8")) });
       } catch (error) {
         parentPort.postMessage({ ok: false, error: String(error.message || error) });
       }`,
      { eval: true, workerData: line, transferList: [line.buffer] },
    );
    worker.once("message", (result) => {
      settled = true;
      if (result && result.ok) resolve(result.value);
      else reject(new Error(result && result.error ? result.error : "Could not parse MCP response."));
    });
    worker.once("error", (error) => { settled = true; reject(error); });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`MCP JSON worker exited without a result (code ${code}).`));
    });
  });
}

class RequestLimiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }
  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
  async run(callback) {
    await this.acquire();
    try { return await callback(); }
    finally { this.release(); }
  }
}

class McpServer {
  constructor(id, cfg, log, onChange = () => {}) {
    this.id = id; this.cfg = cfg; this.log = log;
    this.onChange = onChange;
    this.proc = null; this.ready = false; this.tools = []; this.error = null;
    this.pending = new Map(); this.nextId = 1;
    this.lineChunks = []; this.lineBytes = 0; this.discardingLine = false;
    this.retryTimer = null; this.retryAttempt = 0; this.stopping = false;
  }
  get alive() { return !!(this.proc && this.proc.exitCode === null && this.ready); }

  async start() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.stopping = false;
    await this._stopProcess();
    const { command, args = [], env = {} } = this.cfg;
    if (typeof command !== "string" || !command) {
      this.error = "MCP server command is missing.";
      this.log(`[${this.id}] ${this.error}`);
      return false;
    }
    try {
      this.proc = spawn(command, args, {
        cwd: this.cfg.cwd || undefined,
        env: { ...cleanEnv(), ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) { this.error = String(e.message || e); return false; }
    const proc = this.proc;
    proc.on("error", (e) => {
      this.error = String(e.message || e);
      this.log(`[${this.id}] MCP process error: ${this.error}`);
      this.ready = false;
      this._fail(this.error);
      if (this.proc === proc) this._scheduleRestart();
      this.onChange();
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) {
        this.ready = false;
        this.error = `${this.id} MCP server stopped${code == null ? "" : ` (exit ${code})`}.`;
        this._fail(this.error);
        this.log(`[${this.id}] ${this.error}`);
        this._scheduleRestart();
        this.onChange();
      }
    });
    proc.stdin.on("error", (e) => {
      this.error = String(e.message || e);
      this.log(`[${this.id}] MCP stdin error: ${this.error}`);
      this._fail(this.error);
    });
    proc.stdout.on("data", (chunk) => this._onData(chunk));
    proc.stderr.on("data", (d) => this.log(`[${this.id}] stderr: ${String(d).trim().slice(0, 1000)}`));
    try {
      await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "codeknife-app", version: VERSION } }, 12000);
      this._write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const r = await this.request("tools/list", {}, 20000);
      const raw = r && Array.isArray(r.tools) ? r.tools : [];
      this.tools = raw.filter((t) => t && typeof t.name === "string");
      this.ready = true; this.error = null;
      this.retryAttempt = 0;
      this.log(`[${this.id}] MCP server up (${this.tools.length} tools)`);
      return true;
    } catch (e) {
      this.error = String(e.message || e);
      this.log(`[${this.id}] startup failed: ${this.error}`);
      await this._stopProcess();
      this._scheduleRestart();
      return false;
    }
  }

  async stop() {
    this.stopping = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    await this._stopProcess();
  }

  async _stopProcess() {
    const proc = this.proc;
    this.proc = null; this.ready = false; this.tools = [];
    this._fail(`${this.id} MCP server stopped.`);
    this.lineChunks = []; this.lineBytes = 0; this.discardingLine = false;
    if (!proc || proc.exitCode !== null) return;
    try { proc.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 2000);
      proc.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }

  _scheduleRestart() {
    if (this.stopping || this.retryTimer || typeof this.cfg.command !== "string" || !this.cfg.command) return;
    this.retryAttempt += 1;
    const delayMs = Math.min(5000 * (2 ** (this.retryAttempt - 1)), 300000);
    this.log(`[${this.id}] restarting (attempt ${this.retryAttempt}) in ${Math.round(delayMs / 1000)}s`);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.stopping) return;
      await this.start();
      this.onChange();
    }, delayMs);
  }

  _fail(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }
  _write(obj) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error(`${this.id} MCP server is offline.`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  _appendLinePart(part) {
    if (this.discardingLine || !part.length) return;
    this.lineBytes += part.length;
    if (this.lineBytes > MAX_MCP_LINE_BYTES) {
      this.lineChunks = []; this.lineBytes = 0; this.discardingLine = true;
      const error = `${this.id} MCP response was too large (over 128 MB). Request a smaller range or fewer items.`;
      this.log(`[${this.id}] MCP response exceeded the buffer limit; discarding it.`);
      this._fail(error);
      return;
    }
    this.lineChunks.push(part);
  }
  _onData(chunk) {
    let start = 0, newline;
    while ((newline = chunk.indexOf(0x0a, start)) >= 0) {
      this._appendLinePart(chunk.subarray(start, newline));
      if (this.discardingLine) {
        this.discardingLine = false;
        this.lineChunks = []; this.lineBytes = 0;
      } else {
        const line = Buffer.concat(this.lineChunks, this.lineBytes);
        this.lineChunks = []; this.lineBytes = 0;
        if (line.length) this._handleLine(line);
      }
      start = newline + 1;
    }
    this._appendLinePart(chunk.subarray(start));
  }
  async _handleLine(line) {
    let msg;
    try {
      msg = line.length > BIG_PAYLOAD_THREAD_BYTES
        ? await parseLargeJson(line)
        : JSON.parse(line.toString("utf8"));
    } catch (e) {
      this.log(`[${this.id}] ignored invalid MCP stdout: ${String(e.message || e).slice(0, 200)}`);
      return;
    }
    if (msg && typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      clearTimeout(p.timer); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(typeof msg.error === "object" ? String(msg.error.message || JSON.stringify(msg.error)) : String(msg.error)));
      else p.resolve(msg.result);
    }
  }
  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); const e = new Error(`${method} timed out`); e.timeout = true; reject(e); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
}

class BridgeCore {
  constructor({ log = () => {}, onChange = () => {}, builtins = {} } = {}) {
    this.log = log; this.onChange = onChange; this.builtins = builtins; // host-provided tools: { name: { description, inputSchema, handler(args) } }
    this.servers = new Map(); this.catalog = [];
    this.requestLimiter = new RequestLimiter(MAX_CONCURRENT_REQUESTS);
  }
  _rebuild() {
    this._rebuildMcp();
    const own = Object.entries(this.builtins).map(([n, b]) => ({
      name: n, server: "vscode", description: b.description || "",
      inputSchema: b.inputSchema || { type: "object", properties: {} },
    }));
    this.catalog = [...own, ...this.catalog];
  }
  _rebuildMcp() {
    const entries = [];
    for (const s of this.servers.values()) if (s.alive) for (const t of s.tools) entries.push([s.id, t]);
    const counts = {};
    for (const [, t] of entries) counts[t.name] = (counts[t.name] || 0) + 1;
    this.catalog = entries.map(([sid, t]) => ({
      name: counts[t.name] > 1 ? `${sid}/${t.name}` : t.name,
      server: sid,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));
  }
  serverStatus() { return [...this.servers.values()].map((s) => ({ id: s.id, alive: s.alive, tools: s.alive ? s.tools.length : 0 })); }
  mcpAlive() { return [...this.servers.values()].some((s) => s.alive); }

  async start(config) {
    this.servers = new Map(Object.entries(config).map(([id, cfg]) => [id, new McpServer(
      id, cfg, this.log, () => { this._rebuild(); this.onChange(); },
    )]));
    await Promise.all([...this.servers.values()].map(async (s) => {
      try { await s.start(); } catch (e) { s.error = String(e.message || e); }
      this._rebuild(); this.onChange();
    }));
    this._rebuild();
  }
  async stop() {
    await Promise.all([...this.servers.values()].map((s) => s.stop()));
    this.servers.clear(); this.catalog = [];
  }
  async restart(config) {
    try { await this.stop(); await this.start(config); this.onChange(); return { ok: true, alive: this.mcpAlive() }; }
    catch (e) { return { ok: false, alive: false, error: String(e.message || e) }; }
  }

  _resolve(name) {
    if (name.includes("/")) {
      const [sid, bare] = [name.slice(0, name.indexOf("/")), name.slice(name.indexOf("/") + 1)];
      const s = this.servers.get(sid);
      if (s && s.alive && s.tools.some((t) => t.name === bare)) return [s, bare];
    }
    const m = [];
    for (const s of this.servers.values()) if (s.alive) for (const t of s.tools) if (t.name === name) m.push(s);
    return m.length === 1 ? [m[0], name] : [null, name];
  }

  async callTool(request) {
    return this.requestLimiter.run(() => this._callTool(request));
  }

  async _callTool({ name, arguments: args, timeout, server }) {
    if (typeof name !== "string" || (args != null && typeof args !== "object")) return { ok: false, kind: "tool_error", error: "Invalid tool call." };
    let secs = Number(timeout); secs = Number.isFinite(secs) ? Math.max(1, Math.min(secs / 1000, 300)) : 120;
    const b = Object.prototype.hasOwnProperty.call(this.builtins, name) ? this.builtins[name] : null;
    if (b) {
      if (server && server !== "vscode") return { ok: false, kind: "unknown_tool", error: `MCP tool not available for the selected server: ${name}` };
      try { return { ok: true, text: String(await b.handler(args || {})), images: [] }; }
      catch (e) { return { ok: false, kind: "tool_error", error: String(e.message || e) }; }
    }
    const [s, toolName] = this._resolve(name);
    if (!s) return { ok: false, kind: "unknown_tool", error: `Unknown or unavailable MCP tool: ${name}` };
    if (server && s.id !== server) return { ok: false, kind: "unknown_tool", error: `MCP tool not available for the selected server: ${name}` };
    try {
      const result = (await s.request("tools/call", { name: toolName, arguments: args || {} }, secs * 1000)) || {};
      const parts = [], images = [];
      for (const item of Array.isArray(result.content) ? result.content : []) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
        else if (item.type === "image" && typeof item.data === "string") images.push({ data: item.data, mimeType: item.mimeType || "image/png" });
      }
      if (!parts.length && result.structuredContent != null) parts.push(JSON.stringify(result.structuredContent));
      const text = parts.join("\n");
      if (result.isError) return { ok: false, error: text || "MCP tool failed." };
      return { ok: true, text, images };
    } catch (e) {
      return { ok: false, kind: e.timeout ? "timeout" : "tool_error", error: String(e.message || e) };
    }
  }
}

module.exports = { BridgeCore, VERSION };
