/**
 * Security headers for every response on the Pages deployment.
 * The app is a static bundle plus two OAuth endpoints; there is no backend to
 * attack, but the headers still matter for XSS and clickjacking.
 */
const CSP = [
  "default-src 'self'",
  // `srcdoc` previews inherit this policy, so the CDNs a generated page is
  // likely to use have to be allowed here. Keep the list explicit: adding
  // `https:` would let any script run in the app's own origin.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Any HTTPS endpoint, because BYOK means the user chooses the provider —
  // an allowlist would silently break custom OpenAI-compatible base URLs.
  "connect-src 'self' blob: data: https:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export async function onRequest(context) {
  const res = await context.next();
  const out = new Response(res.body, res);
  out.headers.set('Content-Security-Policy', CSP);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  out.headers.set('X-Frame-Options', 'SAMEORIGIN');
  out.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  out.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (context.request.url.includes('/api/oauth/')) {
    out.headers.set('Cache-Control', 'no-store');
  }
  return out;
}
