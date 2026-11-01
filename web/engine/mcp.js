/**
 * MCP client for the browser — Streamable HTTP transport (the one remote
 * servers actually expose), with SSE responses and JSON-RPC batching handled.
 *
 * stdio servers cannot run in a tab (there is no process to spawn), but the
 * remote case is now the common one: Gemini, Claude, GitHub, Linear, Sentry and
 * friends all publish HTTP MCP endpoints. Tools are namespaced
 * `mcp__<server>__<tool>` exactly like the server edition, so the agent's
 * prompts do not care which runtime it is talking to.
 *
 * Auth is whatever the server wants: `Authorization: Bearer …` for a PAT, or an
 * OAuth token the user obtained through that server's own flow. Requests go
 * direct first; if the browser is blocked by CORS the optional relay in
 * `functions/api/mcp.js` forwards them (allowlisted by host).
 */

let requestId = 1;

const nextId = () => requestId++;

export class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/** Parse a text/event-stream body into JSON-RPC messages. */
async function readSse(response) {
  const text = await response.text();
  const messages = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* ignore keep-alives */
    }
  }
  return messages;
}

export class McpClient {
  /**
   * @param {object} config
   * @param {string} config.name
   * @param {string} config.url              Streamable HTTP endpoint
   * @param {object} [config.headers]        extra headers (Authorization, …)
   * @param {string} [config.relay]          optional CORS relay base, e.g. /api/mcp
   * @param {number} [config.timeoutMs]
   */
  constructor(config) {
    this.config = config;
    this.name = config.name || 'server';
    this.url = config.url;
    this.headers = config.headers || {};
    this.relay = config.relay || '';
    this.timeoutMs = config.timeoutMs || 30_000;
    this.sessionId = null;
    this.serverInfo = null;
    this.capabilities = {};
    this.connected = false;
    this.lastError = null;
  }

  endpoint() {
    return this.config.useRelay && this.relay ? `${this.relay}?url=${encodeURIComponent(this.url)}` : this.url;
  }

  async request(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.config.useRelay && this.relay) headers['X-Mcp-Target'] = this.url;
    let response;
    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        mode: 'cors',
      });
    } catch (err) {
      throw new McpError(
        `cannot reach ${this.name} at ${this.url}: ${err.message}. If the server does not allow browser requests (CORS), turn on “route through relay” in the MCP server settings.`,
        'network',
      );
    } finally {
      clearTimeout(timer);
    }
    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) this.sessionId = sessionHeader;

    if (response.status === 202) return null; // notification accepted
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new McpError(`${this.name} returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`, response.status);
    }
    const type = response.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const messages = await readSse(response);
      const wanted = new Set((Array.isArray(payload) ? payload : [payload]).map((p) => p.id));
      const hit = messages.find((m) => wanted.has(m.id));
      if (hit) return hit;
      if (messages.length) return messages[messages.length - 1];
      throw new McpError(`${this.name}: empty event stream`, 'empty');
    }
    const text = await response.text();
    if (!text) return null;
    const json = JSON.parse(text);
    return Array.isArray(json) ? json.find((m) => m.id === payload.id) ?? json[0] : json;
  }

  async connect() {
    const init = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: this.config.protocolVersion || '2025-06-18',
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: 'AlphaCode', version: '3.0.0' },
      },
    };
    const result = await this.request(init);
    if (result?.error) throw new McpError(`${this.name}: ${result.error.message}`, result.error.code);
    this.serverInfo = result?.result?.serverInfo || null;
    this.capabilities = result?.result?.capabilities || {};
    this.connected = true;
    // required by the spec, and some servers reject calls without it
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    return { serverInfo: this.serverInfo, capabilities: this.capabilities };
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request({
        jsonrpc: '2.0',
        id: nextId(),
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      });
      if (result?.error) throw new McpError(`${this.name}: ${result.error.message}`, result.error.code);
      tools.push(...(result?.result?.tools || []));
      cursor = result?.result?.nextCursor;
      if (!cursor) break;
    }
    return tools.map((tool) => ({
      name: `mcp__${sanitize(this.name)}__${sanitize(tool.name)}`,
      rawName: tool.name,
      title: tool.title || tool.annotations?.title || tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      server: this.name,
    }));
  }

  async callTool(rawName, args) {
    const result = await this.request({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: { name: rawName, arguments: args || {} },
    });
    if (result?.error) throw new McpError(`${this.name}: ${result.error.message}`, result.error.code);
    return result?.result || { content: [] };
  }

  async listResources() {
    const result = await this.request({ jsonrpc: '2.0', id: nextId(), method: 'resources/list', params: {} });
    return result?.result?.resources || [];
  }

  async readResource(uri) {
    const result = await this.request({ jsonrpc: '2.0', id: nextId(), method: 'resources/read', params: { uri } });
    return result?.result?.contents || [];
  }

  async listPrompts() {
    const result = await this.request({ jsonrpc: '2.0', id: nextId(), method: 'prompts/list', params: {} });
    return result?.result?.prompts || [];
  }

  async ping() {
    await this.request({ jsonrpc: '2.0', id: nextId(), method: 'ping' });
    return true;
  }
}

const sanitize = (text) => String(text).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

/** Flatten MCP tool content into text the model can read. */
export function contentToText(content = []) {
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return `[image ${part.mimeType || ''} ${part.data ? `${part.data.length} bytes base64` : ''}]`;
      if (part.type === 'resource') return `[resource ${part.resource?.uri || ''}]\n${part.resource?.text || ''}`;
      return JSON.stringify(part).slice(0, 2000);
    })
    .join('\n');
}

/**
 * Connect a set of configured servers, skipping (not failing) the broken ones.
 * @param {Array<object>} configs
 */
export async function connectAll(configs = [], { onLog = () => {} } = {}) {
  const clients = [];
  const errors = [];
  await Promise.all(
    configs
      .filter((config) => config.enabled !== false && config.url)
      .map(async (config) => {
        const client = new McpClient(config);
        try {
          const info = await client.connect();
          const tools = await client.listTools();
          clients.push({ client, tools, config });
          onLog(`mcp: ${config.name} connected (${tools.length} tools${info.serverInfo?.name ? `, ${info.serverInfo.name}` : ''})`);
        } catch (err) {
          client.lastError = err.message;
          errors.push({ server: config.name, error: err.message });
          onLog(`mcp: ${config.name} unavailable — ${err.message}`);
        }
      }),
  );
  return { clients, errors };
}

/** OpenAI-shaped tool definitions for the harness. */
export function toOpenAiMcpTools(entries) {
  return entries.flatMap(({ tools }) =>
    tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: `[${tool.server}] ${tool.description}`.slice(0, 1000),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
    })),
  );
}
