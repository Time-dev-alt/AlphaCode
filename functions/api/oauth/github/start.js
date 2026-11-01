/**
 * GET /api/oauth/github/start
 *
 * Kicks off GitHub OAuth so the user can publish to their own repo *without
 * pasting a token*. The client secret never leaves this function.
 *
 * Required env (Pages → Settings → Environment variables):
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 * Optional:
 *   ALPHACODE_GITHUB_SCOPE  (default "public_repo" — "repo" for private repos)
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return popupPage(
      { error: 'GitHub OAuth is not configured on this deployment. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Pages → Settings → Environment variables, then redeploy. You can still use instant previews without an account.' },
      500,
    );
  }
  const redirectUri = `${url.origin}/api/oauth/github/callback`;
  const scope = String(url.searchParams.get('scope') || env.ALPHACODE_GITHUB_SCOPE || 'public_repo');
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', scope);
  authorize.searchParams.set('allow_signup', 'true');
  return Response.redirect(authorize.toString(), 302);
}

/** Shared HTML for the OAuth pop-up. Posts back to the opener and closes. */
function popupPage(payload, status = 200) {
  const body = JSON.stringify({ type: 'alphacode:oauth', ...payload });
  const html = `<!doctype html><meta charset="utf-8"><title>AlphaCode · GitHub</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}
 .card{max-width:460px}code{background:#151822;padding:2px 6px;border-radius:6px}
 .err{color:#f0646e}.ok{color:#4fd68b}a{color:#63b3ff}
</style>
<div class="card"><h2>${payload.error ? 'GitHub connection failed' : 'Connected'}</h2>
<p class="${payload.error ? 'err' : 'ok'}">${payload.error || 'Returning to AlphaCode…'}</p>
<p><a href="/" target="_blank" rel="noopener">Open AlphaCode</a></p></div>
<script>
 (function () {
   var payload = ${body};
   try { if (window.opener) window.opener.postMessage(payload, window.location.origin); } catch (e) {}
   ${payload.error ? '' : 'setTimeout(function(){ window.close(); }, 600);'}
 })();
</script>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

export { popupPage };
