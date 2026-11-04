// SPDX-License-Identifier: GPL-3.0-or-later
// Preload for the Codeknife UI window (local file). Only an explicit API is exposed.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (fn) => {
  const handler = (_e, v) => fn(v);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("ck", {
  // workspace
  getWorkspace: () => ipcRenderer.invoke("app:get-workspace"),
  pickWorkspace: () => ipcRenderer.invoke("app:pick-workspace"),
  onWorkspace: on("app:workspace"),

  // file system (paths are workspace-relative, validated in the main process)
  list: (rel) => ipcRenderer.invoke("fs:list", rel),
  read: (rel) => ipcRenderer.invoke("fs:read", rel),
  write: (rel, content) => ipcRenderer.invoke("fs:write", rel, content),
  createFile: (rel) => ipcRenderer.invoke("fs:create-file", rel),
  createDir: (rel) => ipcRenderer.invoke("fs:create-dir", rel),
  rename: (from, to) => ipcRenderer.invoke("fs:rename", from, to),
  remove: (rel) => ipcRenderer.invoke("fs:delete", rel),
  reveal: (rel) => ipcRenderer.invoke("fs:reveal", rel),
  onFsChanged: on("fs:changed"),

  // AI assistant panel (BrowserView)
  setAiBounds: (b) => ipcRenderer.send("ai:bounds", b),
  aiNavigate: (url) => ipcRenderer.invoke("ai:navigate", url),
  aiGetUrl: () => ipcRenderer.invoke("ai:get-url"),
  aiBack: () => ipcRenderer.invoke("ai:back"),
  aiForward: () => ipcRenderer.invoke("ai:forward"),
  aiReload: () => ipcRenderer.invoke("ai:reload"),
  onAiUrl: on("ai:url"),

  // bridge
  restartBridge: () => ipcRenderer.invoke("app:restart-bridge"),
  bridgeStatus: () => ipcRenderer.invoke("app:bridge-status"),
  onBridgeStatus: on("app:bridge-status"),

  // editor tools: main asks, renderer answers by request id
  onEditorRequest: on("editor:request"),
  editorRespond: (id, res) => ipcRenderer.send("editor:response", id, res),

  // terminal panel (user-typed commands)
  termRun: (cmd) => ipcRenderer.invoke("term:run", cmd),
  termKill: () => ipcRenderer.invoke("term:kill"),
  onTermData: on("term:data"),
  onTermExit: on("term:exit"),

  // menu actions (save, new-file, toggle-ai, ...)
  onMenuAction: on("menu:action"),
});
