/**
 * MCP stdio client: handshake, tool discovery, invocation and failure handling,
 * exercised against a real JSON-RPC subprocess (tests/fixtures/mcp-server.mjs).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.ALPHACODE_MCP_SERVERS = JSON.stringify([
  {
    name: 'fixture',
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'fixtures', 'mcp-server.mjs')],
  },
  { name: 'broken', command: '/nonexistent/binary-that-does-not-exist', args: [] },
]);

const { loadMcpTools, shutdownMcp, mcpConfig } = await import('../src/agent/mcp.mjs');
const tools = await loadMcpTools();

after(() => shutdownMcp());

test('configuration is parsed from ALPHACODE_MCP_SERVERS', () => {
  const servers = mcpConfig();
  assert.equal(servers.length, 2);
  assert.equal(servers[0].name, 'fixture');
  assert.equal(servers[0].command, process.execPath);
  assert.ok(Array.isArray(servers[0].args));
});

test('discovers tools and namespaces them by server', () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['mcp__fixture__echo', 'mcp__fixture__fail']);
});

test('a broken server is skipped without breaking the rest', () => {
  assert.ok(tools.length >= 2, 'fixture tools still loaded');
});

test('tool metadata maps to the harness contract', () => {
  const echo = tools.find((t) => t.name === 'mcp__fixture__echo');
  assert.match(echo.description, /Echo back/);
  assert.equal(echo.schema.type, 'object');
  assert.equal(echo.readOnly, true, 'readOnlyHint is honoured');
  const fail = tools.find((t) => t.name === 'mcp__fixture__fail');
  assert.equal(fail.readOnly, false);
});

test('calls a tool over JSON-RPC and returns its text', async () => {
  const echo = tools.find((t) => t.name === 'mcp__fixture__echo');
  const res = await echo.run({ text: 'hello mcp' });
  assert.equal(res.content, 'echo:hello mcp');
  assert.deepEqual(res.display, { kind: 'mcp', server: 'fixture', tool: 'echo' });
});

test('tool errors surface as exceptions the agent can react to', async () => {
  const fail = tools.find((t) => t.name === 'mcp__fixture__fail');
  await assert.rejects(() => fail.run({}), /boom/);
});
