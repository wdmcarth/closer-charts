# Multi-editor deployment (GitHub Pages + Cloudflare Worker)

Public landing page on GitHub Pages, editor on the same site behind a
shared password. Everything below can be done in a web browser — no
terminal required.

```
┌────────────────────────────────────────────┐
│ GitHub Pages: your.github.io/closer-charts │
│   /            landing  (read-only)        │
│   /edit.html   editor   (sign-in to edit)  │
└────────────────────────────────────────────┘
                  │ writes / refreshes
                  ▼
┌────────────────────────────────────────────┐
│ Cloudflare Worker (free tier)              │
│   validates shared password                │
│   calls GitHub Contents API + Actions API  │
└────────────────────────────────────────────┘
                  │
                  ▼
┌────────────────────────────────────────────┐
│ GitHub repo                                │
│   data/*.json    canonical state           │
│   .github/workflows/refresh-*.yml          │
└────────────────────────────────────────────┘
```

You'll do all of this in ~20 minutes in two browser tabs: github.com and
dash.cloudflare.com.

---

## Step 1 — Create the GitHub repo and upload the folder

1. Go to <https://github.com/new>
2. **Repository name:** `closer-charts` (or whatever you prefer)
3. **Public** (required so GitHub Pages is free; the editor lives behind
   a password anyway, so the public can read but not write)
4. Do NOT initialize with README/.gitignore/license — keep it empty
5. Click **Create repository**

On the empty repo page, click **uploading an existing file** (the link in
the "Quick setup" panel), or use **Add file → Upload files**.

> **Important — drag the folder's *contents*, not the folder itself.**
> In Finder, open the `Closer Charts` folder, `Cmd+A` to select every file
> and subfolder inside it, then drag that selection onto GitHub's upload
> area. If you drag the *folder* itself, GitHub preserves the folder
> name, ending up with `closer-charts/Closer Charts/index.html` — which
> breaks Pages because it looks for `index.html` at the repo root.

GitHub uploads files in batches; large files (especially
`data/quickhits.json`, ~4.5 MB) may take a moment. When all files have
finished uploading, scroll down, type `Initial commit` in the message
field, and click **Commit changes**.

After the upload finishes, the repo's file list should show `index.html`,
`edit.html`, `app.js`, `data/`, `worker/`, `.github/`, `.gitignore`,
`.nojekyll`, etc. all at the top level — NOT inside a wrapper folder.

### Enable GitHub Pages

In the new repo: **Settings** (the tab inside the repo) → in the left
sidebar pick **Pages**.

- **Source:** Deploy from a branch
- **Branch:** `main` / root
- Click **Save**

Within a minute GitHub shows your site URL at the top of the Pages page,
typically `https://<your-user>.github.io/closer-charts/`. Open it in a
new tab to confirm the landing page renders (it will, with whatever data
you uploaded). The editor at `<URL>/edit.html` won't work yet — we
haven't deployed the Worker.

---

## Step 2 — Create a fine-grained Personal Access Token (the bot's GitHub key)

This is the credential the Cloudflare Worker will use to commit changes
to your repo. **The token never reaches editors' browsers** — it's stored
in Cloudflare's secret store and the Worker holds it server-side.

You can use your own GitHub account or create a dedicated bot account if
you want the commit history to attribute changes to `closer-charts-bot`
rather than you. Both work.

