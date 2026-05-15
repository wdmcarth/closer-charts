"""Refresh data/stats.json (and optionally data/rosters.json).

Usage:
  python3 refresh_stats.py                # stats only
  python3 refresh_stats.py --rosters      # also refresh rosters.json
  python3 refresh_stats.py --season 2026  # override season (default = current year)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _mlb_api as mlb  # noqa: E402
import _usage as usage_mod  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"

# Stats kept (subset of what bdfed returns) — chip hover & ranking signals.
KEEP = [
    "playerId", "playerFullName", "teamAbbrev", "teamId",
    "gamesPitched", "gamesStarted", "gamesFinished", "inningsPitched",
    "wins", "losses", "saves", "saveOpportunities", "blownSaves", "holds",
    "era", "whip", "strikeOuts", "baseOnBalls", "hits", "homeRuns",
    "strikeoutsPer9", "baseOnBallsPer9", "strikeoutWalkRatio",
    "strikeoutsMinusWalksPercentage", "groundOutsToAirouts",
    "whiffPercentage", "strikePercentage",
]


def to_num(v):
    if v in (None, "", "-.--", ".---"):
        return None
    try:
        return float(v) if isinstance(v, str) and ("." in v or "e" in v.lower()) else int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return v


def fetch_stats(season: int) -> dict:
    rows = mlb.season_pitching_stats(season=season, sport_id=1, game_type="R")
    out = {}
    for r in rows:
        pid = r.get("playerId")
        if pid is None:
            continue
        out[str(pid)] = {k: to_num(r.get(k)) for k in KEEP}
    return out


def collect_chip_player_ids(chart_path: Path) -> list[int]:
    """All unique mlbamids referenced by the current chart's chips."""
    if not chart_path.exists():
        return []
    chart = json.loads(chart_path.read_text())
    ids: set[int] = set()
    for t in chart.get("teams", []):
        for role_chips in (t.get("roles") or {}).values():
            for chip in role_chips or []:
                pid = chip.get("mlbamid")
                if isinstance(pid, int):
                    ids.add(pid)
    return sorted(ids)


def enrich_with_usage(stats: dict, player_ids: list[int], season: int, today: dt.date) -> None:
    """Mutates `stats` in place. For each player_id we pull gameLog (parallel),
    compute usageTags + lastGame, and merge into stats[str(id)].
    """
    if not player_ids:
        return
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def fetch_one(pid: int) -> tuple[int, dict]:
        log = mlb.pitcher_game_log(pid, season)
        return pid, usage_mod.compute_usage(log, today)

    print(f"[usage] computing for {len(player_ids)} chip-referenced pitchers", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(fetch_one, pid): pid for pid in player_ids}
        done = 0
        for fut in as_completed(futures):
            pid, u = fut.result()
            key = str(pid)
            stats.setdefault(key, {"playerId": pid})
            stats[key]["usageTags"] = u["usageTags"]
            stats[key]["lastGame"] = u["lastGame"]
            done += 1
            if done % 25 == 0:
                print(f"[usage] {done}/{len(player_ids)}", file=sys.stderr)
    print(f"[usage] done ({len(player_ids)})", file=sys.stderr)


_LEVEL_RANK = {"MLB": 0, "AAA": 1, "AA": 2, "A+": 3, "A": 4,
               "ROK": 5, "CPX": 6, "DSL": 7, "FRk": 8}


