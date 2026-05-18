// Closer Charts auth gateway (Cloudflare Worker).
//
// Sits between the editor in someone's browser and the GitHub repo.
// The editor never sees the bot's PAT — it only knows the shared password.
//
// Endpoints (all POST, JSON body must include `password`):
//   POST /save             body: {password, chart, quickhits}
//                          -> writes data/chart.json + data/quickhits.json
//                             as two commits via the Contents API
//   POST /refresh-stats     -> triggers refresh-stats.yml via workflow_dispatch
//   POST /refresh-rosters   -> triggers refresh-rosters.yml
//   POST /refresh-dashboard body: {password, days?}
//                          -> triggers refresh-dashboard.yml
//
// Required secrets (set via `wrangler secret put`):
//   SHARED_PASSWORD   the password editors type into the sign-in dialog
//   BOT_PAT           a GitHub fine-grained PAT with:
//                       - Contents: read/write on the repo
//                       - Actions:  read/write  (for workflow_dispatch)
//   REPO              "owner/name"  (e.g. "wdmcarth/closer-charts")
//   REF               branch name to commit to (e.g. "main")

const CORS = {
  // The Cloudflare Worker is on a different origin from GitHub Pages, so
  // browsers will preflight. We accept any origin — the password is the
  // actual access control.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...(init.headers || {}),
    },
  });
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.BOT_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "closer-charts-worker",
      ...(init.headers || {}),
    },
  });
}

// btoa() in Workers operates on byte strings. For UTF-8 content (the chart
// contains accented names like Andrés Muñoz), we need to encode to bytes
// first. This matches what Python's base64.b64encode(s.encode("utf-8")) does.
function b64encodeUtf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function putFile(env, path, contentString, message) {
  // GitHub's Contents API is fetch-then-PUT with a SHA guard. If a concurrent
  // writer (another editor, a workflow, or the user's own rapid autosaves)
  // changes the file between our GET and PUT, the PUT fails with 409. Last
  // write wins is the agreed semantics — so we just re-fetch the SHA and
  // retry.
  const MAX_ATTEMPTS = 4;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 1. Look up the current file's SHA. If the file doesn't exist yet,
    //    GET returns 404 and we omit `sha` to create it.
    let sha = null;
    const head = await gh(env, `/repos/${env.REPO}/contents/${path}?ref=${env.REF}`);
    if (head.ok) {
      const cur = await head.json();
      sha = cur.sha;
    } else if (head.status !== 404) {
      return { ok: false, status: head.status, error: await head.text() };
    }

    const body = {
      message,
      content: b64encodeUtf8(contentString),
      branch: env.REF,
      ...(sha ? { sha } : {}),
    };

    const put = await gh(env, `/repos/${env.REPO}/contents/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (put.ok) {
      const data = await put.json();
      return {
        ok: true,
        commitSha: data.commit?.sha,
        contentSha: data.content?.sha,
        attempts: attempt,
      };
    }

    // 409 is the SHA-conflict case — re-fetch and retry. Anything else is a
    // hard failure (auth, rate limit, bad request, etc.).
    if (put.status !== 409) {
      return { ok: false, status: put.status, error: await put.text() };
    }
    lastError = await put.text();
    // Brief backoff so a same-editor double-save serializes naturally.
    await new Promise(r => setTimeout(r, 150 * attempt));
  }

  return { ok: false, status: 409, error: lastError, attempts: MAX_ATTEMPTS };
}

async function handleSave(body, env) {
  if (body.chart === undefined || body.quickhits === undefined) {
    return json({ error: "expected { chart, quickhits }" }, { status: 400 });
  }
  const stamp = new Date().toISOString();
  // Up to three sequential file writes. Contents API only updates one
  // file per call; we could collapse via the Git Data API but for now the
  // audit trail just has 2–3 adjacent commits per Apply changes.
  const chartRes = await putFile(
    env,
    "data/chart.json",
    JSON.stringify(body.chart, null, 2) + "\n",
    `chart: edit (${stamp})`
  );
  if (!chartRes.ok) return json({ ok: false, step: "chart", ...chartRes }, { status: 502 });

  const qhRes = await putFile(
    env,
    "data/quickhits.json",
    JSON.stringify(body.quickhits, null, 2) + "\n",
    `quickhits: edit (${stamp})`
  );
  if (!qhRes.ok) return json({ ok: false, step: "quickhits", ...qhRes }, { status: 502 });

  let changelogRes = null;
  if (body.changelog !== undefined) {
    changelogRes = await putFile(
      env,
      "data/changelog.json",
      JSON.stringify(body.changelog, null, 2) + "\n",
      `changelog: append (${stamp})`
    );
    if (!changelogRes.ok) {
      return json({ ok: false, step: "changelog", ...changelogRes }, { status: 502 });
    }
  }

  return json({
    ok: true,
    chartCommit: chartRes.commitSha,
    quickhitsCommit: qhRes.commitSha,
    changelogCommit: changelogRes?.commitSha,
  });
}

async function handleDispatch(workflow, env, inputs = {}) {
  // workflow_dispatch returns 204 on success with empty body.
  const res = await gh(env,
    `/repos/${env.REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: env.REF, inputs }),
    });
  if (!res.ok && res.status !== 204) {
    return json({ ok: false, status: res.status, error: await res.text() }, { status: 502 });
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    if (path === "/healthz") {
      return json({ ok: true, repo: env.REPO, ref: env.REF });
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, { status: 400 });
    }

    if (!body || body.password !== env.SHARED_PASSWORD) {
      return json({ error: "wrong password" }, { status: 401 });
    }

    try {
      // /verify is a no-op that just lets the editor confirm the password is
      // good before showing the chart. Reaching here means the password
      // already cleared the check above.
      if (path === "/verify") return json({ ok: true });
      if (path === "/save") return await handleSave(body, env);
      if (path === "/refresh-stats")
        return await handleDispatch("refresh-stats.yml", env);
      if (path === "/refresh-rosters")
        return await handleDispatch("refresh-rosters.yml", env);
      if (path === "/refresh-dashboard") {
        const inputs = {};
        if (body.days) inputs.days = String(body.days);
        return await handleDispatch("refresh-dashboard.yml", env, inputs);
      }
      return json({ error: `unknown endpoint ${path}` }, { status: 404 });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, { status: 500 });
    }
  },
};
