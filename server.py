"""Tiny local server for the Closer Charts webapp.

- Serves static files (index.html / app.js / styles.css) from this directory.
- Serves data/*.json directly.
- Endpoints:
    POST /save             body: {chart, quickhits}  -> writes data/chart.json + data/quickhits.json
    POST /refresh-stats                                -> runs refresh_stats.py and re-reads stats.json
    POST /refresh-rosters                              -> runs refresh_stats.py --rosters

Usage:
  python3 server.py [--port 8765] [--no-open]
"""

from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"

sys.path.insert(0, str(ROOT))
import _mlb_api as mlb  # noqa: E402

# In-process caches for org-roster lookups. Affiliates are stable across a
# session; rosters get re-pulled after ROSTER_TTL seconds so we pick up new
# call-ups / DFAs without forcing a /refresh-rosters cycle.
_ORG_AFFILIATES: dict[int, list[dict]] = {}
_ORG_ROSTERS: dict[int, tuple[float, list[dict]]] = {}
ROSTER_TTL = 600  # seconds


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kw):
        super().__init__(*args, directory=str(ROOT), **kw)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[server] " + (fmt % args) + "\n")

    def end_headers(self) -> None:
        # Local dev convenience: disable caching for everything we serve so
        # edits to app.js / styles.css / data/*.json show up immediately on
        # reload without forcing the user to hard-refresh. Production hosting
        # (GitHub Pages, Netlify, etc.) sets its own cache headers.
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # --- helpers -------------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        n = int(self.headers.get("Content-Length") or "0")
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"invalid json: {e}") from e

    def _run(self, args: list[str]) -> tuple[int, str, str]:
        proc = subprocess.run(
            [sys.executable, *args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=240,
        )
        return proc.returncode, proc.stdout, proc.stderr

    # --- GET endpoints -------------------------------------------------------

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/org-pitchers":
            self._handle_org_pitchers(urllib.parse.parse_qs(parsed.query))
            return
        super().do_GET()

    def _handle_org_pitchers(self, q: dict) -> None:
        try:
            team_id = int((q.get("teamId") or ["0"])[0])
        except ValueError:
            self._send_json(400, {"error": "teamId must be int"})
            return
        if not team_id:
            self._send_json(400, {"error": "teamId required"})
            return

        query = (q.get("q") or [""])[0].strip().lower()
        roster_type = (q.get("rosterType") or ["fullSeason"])[0]

        try:
            affiliates = _ORG_AFFILIATES.get(team_id)
            if affiliates is None:
                affiliates = mlb.teams_in_org(team_id)
                _ORG_AFFILIATES[team_id] = affiliates

            now = time.time()
            pitchers: list[dict] = []
            for aff in affiliates:
                aid = aff["id"]
                cached = _ORG_ROSTERS.get(aid)
                if cached and (now - cached[0]) < ROSTER_TTL:
                    roster = cached[1]
                else:
                    try:
                        roster = mlb.team_roster(aid, roster_type=roster_type)
                    except Exception as e:
                        print(f"[org-pitchers] {aff['abbreviation']} roster err: {e}",
                              file=sys.stderr)
                        roster = []
                    _ORG_ROSTERS[aid] = (now, roster)

                for entry in roster:
                    pos = (entry.get("position") or {}).get("abbreviation")
                    if pos != "P":
                        continue
                    person = entry.get("person") or {}
                    name = person.get("fullName") or ""
                    if query and query not in name.lower():
                        continue
                    pitchers.append({
                        "id": person.get("id"),
                        "name": name,
                        "hand": (person.get("pitchHand") or {}).get("code"),
                        "status": (entry.get("status") or {}).get("description"),
                        "team": aff["name"],
                        "teamAbbr": aff["abbreviation"],
                        "level": aff["level"],
                        "sportId": aff["sportId"],
                    })

            # Dedupe by player id (a player on MLB 40-man may also show on AAA
            # fullSeason roster). Keep the highest-level entry per id.
            level_rank = {"MLB": 0, "AAA": 1, "AA": 2, "A+": 3, "A": 4,
                          "ROK": 5, "CPX": 6, "DSL": 7, "FRk": 8}
            best: dict[int, dict] = {}
            for p in pitchers:
                pid = p.get("id")
                if pid is None:
                    continue
                cur = best.get(pid)
                if cur is None or level_rank.get(p["level"], 99) < level_rank.get(cur["level"], 99):
                    best[pid] = p
            out = sorted(
                best.values(),
                key=lambda p: (level_rank.get(p["level"], 99), p["name"].lower()),
            )

            self._send_json(200, {"ok": True, "pitchers": out[:100]})
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    # --- POST endpoints ------------------------------------------------------

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if path == "/save":
                body = self._read_body()
                chart = body.get("chart")
                quickhits = body.get("quickhits")
                if chart is None or quickhits is None:
                    self._send_json(400, {"error": "expected {chart, quickhits}"})
                    return
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                (DATA_DIR / "chart.json").write_text(
                    json.dumps(chart, indent=2, ensure_ascii=False)
                )
                (DATA_DIR / "quickhits.json").write_text(
                    json.dumps(quickhits, indent=2, ensure_ascii=False)
                )
                self._send_json(200, {"ok": True, "savedAt": time.time()})
                return

            if path == "/refresh-stats":
                rc, out, err = self._run(["refresh_stats.py"])
                self._send_json(200 if rc == 0 else 500, {
                    "ok": rc == 0, "stdout": out, "stderr": err,
                })
                return

            if path == "/refresh-rosters":
                rc, out, err = self._run(["refresh_stats.py", "--rosters"])
                self._send_json(200 if rc == 0 else 500, {
                    "ok": rc == 0, "stdout": out, "stderr": err,
                })
                return

            if path == "/refresh-dashboard":
                body = self._read_body() if self.headers.get("Content-Length") else {}
                args = ["dashboard_data.py"]
                if body.get("days"):
                    args.extend(["--days", str(int(body["days"]))])
                if body.get("start"):
                    args.extend(["--start", str(body["start"])])
                rc, out, err = self._run(args)
                self._send_json(200 if rc == 0 else 500, {
                    "ok": rc == 0, "stdout": out, "stderr": err,
                })
                return

            self._send_json(404, {"error": f"unknown endpoint {path}"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), Handler) as httpd:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"[server] serving {ROOT} at {url}", file=sys.stderr)
        if not args.no_open:
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[server] shutting down", file=sys.stderr)


if __name__ == "__main__":
    main()
