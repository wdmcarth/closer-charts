"""Per-team reliever appearance dashboard.

Local port of the Reliever Recon RP Dashboard Colab notebook
(reliever_recon_rp_dashboard.py). Strips the Google Sheets / gspread output
plumbing and writes a single JSON file (data/dashboard.json) that the
Closer Charts webapp loads on demand.

Output shape:
  {
    "windowStart": "YYYY-MM-DD",
    "windowEnd":   "YYYY-MM-DD",
    "fetchedAt":   "ISO-8601",
    "dates":       ["2026-05-14", "2026-05-13", ...],   # newest first
    "byTeam": {
      "BAL": [
        {
          "id": 12345,
          "name": "Rico Garcia",
          "hand": "R",
          "rank": 5.2,
          "games": {
            "2026-05-13": {
              "IP": "1.0", "BF": 3, "PT": 14, "R": 0,
              "W": 0, "L": 0, "SV": 0, "HLD": 1, "BS": 0,
              "inning": 7, "teamScore": 3, "opponentScore": 1,
              "leverageIndex": 1.45
            }
          }
        },
        ...
      ],
      ...
    }
  }

Usage:
  python3 dashboard_data.py                 # default 14-day window ending yesterday (EST)
  python3 dashboard_data.py --days 7        # custom window length
  python3 dashboard_data.py --start 2026-05-01  # pin window start
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"

MLB_BASE = "https://statsapi.mlb.com/api/v1"
MAX_FETCH_WORKERS = 8

TEAMS = [
    "ATL", "ATH", "AZ",  "BAL", "BOS", "CHC", "CIN", "CLE", "COL", "CWS",
    "DET", "HOU", "KC",  "LAA", "LAD", "MIA", "MIL", "MIN", "NYM", "NYY",
    "PHI", "PIT", "SEA", "SD",  "SF",  "STL", "TB",  "TEX", "TOR", "WSH",
]

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
_session = requests.Session()


def _get_json(url: str, retries: int = 3, backoff: float = 1.0):
    last_exc = None
    for attempt in range(retries):
        try:
            r = _session.get(url, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # noqa: BLE001 - retry on any HTTP/parse error
            last_exc = exc
            time.sleep(backoff * (attempt + 1))
    raise last_exc


# ---------------------------------------------------------------------------
# Data fetch
# ---------------------------------------------------------------------------
def _completed_games(start_iso: str, end_iso: str) -> list[tuple[str, int]]:
    sched = _get_json(
        f"{MLB_BASE}/schedule/?sportId=1&gameType=R&startDate={start_iso}&endDate={end_iso}"
    )
    out = []
    for date_block in sched.get("dates", []):
        for g in date_block["games"]:
            if g["status"]["detailedState"] in ("Final", "Completed Early"):
                out.append((date_block["date"], g["gamePk"]))
    return out


def _fetch_game(game_pk: int):
    box = _get_json(f"{MLB_BASE}/game/{game_pk}/boxscore")
    wp = _get_json(f"{MLB_BASE}/game/{game_pk}/winProbability")
    return box, wp


def _add_team_pitchers(by_id, box, side, game_date):
    team_abbrev = box["teams"][side]["team"]["abbreviation"]
    for p in box["teams"][side]["players"].values():
        pitching = p.get("stats", {}).get("pitching") or {}
        if not pitching:
            continue
        if not pitching.get("pitchesThrown"):
            continue
        if pitching.get("gamesStarted"):
            continue
        pid = p["person"]["id"]
        r = by_id.setdefault(pid, {
            "id": pid,
            "name": p["person"]["fullName"],
            "team": team_abbrev,
            "hand": "",
            "games": {},
        })
        r["team"] = team_abbrev
        r["games"][game_date] = {
            "IP":  pitching.get("inningsPitched"),
            "W":   pitching.get("wins", 0),
            "L":   pitching.get("losses", 0),
            "SV":  pitching.get("saves", 0),
            "HLD": pitching.get("holds", 0),
            "BS":  pitching.get("blownSaves", 0),
            "R":   pitching.get("runs", 0),
            "BF":  pitching.get("battersFaced", 0),
            "PT":  pitching.get("pitchesThrown", 0),
        }


def _add_situations(by_id, wp, game_date, *, is_top_inning, our_score_key, opp_score_key):
    """Walk the win-probability play list once and stamp the entrance situation
    for each reliever's first credited play."""
    previous_pid = None
    for play in wp:
        credits = play.get("credits") or []
        if not credits:
            continue
        if play.get("about", {}).get("isTopInning") != is_top_inning:
            continue
        pa_credit = next((c for c in credits if c.get("credit") == "p_pa"), None)
        if pa_credit is None:
            continue
        pid = pa_credit["player"]["id"]
        if pid == previous_pid:
            continue
        previous_pid = pid

        r = by_id.get(pid)
        if not r or game_date not in r["games"]:
            continue

        r["hand"] = play["matchup"]["pitchHand"]["code"]
        g = r["games"][game_date]
        g["inning"] = play["about"]["inning"]
        g["teamScore"] = play["result"][our_score_key]
        # Heuristic from the original: subtract this play's RBIs to back into
        # the opponent's score AT entrance (since the play's score reflects
        # post-AB).
        g["opponentScore"] = play["result"][opp_score_key] - play["result"]["rbi"]
        g["leverageIndex"] = play.get("leverageIndex")


