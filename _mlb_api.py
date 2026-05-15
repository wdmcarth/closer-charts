"""Local subset of mlbStats_26 endpoints — re-implemented without the Google Colab
dependency so this can run from a regular Python install.

Mirrors:
  - mlb.mlbTeams() / mlbTeams(filterCol=..., filterVal=...)
  - mlb.mlbTeamsRoster(teamId)        (extended with rosterType param)
  - mlb.mlbStats(season, sportId, stats, group, gameType)

Same public statsapi.mlb.com / bdfed.stitch.mlbinfra.com URLs as the original module.
"""

from __future__ import annotations

import json
import requests

TIMEOUT = 20


def teams_mlb_only() -> list[dict]:
    """All MLB-level teams (sport.id == 1). Returns list of dicts with id, name, abbreviation."""
    r = requests.get("https://statsapi.mlb.com/api/v1/teams/", timeout=TIMEOUT)
    data = r.json()
    out = []
    for t in data.get("teams", []):
        if (t.get("sport") or {}).get("id") != 1:
            continue
        out.append({
            "id": t["id"],
            "name": t["name"],
            "abbreviation": t.get("abbreviation"),
            "teamName": t.get("teamName"),
            "leagueName": (t.get("league") or {}).get("name"),
            "divisionName": (t.get("division") or {}).get("name"),
        })
    out.sort(key=lambda t: t["id"])
    return out


# sport.id -> short level label used in UI badges.
SPORT_LEVEL = {
    1:  "MLB",
    11: "AAA",
    12: "AA",
    13: "A+",
    14: "A",
    16: "ROK",
    17: "WIN",
    21: "CPX",
    22: "IND",
    23: "INT",
    51: "DSL",
    61: "FRk",
}


def teams_in_org(parent_org_id: int) -> list[dict]:
    """All teams (MLB + every affiliate) under a parent org. Returns dicts with
    id, name, abbreviation, sportId, level (short label)."""
    r = requests.get("https://statsapi.mlb.com/api/v1/teams/", timeout=TIMEOUT)
    data = r.json()
    out = []
    for t in data.get("teams", []):
        if t.get("parentOrgId") != parent_org_id and t.get("id") != parent_org_id:
            continue
        sport = t.get("sport") or {}
        sport_id = sport.get("id")
        out.append({
            "id": t["id"],
            "name": t.get("name"),
            "abbreviation": t.get("abbreviation"),
            "sportId": sport_id,
            "sportName": sport.get("name"),
            "level": SPORT_LEVEL.get(sport_id, sport.get("name") or "?"),
        })
    # MLB first, then by sport.id (AAA, AA, A+, …).
    out.sort(key=lambda t: (0 if t["sportId"] == 1 else (t["sportId"] or 999), t["id"]))
    return out


def team_roster(team_id: int, roster_type: str = "40Man") -> list[dict]:
    """Roster for one team. roster_type one of: 40Man, active, fullSeason, fullRoster.
    Returns the raw 'roster' list from statsapi (each entry has person, position, status).
    """
    url = f"https://statsapi.mlb.com/api/v1/teams/{team_id}/roster?rosterType={roster_type}&hydrate=person"
    r = requests.get(url, timeout=TIMEOUT)
    data = r.json()
    return data.get("roster", [])


def pitcher_game_log(player_id: int, season: int) -> list[dict]:
    """Per-game pitching log for one pitcher in `season`. Returns list of
    {date, ip, pitches, battersFaced} dicts, sorted newest first. Empty list
    if the pitcher hasn't appeared this season or the request fails.
    """
    url = (
        f"https://statsapi.mlb.com/api/v1/people/{player_id}/stats"
        f"?stats=gameLog&group=pitching&season={season}&gameType=R"
    )
    try:
        r = requests.get(url, timeout=TIMEOUT)
        data = r.json()
    except Exception:
        return []
    games: list[dict] = []
    for s in data.get("stats", []) or []:
        for split in s.get("splits", []) or []:
            stat = split.get("stat") or {}
            games.append({
                "date": split.get("date"),
                "ip": stat.get("inningsPitched"),       # string "1.2" = 1+2/3
                "pitches": stat.get("numberOfPitches"),
                "battersFaced": stat.get("battersFaced"),
            })
    games.sort(key=lambda g: g.get("date") or "", reverse=True)
    return games


def season_pitching_stats(season: int, sport_id: int = 1, game_type: str = "R") -> list[dict]:
    """Season-level pitching stats from bdfed (mirrors mlbStats(group='pitching')).
    Returns list of player dicts with playerId, playerFullName, teamAbbrev, plus stat fields.
    """
    params = [
        ("stitch_env", "prod"),
        ("season", season),
        ("sportId", sport_id),
        ("stats", "season"),
        ("group", "pitching"),
        ("gameType", game_type),
        ("limit", 10000),
        ("offset", ""),
        ("sortStat", ""),
        ("order", "asc"),
        ("playerPool", "ALL"),
    ]
    r = requests.get("https://bdfed.stitch.mlbinfra.com/bdfed/stats/player",
                     params=params, timeout=TIMEOUT)
    data = r.json()
    return data.get("stats", [])
