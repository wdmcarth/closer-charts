// Front-end config. Loaded as a regular script before app.js.
//
// CC_BACKEND_URL controls where the editor sends /save and /refresh-* requests:
//   - Empty string ""           → use same-origin (i.e. python3 server.py locally)
//   - A full URL (no trailing /) → use the Cloudflare Worker (remote/Pages deploy)
//
// When deploying to GitHub Pages, edit this file to point at the Worker URL
// returned by `wrangler deploy` and commit it. The landing page (index.html)
// loads this too but doesn't use the value — it's read-only.
window.CC_BACKEND_URL = "https://closer-charts-api.wdmcarth.workers.dev";

// Optional: set to true to force the editor to always show the sign-in
// dialog even on local server. Useful for testing the auth flow.
window.CC_FORCE_AUTH = false;