def _rank_relievers(relievers):
    """Match the original: avg over the first three games (oldest-first)."""
    for r in relievers:
        rank = 0.0
        count = 0
        # games dict is insertion-ordered = oldest-first because of how
        # _add_team_pitchers fills it (we iterate fetched games sorted by date).
        for g in r["games"].values():
            if count >= 3:
                break
            li = g.get("leverageIndex")
            if li is None or "inning" not in g:
                continue
            inn = g["inning"]
            base = 8 if inn > 9 else inn
            rank += base + li / 2.0
            count += 1
        r["rank"] = rank / 3.0 if count else 0.0
    relievers.sort(key=lambda x: x.get("rank", 0.0), reverse=True)


def collect_relievers(games: list[tuple[str, int]]) -> list[dict]:
    by_id: dict = {}
    fetched: dict = {}

    with ThreadPoolExecutor(max_workers=MAX_FETCH_WORKERS) as ex:
        futures = {ex.submit(_fetch_game, pk): (gd, pk) for gd, pk in games}
        completed = 0
        total = len(games)
        for fut in as_completed(futures):
            gd, pk = futures[fut]
            try:
                fetched[(gd, pk)] = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"  ! game {pk} on {gd} failed: {exc}", file=sys.stderr)
            completed += 1
            if completed % 25 == 0:
                print(f"[dashboard] fetched {completed}/{total}", file=sys.stderr)

    for (game_date, _pk), (box, wp) in sorted(fetched.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        _add_team_pitchers(by_id, box, "home", game_date)
        _add_team_pitchers(by_id, box, "away", game_date)
        _add_situations(by_id, wp, game_date,
                        is_top_inning=True,
                        our_score_key="homeScore",
                        opp_score_key="awayScore")
        _add_situations(by_id, wp, game_date,
                        is_top_inning=False,
                        our_score_key="awayScore",
                        opp_score_key="homeScore")

    relievers = list(by_id.values())
    _rank_relievers(relievers)
    return relievers


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def build_dashboard(num_days: int, start_date: str | None) -> dict:
    EST = dt.timezone(dt.timedelta(hours=-5))
    if start_date:
        start = dt.date.fromisoformat(start_date)
        end = start + dt.timedelta(days=num_days - 1)
    else:
        end = (dt.datetime.now(EST) - dt.timedelta(days=1)).date()
        start = end - dt.timedelta(days=num_days - 1)

    days = [start + dt.timedelta(days=i) for i in range(num_days)]
    days.reverse()  # newest first; matches the spreadsheet "leftmost = newest"
    date_strings = [d.isoformat() for d in days]

    print(f"[dashboard] window {start.isoformat()} -> {end.isoformat()} ({num_days}d)", file=sys.stderr)
    games = _completed_games(start.isoformat(), end.isoformat())
    print(f"[dashboard] completed games to fetch: {len(games)}", file=sys.stderr)

    relievers = collect_relievers(games)
    print(f"[dashboard] relievers found: {len(relievers)}", file=sys.stderr)

    # Group by team and keep the rank order produced by _rank_relievers.
    by_team: dict[str, list[dict]] = {team: [] for team in TEAMS}
    for r in relievers:
        team = r.get("team")
        if not team:
            continue
        by_team.setdefault(team, []).append({
            "id": r["id"],
            "name": r["name"],
            "hand": r.get("hand") or "",
            "rank": round(r.get("rank", 0.0), 3),
            "games": r.get("games", {}),
        })

    return {
        "windowStart": start.isoformat(),
        "windowEnd": end.isoformat(),
        "fetchedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "dates": date_strings,
        "byTeam": by_team,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--start", default=None, help="window start date YYYY-MM-DD (default: ends yesterday EST)")
    ap.add_argument("--out", default=str(DATA_DIR / "dashboard.json"))
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = build_dashboard(args.days, args.start)
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False))
    print(f"[dashboard] wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
