/**
 * Optional CORS relay for remote MCP servers.
 *
 * Some MCP endpoints do not send `Access-Control-Allow-Origin`, so a browser
 * cannot call them directly. This function forwards a single JSON-RPC request to
 * a host you explicitly allow — it is not an open proxy.
 *
 *   MCP_ALLOWED_HOSTS = "mcp.example.com,api.linear.app"
 *
 * The browser calls `/api/mcp?url=https://mcp.example.com/mcp` with the MCP
 * headers and body it would have sent. Nothing is cached; nothing is logged.
 */
const METHODS = ['POST', 'GET', 'DELETE', 'OPTIONS'];

function allowedHosts(env) {
  return String(env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': METHODS.join(', '),
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Content-Type',
  'Access-Control-Max-Age': '86400',
});

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  const target = url.searchParams.get('url') || request.headers.get('X-Mcp-Target');
  if (!target) return new Response(JSON.stringify({ error: 'missing ?url=' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid url' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  }
  if (parsed.protocol !== 'https:') {
    return new Response(JSON.stringify({ error: 'https only' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  }
  const allowed = allowedHosts(env);
  if (!allowed.includes(parsed.host.toLowerCase())) {
    return new Response(
      JSON.stringify({
        error: `host ${parsed.host} is not allowed`,
        hint: 'Add it to MCP_ALLOWED_HOSTS (comma separated) in the Pages project environment variables.',
        allowed,
      }),
      { status: 403, headers: { 'Content-Type': 'application/json', ...cors(origin) } },
    );
  }

  const headers = new Headers();
  for (const name of ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(parsed.toString(), {
    method: request.method,
    headers,
    body: ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.arrayBuffer() : undefined,
    redirect: 'follow',
  });

  const responseHeaders = new Headers(cors(origin));
  for (const name of ['Content-Type', 'Mcp-Session-Id', 'Cache-Control']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
