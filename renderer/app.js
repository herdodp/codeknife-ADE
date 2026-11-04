// SPDX-License-Identifier: GPL-3.0-or-later
// Codeknife UI: workspace tree, Monaco editor with tabs, AI panel bounds, realtime sync.
(function () {
  const $ = (id) => document.getElementById(id);
  const ck = window.ck;

  const LANG_BY_EXT = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less", md: "markdown",
    py: "python", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    go: "go", rs: "rust", php: "php", rb: "ruby", swift: "swift", kt: "kotlin", sh: "shell", bat: "bat",
    ps1: "powershell", sql: "sql", xml: "xml", yml: "yaml", yaml: "yaml", lua: "lua", dart: "dart",
    vue: "html", svelte: "html", ini: "ini", toml: "ini", r: "r", pl: "perl", scala: "scala", dockerfile: "dockerfile",
  };
  function langOf(p) {
    const name = p.split("/").pop().toLowerCase();
    if (name === "dockerfile") return "dockerfile";
    const ext = name.includes(".") ? name.split(".").pop() : "";
    return LANG_BY_EXT[ext] || "plaintext";
  }

  // ------------------------------------------------------------ state
  let monacoRef = null, editor = null;
  const tabs = new Map(); // path -> { model, saved, mtime, dirty }
  let activePath = null;
  let diffEditor = null, diffOriginal = null; // review diff view
  const expanded = new Set();
  const dirCache = new Map();
  let selectedNode = "";
  let workspace = "";

  // ------------------------------------------------------------ tree
  async function loadDir(rel) {
    const r = await ck.list(rel);
    if (!r.ok) { dirCache.set(rel, []); return []; }
    dirCache.set(rel, r.items);
    return r.items;
  }

  async function renderTree() {
    const root = $("tree");
    root.textContent = "";
    if (!workspace) {
      const d = document.createElement("div");
      d.className = "node";
      d.textContent = "No folder open. Press Ctrl+O.";
      root.appendChild(d);
      return;
    }
    await renderDir("", root, 0);
  }

  async function renderDir(rel, container, depth) {
    const items = dirCache.has(rel) ? dirCache.get(rel) : await loadDir(rel);
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "node" + (it.dir ? " dir" : "") + (it.path === activePath ? " active" : "");
      if (tabs.has(it.path) && tabs.get(it.path).dirty) row.classList.add("modified");
      row.style.paddingLeft = 6 + depth * 12 + "px";
      const tw = document.createElement("span");
      tw.className = "twisty";
      tw.textContent = it.dir ? (expanded.has(it.path) ? "\u25BC" : "\u25B6") : "";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = it.name;
      row.append(tw, label);
      row.dataset.path = it.path;
      row.dataset.dir = it.dir ? "1" : "";
      row.addEventListener("click", async () => {
        selectedNode = it.path;
        if (it.dir) {
          if (expanded.has(it.path)) expanded.delete(it.path); else { expanded.add(it.path); await loadDir(it.path); }
          renderTree();
        } else openFile(it.path);
      });
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); selectedNode = it.path; showContext(e.clientX, e.clientY, it); });
      container.appendChild(row);
      if (it.dir && expanded.has(it.path)) await renderDir(it.path, container, depth + 1);
    }
  }

  function parentOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
  function targetDir() {
    if (!selectedNode) return "";
    const parent = dirCache.get(parentOf(selectedNode));
    const hit = parent && parent.find((x) => x.path === selectedNode);
    return hit && hit.dir ? selectedNode : parentOf(selectedNode);
  }

  // ------------------------------------------------------------ context menu / inline input
  let ctxEl = null;
  function hideContext() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  document.addEventListener("click", hideContext);
  function showContext(x, y, it) {
    hideContext();
    ctxEl = document.createElement("div");
    ctxEl.className = "ctx";
    ctxEl.style.left = x + "px"; ctxEl.style.top = y + "px";
    const entries = [
      ["New File", () => promptCreate("file")],
      ["New Folder", () => promptCreate("dir")],
      ["Rename", () => promptRename(it)],
      ["Delete (to Recycle Bin)", () => removePath(it)],
      ["Reveal in Explorer", () => ck.reveal(it.path)],
    ];
    for (const [label, fn] of entries) {
      const d = document.createElement("div");
      d.textContent = label;
      d.addEventListener("click", () => { hideContext(); fn(); });
      ctxEl.appendChild(d);
    }
    document.body.appendChild(ctxEl);
  }

  function askName(initial, title) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "ctx";
      wrap.style.left = "270px"; wrap.style.top = "60px"; wrap.style.padding = "8px";
      const lab = document.createElement("div");
      lab.textContent = title; lab.style.padding = "0 0 6px"; lab.style.cursor = "default";
      const inp = document.createElement("input");
      inp.className = "rename-input"; inp.value = initial || ""; inp.style.width = "240px";
      wrap.append(lab, inp);
      document.body.appendChild(wrap);
      inp.focus(); inp.select();
      const done = (v) => { wrap.remove(); resolve(v); };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(inp.value.trim());
        else if (e.key === "Escape") done(null);
      });
      inp.addEventListener("blur", () => done(null));
    });
  }

  async function promptCreate(kind) {
    if (!workspace) return;
    const base = targetDir();
    const name = await askName("", kind === "file" ? "New file name" : "New folder name");
    if (!name) return;
    const rel = base ? base + "/" + name : name;
    const r = kind === "file" ? await ck.createFile(rel) : await ck.createDir(rel);
    if (!r.ok) { alert(r.error); return; }
    if (base) expanded.add(base);
    await refreshAll();
    if (kind === "file") openFile(rel);
  }
  async function promptRename(it) {
    const name = await askName(it.name, "Rename");
    if (!name || name === it.name) return;
    const to = parentOf(it.path) ? parentOf(it.path) + "/" + name : name;
    const r = await ck.rename(it.path, to);
    if (!r.ok) { alert(r.error); return; }
    if (tabs.has(it.path)) closeTab(it.path, true);
    await refreshAll();
  }
  async function removePath(it) {
    if (!confirm("Move \"" + it.name + "\" to the Recycle Bin?")) return;
    const r = await ck.remove(it.path);
    if (!r.ok) { alert(r.error); return; }
    for (const p of [...tabs.keys()]) if (p === it.path || p.startsWith(it.path + "/")) closeTab(p, true);
    await refreshAll();
  }

  async function refreshAll() {
    for (const p of ["", ...expanded]) await loadDir(p);
    await renderTree();
  }

  // ------------------------------------------------------------ editor + tabs
  function renderTabs() {
    const bar = $("tabs");
    bar.textContent = "";
    for (const [p, t] of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (p === activePath ? " active" : "") + (t.dirty ? " dirty" : "") + (t.externalChange ? " conflict" : "");
      const name = document.createElement("span"); name.textContent = p.split("/").pop(); name.title = p;
      const dot = document.createElement("span"); dot.className = "dot"; dot.textContent = "\u25CF";
      const close = document.createElement("button"); close.className = "close"; close.textContent = "\u00D7";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(p); });
      const warn = document.createElement("span"); warn.className = "warn"; warn.textContent = "\u26A0"; warn.title = "File changed on disk (by AI or another program). Your unsaved edits were kept. Use the bar above the editor: Diff, Keep mine, or Use disk.";
      el.append(name, warn, dot, close);
      el.addEventListener("click", () => activate(p));
      bar.appendChild(el);
    }
    $("welcome").classList.toggle("hidden", tabs.size > 0);
    updateReview();
  }

  function activate(p) {
    const t = tabs.get(p);
    if (!t || !editor) return;
    hideDiff();
    activePath = p;
    editor.setModel(t.model);
    editor.focus();
    $("st-file").textContent = p;
    $("st-lang").textContent = t.model.getLanguageId();
    renderTabs();
    renderTree();
  }

  async function openFile(p) {
    if (tabs.has(p)) { activate(p); return; }
    const r = await ck.read(p);
    if (!r.ok) { alert(r.error); return; }
    const uri = monacoRef.Uri.file("/" + p);
    const model = monacoRef.editor.getModel(uri) || monacoRef.editor.createModel(r.content, langOf(p), uri);
    const t = { model, saved: r.content, mtime: r.mtime, dirty: false };
    model.onDidChangeContent(() => {
      t.dirty = model.getValue() !== t.saved;
      renderTabs();
      renderTree();
      if (t.dirty) scheduleAutosave(p);
    });
    tabs.set(p, t);
    activate(p);
  }

  async function saveTab(p) {
    const t = tabs.get(p);
    if (!t) return;
    if (t.externalChange) { if (p !== activePath) activate(p); updateReview(); return; } // resolve via the review bar (Diff / Keep mine / Use disk)
    const content = t.model.getValue();
    const r = await ck.write(p, content);
    if (!r.ok) { alert(r.error); return; }
    t.saved = content; t.mtime = r.mtime; t.dirty = false; t.externalChange = false;
    renderTabs(); renderTree();
  }

  function closeTab(p, force) {
    const t = tabs.get(p);
    if (!t) return;
    if (!force && t.dirty && !confirm(p + " has unsaved changes. Close anyway?")) return;
    hideDiff();
    t.model.dispose();
    tabs.delete(p);
    if (activePath === p) {
      activePath = null;
      const next = [...tabs.keys()].pop();
      if (next) activate(next);
      else { editor.setModel(null); $("st-file").textContent = ""; $("st-lang").textContent = ""; $("st-pos").textContent = ""; }
    }
    renderTabs(); renderTree();
  }

  // ------------------------------------------------------------ realtime sync
  // Replace only the differing middle part so cursor, selection and scroll outside the change stay put.
  function applyExternal(model, text) {
    const old = model.getValue();
    if (old === text) return;
    let s = 0;
    const max = Math.min(old.length, text.length);
    while (s < max && old.charCodeAt(s) === text.charCodeAt(s)) s++;
    let eo = old.length, et = text.length;
    while (eo > s && et > s && old.charCodeAt(eo - 1) === text.charCodeAt(et - 1)) { eo--; et--; }
    const a = model.getPositionAt(s), b = model.getPositionAt(eo);
    model.pushEditOperations([], [{ range: new monacoRef.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: text.slice(s, et) }], () => null);
  }

  let syncTimer = null;
  const changedQueue = new Set();
  ck.onFsChanged((files) => {
    for (const f of files) changedQueue.add(f);
    if (syncTimer) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      const batch = [...changedQueue]; changedQueue.clear();
      for (const f of batch) {
        const t = tabs.get(f);
        if (!t) continue;
        const r = await ck.read(f);
        if (!r.ok) continue; // deleted or unreadable: keep the buffer
        if (r.content === t.saved) { if (t.externalChange) { t.externalChange = false; renderTabs(); } continue; } // our own save, or no real change
        if (t.dirty) { t.externalChange = true; renderTabs(); continue; } // never overwrite unsaved edits
        t.saved = r.content; t.mtime = r.mtime;
        applyExternal(t.model, r.content);
        t.dirty = false;
        renderTabs();
      }
      refreshAll();
    }, 150);
  });

  // ------------------------------------------------------------ editor tools (answered for the bridge)
  async function tabForEdit(a) {
    const p = a.path ? String(a.path).replace(/\\/g, "/").replace(/^\.?\//, "") : activePath;
    if (!p) throw new Error("path is required (no active tab).");
    if (!tabs.has(p)) await openFile(p);
    const t = tabs.get(p);
    if (!t) throw new Error("Could not open file: " + p);
    return { p, t };
  }
  // ---- terminal panel (simple command runner, not a full PTY)
  const termHistory = [];
  let termHistIdx = 0, termRunning = false;
  function termAppend(text) {
    const out = $("term-out");
    out.textContent += text;
    if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000);
    out.scrollTop = out.scrollHeight;
  }
  function termSetRunning(v) {
    termRunning = v;
    $("term-input").disabled = v;
    $("term-stop").disabled = !v;
    $("term-prompt").textContent = v ? "\u2026" : ">";
    if (!v && !$("term-panel").classList.contains("hidden")) $("term-input").focus();
  }
  function toggleTerm(force) {
    const panel = $("term-panel");
    const show = typeof force === "boolean" ? force : panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !show);
    if (show) $("term-input").focus(); else if (editor) editor.focus();
  }
  async function termSubmit() {
    const input = $("term-input");
    const cmd = input.value.trim();
    if (!cmd || termRunning) return;
    if (!workspace) { termAppend("No folder is open.\n"); return; }
    if (termHistory[termHistory.length - 1] !== cmd) termHistory.push(cmd);
    termHistIdx = termHistory.length;
    input.value = "";
    termAppend("> " + cmd + "\n");
    termSetRunning(true);
    const r = await ck.termRun(cmd);
    if (!r.ok) { termAppend("[error] " + r.error + "\n"); termSetRunning(false); }
  }
  $("term-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); termSubmit(); }
    else if (e.key === "ArrowUp" && termHistory.length) { e.preventDefault(); termHistIdx = Math.max(0, termHistIdx - 1); e.target.value = termHistory[termHistIdx] || ""; }
    else if (e.key === "ArrowDown" && termHistory.length) { e.preventDefault(); termHistIdx = Math.min(termHistory.length, termHistIdx + 1); e.target.value = termHistory[termHistIdx] || ""; }
    else if (e.key === "Escape") toggleTerm(false);
  });
  $("term-stop").addEventListener("click", () => ck.termKill());
  $("term-clear").addEventListener("click", () => { $("term-out").textContent = ""; });
  $("term-close").addEventListener("click", () => toggleTerm(false));
  ck.onTermData(termAppend);
  ck.onTermExit((code) => { termAppend("\n[exit " + code + "]\n"); termSetRunning(false); });
  termSetRunning(false);

  // ---- autosave (skips tabs under AI review or in conflict)
  let autosave = false;
  try { autosave = localStorage.getItem("ck.autosave") === "1"; } catch {}
  const autosaveTimers = new Map();
  function renderAutosave() { $("st-autosave").textContent = "Autosave: " + (autosave ? "on" : "off"); }
  function scheduleAutosave(p) {
    if (!autosave) return;
    clearTimeout(autosaveTimers.get(p));
    autosaveTimers.set(p, setTimeout(() => {
      autosaveTimers.delete(p);
      const t = tabs.get(p);
      if (!autosave || !t || !t.dirty || t.review || t.externalChange) return;
      saveTab(p);
    }, 1000));
  }
  $("st-autosave").addEventListener("click", () => {
    autosave = !autosave;
    try { localStorage.setItem("ck.autosave", autosave ? "1" : "0"); } catch {}
    renderAutosave();
    if (autosave) for (const [p, t] of tabs) if (t.dirty) scheduleAutosave(p);
  });
  renderAutosave();

  // ---- review (Accept / Reject / Diff) of AI edits made in the buffer
  function hideDiff() {
    if (!diffOriginal && $("diff-host").classList.contains("hidden")) return;
    if (diffEditor) { try { diffEditor.setModel(null); } catch {} }
    if (diffOriginal) { diffOriginal.dispose(); diffOriginal = null; }
    $("diff-host").classList.add("hidden");
    $("editor").style.display = "";
  }
  function showDiff(t, baseText) {
    if (!diffEditor) diffEditor = monacoRef.editor.createDiffEditor($("diff-host"), { automaticLayout: true, renderSideBySide: true, originalEditable: false, theme: "vs-dark" });
    diffOriginal = monacoRef.editor.createModel(baseText, t.model.getLanguageId());
    diffEditor.setModel({ original: diffOriginal, modified: t.model });
    $("editor").style.display = "none";
    $("diff-host").classList.remove("hidden");
  }
  function updateReview() {
    const t = activePath ? tabs.get(activePath) : null;
    const bar = $("review-bar");
    if (!t || (!t.review && !t.externalChange)) { bar.classList.add("hidden"); hideDiff(); return; }
    bar.classList.remove("hidden");
    const conflict = !t.review;
    $("review-msg").textContent = conflict
      ? activePath + " changed on disk while you have unsaved edits. Diff shows disk (left) vs your editor (right)."
      : "AI edited " + activePath + " in the editor. Review the changes (Accept keeps, Reject reverts).";
    $("rv-accept").textContent = conflict ? "Keep mine" : "Accept";
    $("rv-reject").textContent = conflict ? "Use disk" : "Reject";
    $("rv-accept").title = conflict ? "Overwrite the file on disk with your editor content" : "Keep the AI changes";
    $("rv-reject").title = conflict ? "Discard your unsaved edits and load the disk version" : "Revert to the version before the AI edits";
    $("rv-diff").textContent = diffOriginal ? "Editor" : "Diff";
  }
  async function keepMine() {
    const p = activePath, t = p && tabs.get(p);
    if (!t) return;
    const content = t.model.getValue();
    const r = await ck.write(p, content);
    if (!r.ok) { alert(r.error); return; }
    hideDiff();
    t.saved = content; t.mtime = r.mtime; t.dirty = false; t.externalChange = false;
    renderTabs(); renderTree();
  }
  async function useDisk() {
    const p = activePath, t = p && tabs.get(p);
    if (!t) return;
    const d = await ck.read(p);
    if (!d.ok) { alert(d.error); return; }
    hideDiff();
    t.saved = d.content; t.mtime = d.mtime; t.externalChange = false; t.review = null;
    t.model.pushStackElement();
    applyExternal(t.model, d.content);
    t.model.pushStackElement();
    t.dirty = t.model.getValue() !== t.saved;
    renderTabs(); renderTree();
  }
  function acceptReview() {
    const t = activePath && tabs.get(activePath);
    if (!t) return;
    if (!t.review && t.externalChange) { keepMine(); return; }
    t.review = null; updateReview();
    if (t.dirty) scheduleAutosave(activePath);
  }
  function rejectReview() {
    const t = activePath && tabs.get(activePath);
    if (t && !t.review && t.externalChange) { useDisk(); return; }
    if (!t || !t.review) return;
    const base = t.review.base;
    hideDiff();
    t.model.pushStackElement();
    t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: base }], () => null);
    t.model.pushStackElement();
    t.review = null;
    renderTabs(); renderTree();
  }
  async function toggleDiff() {
    const t = activePath && tabs.get(activePath);
    if (!t || (!t.review && !t.externalChange)) return;
    if (diffOriginal) hideDiff();
    else if (t.review) showDiff(t, t.review.base);
    else {
      const d = await ck.read(activePath);
      if (!d.ok) { alert(d.error); return; }
      showDiff(t, d.content);
    }
    updateReview();
  }
  $("rv-accept").addEventListener("click", acceptReview);
  $("rv-reject").addEventListener("click", rejectReview);
  $("rv-diff").addEventListener("click", toggleDiff);

  // One undo step per AI edit: Ctrl+Z in the editor reverts it.
  function applyBufferEdits(p, t, ops) {
    if (!t.review) t.review = { base: t.model.getValue() };
    t.model.pushStackElement();
    t.model.pushEditOperations([], ops, () => null);
    t.model.pushStackElement();
    if (p !== activePath) activate(p);
    updateReview();
  }

  async function editorOp(op, a) {
    switch (op) {
      case "open": {
        if (typeof a.path !== "string" || !a.path) throw new Error("path is required.");
        const p = a.path.replace(/\\/g, "/").replace(/^\.?\//, "");
        await openFile(p);
        if (!tabs.has(p)) throw new Error("Could not open file: " + p);
        const line = Number(a.line);
        if (Number.isFinite(line) && line >= 1) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
        return { opened: p, line: Number.isFinite(line) && line >= 1 ? line : null };
      }
      case "get_active": {
        if (!activePath) return { active: null };
        const t = tabs.get(activePath);
        const pos = editor.getPosition();
        const sel = editor.getSelection();
        return {
          path: activePath, language: t.model.getLanguageId(), dirty: t.dirty,
          cursor: pos ? { line: pos.lineNumber, column: pos.column } : null,
          selection: sel && !sel.isEmpty() ? { text: t.model.getValueInRange(sel).slice(0, 20000), startLine: sel.startLineNumber, endLine: sel.endLineNumber } : null,
          lineCount: t.model.getLineCount(),
        };
      }
      case "list_tabs":
        return { active: activePath, tabs: [...tabs].map(([p, t]) => ({ path: p, dirty: t.dirty })) };
      case "get_buffer": {
        const p = a.path ? String(a.path).replace(/\\/g, "/").replace(/^\.?\//, "") : activePath;
        if (!p) throw new Error("No active tab.");
        const t = tabs.get(p);
        if (!t) throw new Error("File is not open in a tab: " + p);
        const total = t.model.getLineCount();
        const s = Number.isFinite(Number(a.start_line)) && Number(a.start_line) >= 1 ? Math.min(Number(a.start_line), total) : 1;
        const e = Number.isFinite(Number(a.end_line)) && Number(a.end_line) >= s ? Math.min(Number(a.end_line), total) : total;
        const range = new monacoRef.Range(s, 1, e, t.model.getLineMaxColumn(e));
        let text = t.model.getValueInRange(range);
        let truncated = false;
        if (text.length > 200000) { text = text.slice(0, 200000); truncated = true; }
        return { path: p, dirty: t.dirty, externalChange: !!t.externalChange, startLine: s, endLine: e, lineCount: total, truncated, text };
      }
      case "get_diagnostics": {
        const sev = { 8: "error", 4: "warning", 2: "info", 1: "hint" };
        const paths = a.path ? [String(a.path).replace(/\\/g, "/").replace(/^\.?\//, "")] : [...tabs.keys()];
        const out = [];
        for (const p of paths) {
          const t = tabs.get(p);
          if (!t) { if (a.path) throw new Error("File is not open in a tab: " + p); continue; }
          for (const m of monacoRef.editor.getModelMarkers({ resource: t.model.uri })) {
            out.push({ path: p, severity: sev[m.severity] || String(m.severity), line: m.startLineNumber, column: m.startColumn, endLine: m.endLineNumber, endColumn: m.endColumn, message: m.message, source: m.source || null, code: m.code && typeof m.code === "object" ? m.code.value : (m.code || null) });
          }
        }
        return { count: out.length, diagnostics: out.slice(0, 500) };
      }
      case "save": {
        const { p, t } = await tabForEdit(a);
        await saveTab(p);
        return { path: p, saved: !t.dirty, dirty: t.dirty, externalChange: !!t.externalChange, note: t.dirty ? "Not saved (write failed or the user cancelled the overwrite prompt)." : "Saved to disk." };
      }
      case "replace_text": {
        const { p, t } = await tabForEdit(a);
        if (typeof a.old_text !== "string" || !a.old_text) throw new Error("old_text is required.");
        if (typeof a.new_text !== "string") throw new Error("new_text is required.");
        const eol = t.model.getEOL();
        const norm = (s) => s.replace(/\r\n|\r|\n/g, eol);
        const oldT = norm(a.old_text), newT = norm(a.new_text);
        const value = t.model.getValue();
        const hits = [];
        for (let i = value.indexOf(oldT); i >= 0; i = value.indexOf(oldT, i + oldT.length)) hits.push(i);
        if (!hits.length) throw new Error("old_text not found in the editor buffer of " + p + ".");
        if (hits.length > 1 && !a.replace_all) throw new Error("old_text matches " + hits.length + " places; make it unique or set replace_all.");
        const ops = hits.map((i) => {
          const s = t.model.getPositionAt(i), e = t.model.getPositionAt(i + oldT.length);
          return { range: new monacoRef.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: newT };
        });
        applyBufferEdits(p, t, ops);
        editor.revealLineInCenter(ops[0].range.startLineNumber);
        return { path: p, replaced: ops.length, dirty: t.dirty, savedToDisk: false, note: "Edited in the editor buffer only; not on disk until saved (Ctrl+S)." };
      }
      case "replace_lines": {
        const { p, t } = await tabForEdit(a);
        if (typeof a.text !== "string") throw new Error("text is required.");
        const total = t.model.getLineCount();
        const s = Number(a.start_line), e = Number(a.end_line);
        if (!Number.isInteger(s) || !Number.isInteger(e)) throw new Error("start_line and end_line must be integers.");
        if (s < 1 || s > total + 1) throw new Error("start_line out of range (1-" + (total + 1) + ").");
        if (e < s - 1 || e > total) throw new Error("end_line must be between start_line-1 (insert) and " + total + ".");
        const eol = t.model.getEOL();
        const text = a.text.replace(/\r\n|\r|\n/g, eol);
        let range, out = text;
        if (e >= s) range = new monacoRef.Range(s, 1, e, t.model.getLineMaxColumn(e));
        else if (s === total + 1) { range = new monacoRef.Range(total, t.model.getLineMaxColumn(total), total, t.model.getLineMaxColumn(total)); out = eol + text; }
        else { range = new monacoRef.Range(s, 1, s, 1); out = text + eol; }
        applyBufferEdits(p, t, [{ range, text: out }]);
        editor.revealLineInCenter(Math.min(s, t.model.getLineCount()));
        return { path: p, startLine: s, endLine: e, lineCount: t.model.getLineCount(), dirty: t.dirty, savedToDisk: false, note: "Edited in the editor buffer only; not on disk until saved (Ctrl+S)." };
      }
      default:
        throw new Error("Unknown editor operation: " + op);
    }
  }
  ck.onEditorRequest(async ({ id, op, args }) => {
    try { ck.editorRespond(id, { ok: true, data: await editorOp(op, args || {}) }); }
    catch (e) { ck.editorRespond(id, { ok: false, error: String((e && e.message) || e) }); }
  });

  // ------------------------------------------------------------ AI panel geometry
  function sendAiBounds() {
    const host = $("ai-host");
    if (document.body.classList.contains("ai-hidden")) { ck.setAiBounds({ x: 0, y: 0, width: 0, height: 0 }); return; }
    const r = host.getBoundingClientRect();
    ck.setAiBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  new ResizeObserver(sendAiBounds).observe($("ai-host"));
  window.addEventListener("resize", sendAiBounds);

  function makeSplitter(id, target, side) {
    const el = $(id);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el.classList.add("drag"); document.body.classList.add("resizing");
      const startX = e.clientX, startW = $(target).getBoundingClientRect().width;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const w = side === "left" ? startW + dx : startW - dx;
        $(target).style.width = Math.max(140, Math.min(900, w)) + "px";
        sendAiBounds();
      };
      const up = () => {
        el.classList.remove("drag"); document.body.classList.remove("resizing");
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
        sendAiBounds();
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    });
  }
  makeSplitter("split-left", "explorer", "left");
  makeSplitter("split-right", "ai-pane", "right");

  // ------------------------------------------------------------ workspace + buttons
  function setWorkspace(p) {
    workspace = p || "";
    $("ws-name").textContent = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop().toUpperCase() : "EXPLORER";
    for (const p2 of [...tabs.keys()]) closeTab(p2, true);
    expanded.clear(); dirCache.clear(); selectedNode = "";
    renderTree();
  }
  ck.onWorkspace(setWorkspace);

  $("btn-open").addEventListener("click", () => ck.pickWorkspace());
  $("btn-new-file").addEventListener("click", () => promptCreate("file"));
  $("btn-new-folder").addEventListener("click", () => promptCreate("dir"));
  $("btn-refresh").addEventListener("click", refreshAll);
  $("ai-back").addEventListener("click", () => ck.aiBack());
  $("ai-fwd").addEventListener("click", () => ck.aiForward());
  $("ai-reload").addEventListener("click", () => ck.aiReload());

  // URL bar for the AI panel
  let aiCurrentUrl = "";
  const aiUrlInput = $("ai-url");
  ck.onAiUrl((url) => {
    aiCurrentUrl = String(url || "");
    if (document.activeElement !== aiUrlInput) aiUrlInput.value = aiCurrentUrl;
  });
  aiUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      let v = aiUrlInput.value.trim();
      if (!v) return;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v;
      if (!/^https?:\/\//i.test(v)) return;
      ck.aiNavigate(v);
      aiUrlInput.blur();
    } else if (e.key === "Escape") {
      aiUrlInput.value = aiCurrentUrl;
      aiUrlInput.blur();
    }
  });
  ck.aiGetUrl().then((u) => { if (u && !aiCurrentUrl) { aiCurrentUrl = String(u); if (document.activeElement !== aiUrlInput) aiUrlInput.value = aiCurrentUrl; } }).catch(() => {});
  aiUrlInput.addEventListener("focus", () => aiUrlInput.select());
  aiUrlInput.addEventListener("blur", () => { aiUrlInput.value = aiCurrentUrl; });

  function setBridge(s) {
    const el = $("st-bridge");
    el.textContent = s.alive ? "Bridge: connected (" + s.tools + " tools)" : "Bridge: offline";
    $("status").classList.toggle("offline", !s.alive);
  }
  ck.onBridgeStatus(setBridge);
  ck.bridgeStatus().then(setBridge);

  ck.onMenuAction(async (a) => {
    switch (a) {
      case "new-file": return promptCreate("file");
      case "new-folder": return promptCreate("dir");
      case "save": return activePath && saveTab(activePath);
      case "save-all": for (const [p, t] of tabs) if (t.dirty) await saveTab(p); return;
      case "close-tab": return activePath && closeTab(activePath);
      case "undo": return editor && editor.trigger("menu", "undo");
      case "redo": return editor && editor.trigger("menu", "redo");
      case "find": return editor && editor.trigger("menu", "actions.find");
      case "replace": return editor && editor.trigger("menu", "editor.action.startFindReplace");
      case "palette": return editor && (editor.focus(), editor.trigger("menu", "editor.action.quickCommand"));
      case "toggle-explorer": document.body.classList.toggle("explorer-hidden"); return sendAiBounds();
      case "toggle-ai": document.body.classList.toggle("ai-hidden"); return sendAiBounds();
      case "toggle-terminal": return toggleTerm();
      case "restart-bridge": return ck.restartBridge();
    }
  });

  // ------------------------------------------------------------ Monaco bootstrap
  window.require.config({ paths: { vs: "../node_modules/monaco-editor/min/vs" } });
  window.require(["vs/editor/editor.main"], async () => {
    monacoRef = window.monaco;
    editor = monacoRef.editor.create($("editor"), {
      theme: "vs-dark", automaticLayout: true, fontSize: 14, minimap: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true, acceptSuggestionOnEnter: "on", tabCompletion: "on",
      parameterHints: { enabled: true }, formatOnPaste: true, bracketPairColorization: { enabled: true },
      wordBasedSuggestions: "allDocuments", scrollBeyondLastLine: false, smoothScrolling: true,
    });
    editor.onDidChangeCursorPosition((e) => { $("st-pos").textContent = "Ln " + e.position.lineNumber + ", Col " + e.position.column; });
    editor.addCommand(monacoRef.KeyMod.CtrlCmd | monacoRef.KeyCode.KeyS, () => activePath && saveTab(activePath));
    workspace = await ck.getWorkspace();
    setWorkspace(workspace);
    sendAiBounds();
  });
})();
