const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BridgeCore } = require("../src/bridge-core");

const fakeServer = `
const readline = require("readline");
const input = readline.createInterface({ input: process.stdin });
let active = 0;
let peak = 0;
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "hold" }, { name: "large" }, { name: "crash" }] } });
  if (request.method === "tools/call" && request.params.name === "hold") {
    active += 1;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active -= 1;
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(peak) }] } });
    }, 60);
  }
  if (request.method === "tools/call" && request.params.name === "large") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "x".repeat(300000) }] } });
  }
  if (request.method === "tools/call" && request.params.name === "crash") process.exit(1);
});
`;

test("limits concurrent MCP calls, parses large responses, and restarts a failed server", async () => {
  const core = new BridgeCore();
  await core.start({
    fake: { command: process.execPath, args: ["-e", fakeServer] },
  });
  try {
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      core.callTool({ name: "hold", server: "fake", arguments: {}, timeout: 5000 })));
    assert.ok(results.every((result) => result.ok));
    assert.equal(Math.max(...results.map((result) => Number(result.text))), 32);

    const large = await core.callTool({
      name: "large", server: "fake", arguments: {}, timeout: 5000,
    });
    assert.equal(large.ok, true);
    assert.equal(large.text.length, 300000);
    assert.equal(core.mcpAlive(), true);

    const crashed = await core.callTool({
      name: "crash", server: "fake", arguments: {}, timeout: 5000,
    });
    assert.equal(crashed.ok, false);
    const deadline = Date.now() + 10000;
    while (!core.mcpAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(core.mcpAlive(), true);
  } finally {
    await core.stop();
  }
});
