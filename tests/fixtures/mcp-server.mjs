#!/usr/bin/env node
// Tiny MCP stdio server used by the tests: initialize, tools/list, tools/call.
let buffer = '';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const tools = [
  {
    name: 'echo',
    description: 'Echo back the provided text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail',
    description: 'Always fails',
    inputSchema: { type: 'object', properties: {} },
    annotations: {},
  },
];
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
    } else if (req.method === 'notifications/initialized') {
      // no response for notifications
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools } });
    } else if (req.method === 'tools/call') {
      const { name, arguments: args } = req.params;
      if (name === 'echo') send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `echo:${args?.text ?? ''}` }] } });
      else if (name === 'fail') send({ jsonrpc: '2.0', id: req.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
      else send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown tool ${name}` } });
    } else if (req.id !== undefined) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
