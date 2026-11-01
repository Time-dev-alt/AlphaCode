/**
 * GET /api/health — the only "server" endpoint this architecture needs.
 * Returns configuration facts so the UI can tell the user what is available.
 * Authorisation state (keys, repos) lives in their browser, not here.
 */
export async function onRequestGet({ env }) {
  return new Response(
    JSON.stringify({
      ok: true,
      mode: 'client',
      version: env.ALPHACODE_VERSION || '3.0.0',
      githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      providers: {
        kilo: true,
        opencode: true,
        byok: true,
      },
      hosting: 'none — projects run and deploy from the browser',
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
