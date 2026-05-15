# Closer Charts auth gateway

Tiny Cloudflare Worker that mediates writes from the browser editor into the
GitHub repo. The editor only ever knows a shared password; the bot's GitHub
PAT stays inside Worker secrets and never reaches the client.

## Deploy

```sh
# one-time
npm install -g wrangler
wrangler login

# from this folder
wrangler secret put SHARED_PASSWORD   # whatever password your editors will share
wrangler secret put BOT_PAT           # fine-grained PAT, contents+actions write
wrangler secret put REPO              # e.g. wdmcarth/closer-charts
wrangler secret put REF               # main

wrangler deploy
```

`wrangler deploy` prints the URL the Worker is live at (typically
`https://closer-charts-api.<your-subdomain>.workers.dev`). Drop that URL into
`config.js` in the repo as `CC_BACKEND_URL`.

## Endpoints

All endpoints are POST with JSON body. All require `{ password: "..." }`.

| Path                | Body                       | Effect                                                          |
| ------------------- | -------------------------- | --------------------------------------------------------------- |
| `/verify`           | `{password}`               | No-op gated by password check — returns `{ok:true}` if password matches; used by the editor's sign-in dialog to validate the password upfront |
| `/save`             | `{password, chart, quickhits}` | Writes `data/chart.json` + `data/quickhits.json` as 2 commits   |
| `/refresh-stats`    | `{password}`               | Triggers `refresh-stats.yml` via workflow_dispatch              |
| `/refresh-rosters`  | `{password}`               | Triggers `refresh-rosters.yml`                                  |
| `/refresh-dashboard`| `{password, days?}`        | Triggers `refresh-dashboard.yml` with optional `days` input     |
| `/healthz`          | (GET)                      | Returns `{ok, repo, ref}` — sanity check, not password-gated    |

Responses:
- `200 {ok: true, ...}` on success
- `401 {error: "wrong password"}` if password mismatch
- `400`/`404`/`502` for client/upstream errors

## Local dev

```sh
wrangler dev
# Worker runs on http://127.0.0.1:8787
```

For local testing of the editor against the dev Worker, set
`window.CC_BACKEND_URL = "http://127.0.0.1:8787"` in `config.js`.
