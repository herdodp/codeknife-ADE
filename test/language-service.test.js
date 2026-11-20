// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { LanguageServiceManager } = require("../src/language-service");

test("bundled Pyright opens, queries, and synchronizes a workspace document", { timeout: 60000 }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeknife-lsp-"));
  const manager = new LanguageServiceManager({
    app: { isPackaged: false, getVersion: () => "0.2.0" },
    log: () => {},
    onStatus: () => {},
    onDiagnostics: () => {},
  });
  t.after(async () => {
    await manager.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  await manager.setWorkspace(workspace);
  const opened = await manager.openDocument({
    path: "sample.py",
    languageId: "python",
    text: 'value = "hello"\nvalue\n',
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(manager.resolveUri(opened.uri), { ok: true, path: "sample.py" });
  assert.throws(() => manager.resolveUri("file:///C:/outside.py"), /outside the workspace/);

  const hover = await manager.request({
    languageId: "python",
    method: "textDocument/hover",
    params: {
      textDocument: { uri: opened.uri },
      position: { line: 1, character: 2 },
    },
  });
  assert.match(hover.contents.value, /value/);

  assert.deepEqual(await manager.changeDocument({
    path: "sample.py",
    languageId: "python",
    version: 2,
    text: 'value = "updated"\nvalue\n',
  }), { ok: true });
  assert.deepEqual(await manager.closeDocument({ path: "sample.py", languageId: "python" }), { ok: true });
  await assert.rejects(manager.openDocument({
    path: "../outside.py",
    languageId: "python",
    text: "",
  }), /outside the workspace/);
});
