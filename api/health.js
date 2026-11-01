/** GET /api/health for the Vercel deployment — same shape as the Pages one. */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    mode: 'client',
    version: process.env.ALPHACODE_VERSION || '3.0.0',
    githubOAuth: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    providers: { kilo: true, opencode: true, byok: true },
    hosting: 'none — projects run and deploy from the browser',
  });
}
