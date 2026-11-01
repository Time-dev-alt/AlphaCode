/**
 * GET /api/oauth/github/callback
 *
 * Exchanges the OAuth code for an access token and hands it to the opener
 * window via postMessage (same origin only). The token then lives in the
 * user's browser; this function keeps no state and writes no logs.
 *
 * Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) return page({ error: `GitHub returned: ${error}` }, 400);
  if (!code) return page({ error: 'Missing OAuth code.' }, 400);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return page({ error: 'GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).' }, 500);
  }

  let data;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/api/oauth/github/callback`,
      }),
    });
    data = await res.json();
  } catch (err) {
    return page({ error: `Could not reach GitHub: ${err.message}` }, 502);
  }

  if (!data.access_token) return page({ error: data.error_description || data.error || 'No access token returned.' }, 400);

  let login = '';
  try {
    const me = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'alphacode' },
    });
    if (me.ok) login = (await me.json()).login || '';
  } catch {
    /* login is cosmetic */
  }

  return page({ token: data.access_token, scope: data.scope || '', login });
}

function page(payload, status = 200) {
  const body = JSON.stringify({ type: 'alphacode:oauth', ...payload }).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><title>AlphaCode · GitHub</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}
 .card{max-width:460px}.ok{color:#4fd68b}.err{color:#f0646e}a{color:#63b3ff}
</style>
<div class="card"><h2>${payload.error ? 'GitHub connection failed' : 'GitHub connected'}</h2>
<p class="${payload.error ? 'err' : 'ok'}">${payload.error || `Signed in${payload.login ? ` as <b>${payload.login.replace(/[<>&]/g, '')}</b>` : ''}. Returning to AlphaCode…`}</p>
<p><a href="/" target="_blank" rel="noopener">Open AlphaCode</a></p></div>
<script>
 (function () {
   var payload = ${body};
   try { if (window.opener) window.opener.postMessage(payload, window.location.origin); } catch (e) {}
   ${payload.error ? '' : 'setTimeout(function(){ window.close(); }, 500);'}
 })();
</script>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
