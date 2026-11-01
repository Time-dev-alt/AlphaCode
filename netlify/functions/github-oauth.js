/**
 * Netlify equivalent of the Cloudflare Pages OAuth functions.
 * Route: /api/oauth/github/start and /api/oauth/github/callback
 * (see the [[redirects]] rule in netlify.toml).
 *
 * Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 */
const page = (payload, status = 200) => {
  const body = JSON.stringify({ type: 'alphacode:oauth', ...payload }).replace(/</g, '\\u003c');
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    body: `<!doctype html><meta charset="utf-8"><title>AlphaCode · GitHub</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}a{color:#63b3ff}.ok{color:#4fd68b}.err{color:#f0646e}</style>
<div><h2>${payload.error ? 'GitHub connection failed' : 'GitHub connected'}</h2>
<p class="${payload.error ? 'err' : 'ok'}">${payload.error || 'Returning to AlphaCode…'}</p><p><a href="/" target="_blank" rel="noopener">Open AlphaCode</a></p></div>
<script>var p=${body};try{if(window.opener)window.opener.postMessage(p,location.origin)}catch(e){}
${payload.error ? '' : 'setTimeout(function(){window.close()},500)'}</script>`,
  };
};

export async function handler(event) {
  const url = new URL(event.rawUrl || `https://${event.headers.host}${event.path}`);
  const step = url.pathname.endsWith('/callback') ? 'callback' : 'start';
  const id = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;

  if (!id || !secret) {
    return page({ error: 'GitHub OAuth is not configured. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Netlify → Site settings → Environment variables, then redeploy. Instant previews work without it.' }, 500);
  }
  const redirectUri = `${url.origin}/api/oauth/github/callback`;

  if (step === 'start') {
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', id);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', url.searchParams.get('scope') || 'public_repo');
    return { statusCode: 302, headers: { Location: authorize.toString() }, body: '' };
  }

  const code = url.searchParams.get('code');
  if (!code) return page({ error: url.searchParams.get('error') || 'Missing OAuth code.' }, 400);
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, code, redirect_uri: redirectUri }),
  });
  const data = await res.json();
  if (!data.access_token) return page({ error: data.error_description || data.error || 'No access token.' }, 400);
  return page({ token: data.access_token, scope: data.scope || '' });
}