1. Click your **profile picture** in the top-right of any GitHub page →
   **Settings** (this opens YOUR user settings, not the repo's Settings tab)
2. Scroll to the **very bottom** of the left sidebar → **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**

Or jump straight to: <https://github.com/settings/personal-access-tokens/new>

Token settings:

| Field | Value |
|---|---|
| **Token name** | `closer-charts-worker` (or whatever — just for your memory) |
| **Expiration** | 90 days (renewable) or "No expiration" if you prefer |
| **Resource owner** | you (or the org that owns the repo) |
| **Repository access** | "Only select repositories" → pick `closer-charts` |

Then expand **Repository permissions** and set:

| Permission | Access |
|---|---|
| **Contents** | Read and write |
| **Actions** | Read and write |
| **Metadata** | Read-only (auto-selected when you pick the others) |

Leave every other permission at "No access".

Scroll to the bottom, click **Generate token**, and **copy the token
right now** — GitHub won't show it to you a second time. Paste it
somewhere temporarily (a sticky note / password manager). You'll paste
it into Cloudflare in the next step.

---

## Step 3 — Create the Cloudflare Worker

The Worker is a tiny piece of code that runs on Cloudflare's edge
network. It accepts requests from your editor, checks the shared
password, and (if it matches) acts on your behalf via the GitHub API.
The free tier covers 100 000 requests/day, far more than you'll ever use.

### 3a. Create a Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account
   (or sign in if you already have one — many people do, since CF is
   free CDN/DNS for personal sites)

### 3b. Create the Worker

1. In the Cloudflare dashboard, left sidebar → **Workers & Pages**
2. Click **Create application** (or the equivalent "Create" button on a
   fresh account). Cloudflare shows a **"Ship something new"** chooser
   with several options:
   - Connect GitHub / Connect GitLab
   - **Start with Hello World!** ← pick this one
   - Select a template
   - Upload your static files
3. Click **Start with Hello World!** — Cloudflare scaffolds a tiny
   default Worker for you and walks through a 2-step naming dialog.
4. **Name your Worker:** `closer-charts-api` (this becomes part of the URL).
5. Click **Deploy** — Cloudflare deploys the stock "Hello World" code.
   You'll replace it in the next step.

> If you'd rather have Cloudflare auto-deploy whenever you push changes
> to `worker/src/index.js`, choose **Connect GitHub** instead: authorize
> Cloudflare to access your repo, pick `closer-charts`, set the root
> directory to `worker`, leave build commands empty (wrangler.toml will
> drive it), and deploy. The rest of this section (paste-the-code) is
> not needed in that case. Continue from Step 3d for secrets either way.

### 3c. Replace the default code with our Worker code

1. After the Hello World deploy finishes, click **Continue to project**
   (or **Edit code** if you're already on the Worker's page).
2. From the Worker's page, click **Edit code** (top right) — the browser
   opens an in-page code editor.
3. Open your GitHub repo in another tab → navigate to
   `worker/src/index.js` → click the **Raw** button (top-right of the
   file view) to get the unformatted source → select all (Cmd/Ctrl+A) →
   copy.
4. Back in the Cloudflare code editor: open the `worker.js` (or
   `index.js`) file shown in the left file tree → select all
   (Cmd/Ctrl+A) → paste.
5. Click **Deploy** (top right of the editor).

Cloudflare shows a deploy success message and the live URL appears at
the top of the Worker's page, formatted like:

`https://closer-charts-api.<your-cf-subdomain>.workers.dev`

Copy this URL — you'll need it in Step 4.

### 3d. Add the secrets

Worker still needs to know: the password, the GitHub PAT, the repo name,
and the branch.

1. In the Worker's main page, click **Settings** (top tab)
2. Scroll to **Variables and Secrets**
3. Click **Add variable** four times — once for each of:

   | Variable name | Type | Value |
   |---|---|---|
   | `SHARED_PASSWORD` | Encrypt | a password your editors will share (e.g. `bullpen2026!`) |
   | `BOT_PAT` | Encrypt | the PAT you generated in Step 2 |
   | `REPO` | Plaintext | `<your-github-user>/closer-charts` (e.g. `wdmcarth/closer-charts`) |
   | `REF` | Plaintext | `main` |

   For each one: **Encrypt** the two secrets (PAT and password). **Plaintext**
   the two identifiers (REPO, REF). Encrypted values can never be read back —
   only overwritten.

4. Click **Save and deploy** after adding all four

### 3e. Smoke-test the Worker

Open a new browser tab and visit:
`https://closer-charts-api.<your-cf-subdomain>.workers.dev/healthz`

You should see:

```json
{"ok": true, "repo": "wdmcarth/closer-charts", "ref": "main"}
```

If you see anything else, double-check the secret values in Step 3d.

---

## Step 4 — Point the editor at the Worker

The editor doesn't know your Worker URL yet. It reads it from `config.js`
in the repo, which currently has an empty value.

1. Go to your GitHub repo → click on **`config.js`** in the file list
2. Click the pencil icon (top-right of the file content) to edit
3. Change:

   ```js
   window.CC_BACKEND_URL = "";
   ```

   to:

   ```js
   window.CC_BACKEND_URL = "https://closer-charts-api.<your-cf-subdomain>.workers.dev";
   ```

   (use your actual Worker URL, no trailing slash)

4. Scroll down, type a commit message like `Point editor at Worker`, click **Commit changes**

GitHub Pages rebuilds in ~30 seconds. After that, visit:

`https://<your-user>.github.io/closer-charts/edit.html`

You should see the **Sign in to edit** dialog. Type the password from
Step 3d → the dialog should close and the editor should load.

---

## Step 5 — Share with your editors

That's it. To onboard another editor:

1. Send them the URL: `https://<your-user>.github.io/closer-charts/edit.html`
2. Tell them the password

They visit the URL, sign in once (the password is stored in their
browser), and start editing. Their saves commit to your repo via the
Worker.

---

## What each editor sees day-to-day

1. Open the editor URL
2. Edit chips / colors / status badges / notes / Quick Hits — autosaves
   1.2s after their last change. Each save = 2 commits in the repo
   (chart.json + quickhits.json), authored by the bot account.
3. Click **Refresh stats** / **Refresh dashboard** / **Refresh rosters**
   to pull fresh MLB data. This triggers a GitHub Action that takes
   30–60 seconds; once it commits, the editor should **reload the page**
   to pick up the new data.

The public sees `https://<your-user>.github.io/closer-charts/` — same
chart, read-only.

---

## Common maintenance

### Rotate the shared password

1. Cloudflare dashboard → Workers & Pages → `closer-charts-api` → Settings → Variables and Secrets
2. Click the pencil next to `SHARED_PASSWORD` → enter new value → Save
3. Tell editors the new password. They each click **Sign out** in the
   editor topbar and sign back in.

### Rotate the bot PAT

1. Generate a new PAT on GitHub (same steps as Step 2, same permissions)
2. Cloudflare → Worker → Settings → Variables → pencil on `BOT_PAT` → paste new → Save
3. Revoke the old PAT in GitHub settings → Personal access tokens →
   Fine-grained → click the old token → **Revoke**

### Fix a bug in app.js / styles.css / a Python script

Edit the file directly on GitHub (click file → pencil icon → make
change → commit) OR upload a new version via **Add file → Upload files**.
Pages rebuilds within a minute. Editors with cached copies may need to
hard-reload (Cmd+Shift+R) to see the change.

### Trigger a refresh without using the editor

GitHub repo → **Actions** tab → pick a workflow (refresh-stats / -rosters
/ -dashboard) → **Run workflow** button. No password needed — repo write
access is the gate. The workflow runs in CI and commits the result.

You can also schedule these to run automatically by editing the workflow
YAML in the repo and adding a `schedule:` trigger. For example, to
refresh stats every two hours during the season:

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: "0 */2 * * *"
```

---

## Local development (optional, requires terminal)

If you want to keep editing locally without going through the deployed
Worker, you can still run `python3 server.py` on your laptop. With
`CC_BACKEND_URL = ""` (empty) in `config.js`, the editor talks to local
`server.py` instead of the Worker. That setup is documented in
`Start Closer Charts.command`. It's optional — pure-web workflow above
covers everything you need to operate the app.

---

## Architecture FAQ

**Why a Worker? Why not have the editor talk to GitHub directly?**
PATs can't safely live in client-side JavaScript — anyone with DevTools
would see the bot's credentials. The Worker holds the secret server-side
and only acts when the shared password checks out.

**Why two commits per save?**
The GitHub Contents API writes one file per call. `chart.json` and
`quickhits.json` are updated separately. Could be collapsed to one
commit via the lower-level Git Data API; not done yet.

**What if two editors save at the same time?**
Last write wins — the Worker fetches each file's current SHA right
before writing and overwrites. If two editors are touching different
teams it's fine; if they're touching the same chip the later save wipes
the earlier.

**Can the public see the editor URL?**
The editor URL is unlisted but not secret. Anyone who guesses
`/edit.html` sees the sign-in dialog; without the password it does
nothing useful. If you want defense-in-depth, put Cloudflare Access in
front of the editor URL too (free).

**Costs**
GitHub Pages: free. Cloudflare Workers: free up to 100k req/day.
GitHub Actions: 2000 free minutes/month on private repos, unlimited on
public repos. You won't approach any of these limits.
