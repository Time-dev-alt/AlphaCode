/**
 * Minimal MCP (Model Context Protocol) stdio client.
 *
 * Claude Code users configure MCP servers in JSON; we do the same:
 *   ALPHACODE_MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]'
 * or `data/mcp.json` with `{ "mcpServers": { "name": { "command": "...", "args": [] } } }`.
 *
 * Only the parts the harness needs are implemented: initialize → tools/list →
 * tools/call, with newline-delimited JSON-RPC 2.0 over stdin/stdout. Servers
 * that fail to start are skipped with a notice; one bad server can never take a
 * run down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

let cache = null; // { signature, tools, clients }

/** Read MCP configuration from the environment or data/mcp.json. */
export function mcpConfig() {
  const raw = process.env.ALPHACODE_MCP_SERVERS;
  const servers = [];
  const push = (name, spec) => {
    if (!spec || typeof spec !== 'object' || !spec.command) return;
    servers.push({
      name: String(name || servers.length),
      command: String(spec.command),
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      env: spec.env && typeof spec.env === 'object' ? spec.env : {},
      cwd: spec.cwd ? String(spec.cwd) : '',
    });
  };
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.mcpServers ? Object.entries(parsed.mcpServers).map(([n, s]) => ({ name: n, ...s })) : [];
      for (const s of list) push(s.name, s);
    } catch (err) {
      log.warn(`ALPHACODE_MCP_SERVERS is not valid JSON: ${err.message}`);
    }
  } else {
    const file = path.join(config.dataDir, 'mcp.json');
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const map = parsed.mcpServers || parsed;
        for (const [name, spec] of Object.entries(map || {})) push(name, spec);
      }
    } catch (err) {
      log.warn(`data/mcp.json is unreadable: ${err.message}`);
    }
  }
  return servers;
}

class McpClient {
  constructor(spec) {
    this.spec = spec;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.child = null;
    this.stderr = '';
  }

  start() {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.spec.env };
      let child;
      try {
        // A configured cwd that no longer exists makes spawn() fail with an
        // unhelpful ENOENT on the *binary*; fall back to the process cwd.
        const desired = this.spec.cwd || config.workspaceRoot || process.cwd();
        const cwd = fs.existsSync(desired) ? desired : process.cwd();
        child = spawn(this.spec.command, this.spec.args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }
      this.child = child;
      const timer = setTimeout(() => reject(new Error(`${this.spec.name}: timed out starting ${this.spec.command}`)), CONNECT_TIMEOUT_MS);
      const done = (fn, arg) => {
        clearTimeout(timer);
        fn(arg);
      };
      child.on('error', (err) => done(reject, new Error(`${this.spec.name}: ${err.message}`)));
      child.stderr.on('data', (d) => {
        this.stderr = (this.stderr + d.toString()).slice(-4000);
      });
      child.on('exit', (code) => {
        for (const [, p] of this.pending) p.reject(new Error(`${this.spec.name} exited (${code})`));
        this.pending.clear();
      });
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
            else p.resolve(msg.result);
          }
        }
      });
      this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'alphacode', version: '2.0.0' },
      })
        .then((result) => {
          this.notify('notifications/initialized', {});
          done(resolve, result);
        })
        .catch((err) => done(reject, err));
    });
  }

  request(method, params) {
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin?.writable) return reject(new Error(`${this.spec.name}: server is not running`));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.spec.name}: ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.child.stdin.write(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {}
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} });
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .map((p) => {
        if (p?.type === 'text') return p.text;
        if (p?.type === 'resource') return p.resource?.text || `[resource ${p.resource?.uri || ''}]`;
        return `[${p?.type || 'content'}]`;
      })
      .join('\n')
      .trim();
    return { text: text || '(no output)', isError: Boolean(result?.isError) };
  }

  close() {
    try {
      this.child?.stdin?.end();
    } catch {}
    try {
      this.child?.kill('SIGTERM');
    } catch {}
  }
}

/** Wrap MCP tools in the harness tool shape. */
function toHarnessTool(client, serverName, tool) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: `[MCP ${serverName}] ${tool.description || tool.name}`,
    schema,
    readOnly: Boolean(tool.annotations?.readOnlyHint),
    mutating: !tool.annotations?.readOnlyHint,
    mcp: { server: serverName, tool: tool.name },
    async run(args) {
      const res = await client.callTool(tool.name, args);
      if (res.isError) throw new Error(res.text);
      return { content: res.text, display: { kind: 'mcp', server: serverName, tool: tool.name } };
    },
  };
}

/**
 * Connect every configured server once per process and return harness tools.
 * Never throws: unreachable servers are reported and skipped.
 */
export async function loadMcpTools({ force = false } = {}) {
  const servers = mcpConfig();
  const signature = JSON.stringify(servers);
  if (!servers.length) return [];
  if (!force && cache && cache.signature === signature) return cache.tools;

  if (cache) cache.clients.forEach((c) => c.close());
  const tools = [];
  const clients = [];
  for (const spec of servers) {
    const client = new McpClient(spec);
    try {
      await client.start();
      clients.push(client);
      const list = await client.listTools();
      for (const tool of list) tools.push(toHarnessTool(client, spec.name, tool));
      log.info(`MCP server "${spec.name}" ready (${list.length} tools)`);
    } catch (err) {
      client.close();
      log.warn(`MCP server "${spec.name}" unavailable: ${err.message}`);
    }
  }
  cache = { signature, tools, clients };
  return tools;
}

export function shutdownMcp() {
  if (cache) cache.clients.forEach((c) => c.close());
  cache = null;
}