def build_pitcher_index() -> dict:
    """Walk every MLB org's affiliates and build a flat mlbamid -> pitcher
    record map covering MLB + every minor-league level. If a pitcher appears
    on multiple levels in the same season, the highest level wins.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    parent_teams = mlb.teams_mlb_only()
    print(f"[pitcher-index] {len(parent_teams)} orgs", file=sys.stderr)

    # 1) Enumerate every affiliate (MLB + AAA/AA/A+/A/...) under each parent org.
    affiliates: list[dict] = []
    for pt in parent_teams:
        try:
            for aff in mlb.teams_in_org(pt["id"]):
                affiliates.append({**aff, "parentOrgId": pt["id"], "parentAbbr": pt["abbreviation"]})
        except Exception as e:
            print(f"[pitcher-index] org {pt['name']}: {e}", file=sys.stderr)

    print(f"[pitcher-index] {len(affiliates)} affiliates to fetch", file=sys.stderr)

    # 2) Pull each affiliate's fullSeason roster in parallel.
    def fetch_one(aff: dict) -> tuple[dict, list]:
        try:
            roster = mlb.team_roster(aff["id"], roster_type="fullSeason")
        except Exception as e:
            print(f"[pitcher-index] {aff.get('abbreviation')} roster err: {e}", file=sys.stderr)
            return aff, []
        return aff, roster

    by_id: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(fetch_one, aff) for aff in affiliates]
        done = 0
        for fut in as_completed(futures):
            aff, roster = fut.result()
            done += 1
            if done % 50 == 0:
                print(f"[pitcher-index] {done}/{len(affiliates)} affiliates", file=sys.stderr)

            for entry in roster:
                pos = (entry.get("position") or {}).get("abbreviation")
                if pos != "P":
                    continue
                person = entry.get("person") or {}
                pid = person.get("id")
                if pid is None:
                    continue
                rec = {
                    "id": pid,
                    "name": person.get("fullName"),
                    "level": aff["level"],
                    "sportId": aff["sportId"],
                    "team": aff.get("name"),
                    "teamAbbr": aff.get("abbreviation"),
                    "parentOrg": aff.get("parentAbbr"),
                    "hand": (person.get("pitchHand") or {}).get("code"),
                    "status": (entry.get("status") or {}).get("description"),
                }
                key = str(pid)
                cur = by_id.get(key)
                if cur is None or _LEVEL_RANK.get(rec["level"], 99) < _LEVEL_RANK.get(cur["level"], 99):
                    by_id[key] = rec

    print(f"[pitcher-index] {len(by_id)} unique pitchers", file=sys.stderr)
    return by_id


def fetch_rosters() -> dict:
    """Mirrors build_data.fetch_rosters but standalone (avoids importing build_data)."""
    teams = mlb.teams_mlb_only()
    out = {}
    for t in teams:
        tid = int(t["id"])
        try:
            roster = mlb.team_roster(tid, roster_type="40Man")
        except Exception as e:
            print(f"[rosters] {t['name']}: {e}", file=sys.stderr)
            continue
        pitchers = []
        for p in roster:
            pos = p.get("position", {})
            if pos.get("abbreviation") != "P":
                continue
            person = p.get("person", {})
            pitchers.append({
                "id": person.get("id"),
                "name": person.get("fullName"),
                "posAbbr": pos.get("abbreviation"),
                "hand": (person.get("pitchHand") or {}).get("code"),
                "status": (p.get("status") or {}).get("description"),
            })
        out[str(tid)] = {
            "teamId": tid,
            "team": t["name"],
            "abbr": t.get("abbreviation"),
            "league": t.get("leagueName"),
            "division": t.get("divisionName"),
            "pitchers": sorted(pitchers, key=lambda x: (x["name"] or "").lower()),
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year)
    ap.add_argument("--rosters", action="store_true", help="also refresh rosters.json")
    args = ap.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[stats] fetching season={args.season}", file=sys.stderr)
    stats = fetch_stats(args.season)
    chip_ids = collect_chip_player_ids(DATA_DIR / "chart.json")
    enrich_with_usage(stats, chip_ids, args.season, dt.date.today())

    payload = {
        "season": args.season,
        "fetchedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "asOfDate": dt.date.today().isoformat(),
        "byPlayerId": stats,
    }
    out = DATA_DIR / "stats.json"
    out.write_text(json.dumps(payload, ensure_ascii=False))
    print(f"[stats] wrote {out} ({len(stats)} pitchers)", file=sys.stderr)

    if args.rosters:
        print("[rosters] refreshing", file=sys.stderr)
        r = fetch_rosters()
        rp = DATA_DIR / "rosters.json"
        rp.write_text(json.dumps(r, indent=2, ensure_ascii=False))
        print(f"[rosters] wrote {rp} ({len(r)} teams)", file=sys.stderr)

        idx = build_pitcher_index()
        ip = DATA_DIR / "pitcher_index.json"
        ip.write_text(json.dumps(idx, ensure_ascii=False))
        print(f"[pitcher-index] wrote {ip} ({len(idx)} pitchers)", file=sys.stderr)


if __name__ == "__main__":
    main()
