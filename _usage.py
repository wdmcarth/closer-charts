"""Compute pitcher usage tags from a gameLog and a reference date.

Two independent dimensions — both can fire simultaneously, each picks its
highest applicable tag:

  Streak (consecutive days pitched immediately before today):
    "b2b"          : pitched D-1 and D-2
    "3-in-a-row"   : pitched D-1, D-2, D-3
    "4-in-a-row"   : pitched D-1, D-2, D-3, D-4
  Recency (count of appearances in a recent window):
    "3-of-4"       : pitched on 3 of D-1..D-4
    "4-of-5"       : pitched on 4 of D-1..D-5

  Plus volume tags from yesterday's outing (stack on top):
    "X.X IP"       : if yesterday's outing was > 1.0 IP (e.g. "1.2 IP")
    "## np"        : if yesterday's outing was >= 27 pitches (e.g. "31 np")

Where D-N means "N calendar days before today_date". So a pitcher who
threw D-1, D-2, D-4 gets both "b2b" (streak) AND "3-of-4" (recency).
"""

from __future__ import annotations

from datetime import date, timedelta


def ip_str_to_float(ip) -> float:
    """Baseball IP notation: '1.2' means 1 inning + 2/3 = 1.6667."""
    if ip is None:
        return 0.0
    s = str(ip)
    if "." not in s:
        try:
            return float(s)
        except ValueError:
            return 0.0
    whole, frac = s.split(".", 1)
    try:
        whole_i = int(whole)
    except ValueError:
        return 0.0
    if frac == "0":
        return float(whole_i)
    if frac == "1":
        return whole_i + 1.0 / 3.0
    if frac == "2":
        return whole_i + 2.0 / 3.0
    # Fallback: treat as decimal float (shouldn't happen with statsapi).
    try:
        return float(s)
    except ValueError:
        return float(whole_i)


def float_to_ip_str(x: float) -> str:
    """Inverse of ip_str_to_float, rounding to nearest third."""
    whole = int(x)
    frac = x - whole
    if frac < 1.0 / 6.0:
        return f"{whole}.0"
    if frac < 0.5:
        return f"{whole}.1"
    if frac < 5.0 / 6.0:
        return f"{whole}.2"
    return f"{whole + 1}.0"


def compute_usage(game_log: list[dict], today: date) -> dict:
    """Returns {usageTags: list[str], lastGame: {date, ip, pitches} | None}."""
    by_date: dict[str, list[dict]] = {}
    for g in game_log:
        d = g.get("date")
        if d:
            by_date.setdefault(d, []).append(g)

    pitched = [
        ((today - timedelta(days=i)).isoformat() in by_date)
        for i in range(1, 6)  # i=1..5 -> D-1..D-5
    ]

    tags: list[str] = []

    # Streak (consecutive days). Highest applicable wins; the lower ones are
    # implied (e.g. 4-in-a-row implies b2b — only the strongest is shown).
    if all(pitched[:4]):
        tags.append("4-in-a-row")
    elif all(pitched[:3]):
        tags.append("3-in-a-row")
    elif pitched[0] and pitched[1]:
        tags.append("b2b")

    # Recency (count in window). Fires independently of streak so a pitcher
    # with "b2b" who also threw D-4 gets ["b2b", "3-of-4"]. Highest wins
    # within this chain too — 4-of-5 implies 3-of-4.
    if sum(pitched[:5]) >= 4:
        tags.append("4-of-5")
    elif sum(pitched[:4]) >= 3:
        tags.append("3-of-4")

    # Yesterday's volume (IP and NP). These stack on top of workload tag.
    yest_iso = (today - timedelta(days=1)).isoformat()
    last_game: dict | None = None
    yest = by_date.get(yest_iso) or []
    if yest:
        total_ip_f = sum(ip_str_to_float(g.get("ip")) for g in yest)
        total_np = sum((g.get("pitches") or 0) for g in yest)
        ip_str = float_to_ip_str(total_ip_f)
        if total_ip_f > 1.0:
            tags.append(f"{ip_str} IP")
        if total_np and total_np >= 27:
            tags.append(f"{total_np} np")
        last_game = {"date": yest_iso, "ip": ip_str, "pitches": total_np or None}
    else:
        # Most-recent game (could be days ago) — surface for tooltip even if no
        # tag fires. Useful context when a pitcher hasn't been used recently.
        if by_date:
            latest = max(by_date.keys())
            row = by_date[latest][0]
            last_game = {
                "date": latest,
                "ip": row.get("ip"),
                "pitches": row.get("pitches"),
            }

    return {"usageTags": tags, "lastGame": last_game}
