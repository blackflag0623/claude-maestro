import type { Express } from 'express';

// CORS is permissive — the maestro server assumes network-level trust (run on
// a devbox / LAN). The desktop client connects to user-configured remote
// servers, so we can't restrict `connect-src` in CSP either.
//
// CSP rationale:
//   - `script-src 'self' cdn.jsdelivr.net` — mobile chat loads marked +
//     DOMPurify from jsDelivr UMD (avoids Vite optimize-deps races).
//   - `style-src 'unsafe-inline'` — both clients use inline `style="--var:…"`
//     attributes for dynamic CSS variables, and DOMPurify-sanitized markdown
//     can carry a few inline styles. Tightening means nonces (incompatible
//     with static serving) or hashes per inline style — not worth it.
//   - `img-src blob:` — `@xterm/addon-image` creates ObjectURLs for decoded
//     sixel / IIP frames. Production builds silently fail without `blob:`.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss: http: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Install CORS and security-header middleware. Must run before any route
 *  handler. CSP + X-Frame-Options are scoped to non-`/api/` responses so the
 *  API doesn't pay the cost; `frame-ancestors 'none'` covers framing for
 *  CSP-aware browsers. */
export function mountSecurityMiddleware(app: Express): void {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      res.setHeader('Content-Security-Policy', CSP);
      res.setHeader('X-Frame-Options', 'DENY');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
}
