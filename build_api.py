"""Flatten the chart + supporting data files into a single per-pitcher
JSON file suitable for importing into other applications.

Reads:
  data/chart.json          (teams + roles + chips)
  data/stats.json          (season stats + usage tags)
  data/pitcher_index.json  (level / hand per MLBAMID)
  data/rosters.json        (40-man org structure, used for team abbr)

Writes:
  data/api.json
    {
      "generatedAt": "2026-05-16T...",
      "schemaVersion": 1,
      "pitchers": [
        {
          "league": "AL",
          "lev": 5,
          "team": "Baltimore Orioles",
          "team_abbr": "BAL",
          "team_id": 110,
          "team_notes": "**Ryan Helsley (elbow) ...",
          "role": "closer",
          "role_label": "Closer (highest leverage)",
          "role_position": 1,
          "player": "Rico Garcia",
          "mlbamid": 595879,
          "level": "MLB",
          "on_40_man": true,
          "hand": "R",
          "blue": false, "orange": true, "yellow": false,
          "magenta": true, "green": false,
          "usage_tag": "b2b, 1.1 IP",
          "injury_tag": null,
          "other_tag": null,
          "last_game": "2026-05-15"
        },
        ...
      ]
    }

Run: python3 build_api.py
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

PALETTE = ["Blue", "Orange", "Yellow", "Magenta", "Green"]


def _load(name: str, default):
    p = DATA / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text())
    except Exception as e:
        print(f"[api] WARN couldn't parse {name}: {e}", file=sys.stderr)
        return default


def _chip_explicit_colors(chip: dict) -> list[str]:
    """Both legacy chip.color (string) and new chip.colors (array) supported."""
    if isinstance(chip.get("colors"), list):
        return [c for c in chip["colors"] if c]
    if chip.get("color"):
        return [chip["color"]]
    return []


def main() -> None:
    chart = _load("chart.json", {})
    stats_blob = _load("stats.json", {})
    stats_by_id: dict = stats_blob.get("byPlayerId", {}) if isinstance(stats_blob, dict) else {}
    pitcher_index = _load("pitcher_index.json", {})
    rosters = _load("rosters.json", {})

    role_order = chart.get("roleOrder", ["closer", "stopper", "stealth", "upside", "hybrid"])
    role_labels = chart.get("roleLabels", {})

    rows: list[dict] = []
    for team in chart.get("teams", []):
        team_id = team.get("teamId")
        team_abbr = None
        if team_id:
            ros = rosters.get(str(team_id))
            if isinstance(ros, dict):
                team_abbr = ros.get("abbr")

        team_notes = (team.get("notes") or "").strip() or None

        for role in role_order:
            chips = team.get("roles", {}).get(role, []) or []
            for idx, chip in enumerate(chips):
                if not chip or not chip.get("name"):
                    continue
                mlbamid = chip.get("mlbamid")
                stat_row = stats_by_id.get(str(mlbamid)) if mlbamid else None
                pitcher = pitcher_index.get(str(mlbamid)) if mlbamid else None

                usage_tags = (stat_row or {}).get("usageTags") or []
                explicit = _chip_explicit_colors(chip)
                # Auto-magenta when usage tags present and the user hasn't
                # explicitly dismissed via chip.noMagenta.
                auto_magenta = bool(
                    mlbamid and usage_tags
                    and not chip.get("noMagenta")
                    and "Magenta" not in explicit
                )
                effective = set(explicit)
                if auto_magenta:
                    effective.add("Magenta")

                last_game = (stat_row or {}).get("lastGame")
                last_game_date = last_game.get("date") if isinstance(last_game, dict) else None

                rows.append({
                    "league": team.get("league"),
                    "lev": team.get("levcon"),
                    "team": team.get("teamName"),
                    "team_abbr": team_abbr,
                    "team_id": team_id,
                    "team_notes": team_notes,
                    "role": role,
                    "role_label": role_labels.get(role, role),
                    "role_position": idx + 1,
                    "player": chip.get("name"),
                    "mlbamid": mlbamid,
                    "level": (pitcher or {}).get("level"),
                    "on_40_man": (pitcher or {}).get("level") == "MLB" if pitcher else None,
                    "hand": (pitcher or {}).get("hand"),
                    "blue":    "Blue"    in effective,
                    "orange":  "Orange"  in effective,
                    "yellow":  "Yellow"  in effective,
                    "magenta": "Magenta" in effective,
                    "green":   "Green"   in effective,
                    "usage_tag": ", ".join(usage_tags) if usage_tags else None,
                    "injury_tag": chip.get("statusTag") or None,
                    "other_tag": chip.get("other") or None,
                    "last_game": last_game_date,
                })

    payload = {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "pitcherCount": len(rows),
        "pitchers": rows,
    }
    DATA.mkdir(parents=True, exist_ok=True)
    out = DATA / "api.json"
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"[api] wrote {out} ({len(rows)} rows)", file=sys.stderr)


if __name__ == "__main__":
    main()
