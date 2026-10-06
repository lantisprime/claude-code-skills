#!/usr/bin/env python3
"""Replay the 30-day baseline sessions as if ctx-suite's smart compaction had run.

Per main-thread request (in order): observed context = input + cache read + cache write.
At a user-turn boundary with >= IDLE s before the next prompt, if the simulated context is
past the fire line and the engine's economy test passes, a compaction fires:
  cost  = summarizer reads the whole context uncached (1.0/tok, as measured: ~306k cache
          write on a 370k compaction) + ~8k summary output (5.0) + rebuild of POST (1.25)
  after = every later request carries (context - POST) fewer tokens, taken off its cache
          read first, then its cache write; resets when the session's own compaction hits.
Relative prices in 1 / cache write 1.25 / cache read 0.1 / out 5; USD scaled per session
by its own USD / relative-cost ratio, capped at Opus list price ($5/M) so a session's
subagent spend is never counted as main-thread savings. Re-reads after a compaction
are NOT modelled, so treat the result as an upper bound for that fire line.

  python3 replay.py                                   # the 2026-10-05 30-day baseline snapshot
  python3 replay.py --baseline rows.json --fire 0.5   # rows from baseline.py --json
  add --json out.json to save the per-fire-line totals
"""
import argparse, json, os, sys
from datetime import datetime
REL = dict(i=1.0, w=1.25, r=0.1, o=5.0)
WINDOW, POST, SUMMARY_OUT, IDLE, MIN_TURNS, MARGIN, CONT = 1_000_000, 10_000, 8_000, 20, 4, 1.25, 0.7

def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def requests(path):
    """[(turn_index, t, usage)] main thread, one per API response, plus each user turn's start time."""
    seen, out, turn, turn_t = {}, [], -1, []
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except ValueError: continue
        if d.get("isSidechain"): continue
        t = d.get("type"); m = d.get("message") or {}
        if t == "user":
            c = m.get("content")
            is_tr = isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
            if not is_tr and not d.get("isMeta") and d.get("timestamp"):
                turn += 1; turn_t.append(ts(d["timestamp"]))
        elif t == "assistant" and m.get("usage") and m.get("id") and d.get("timestamp"):
            if m["id"] in seen: out[seen[m["id"]]] = (turn, ts(d["timestamp"]), m["usage"]); continue
            seen[m["id"]] = len(out); out.append((turn, ts(d["timestamp"]), m["usage"]))
    return out, turn_t

def replay(path, fire):
    reqs, turn_t = requests(path)
    base_cost = sim_cost = 0.0; offset = 0; prev_obs = 0; last_turn = None; turns_since = 99
    growth = None; turn_ctx = None; fired = 0
    for k, (turn, t, u) in enumerate(reqs):
        i, r, w, o = u.get("input_tokens", 0), u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0), u.get("output_tokens", 0)
        obs = i + r + w
        if prev_obs and obs < prev_obs * 0.5: offset = 0  # the session's own compaction / clear
        prev_obs = obs
        if turn != last_turn and last_turn is not None:
            # boundary: previous turn ended. Idle = gap from its last request to this turn's prompt.
            turns_since += 1
            ctx = max(POST, sim_prev)
            if turn_ctx is not None: growth = (ctx - turn_ctx) if growth is None else growth * 0.7 + (ctx - turn_ctx) * 0.3
            turn_ctx = ctx
            idle = (turn_t[turn] - prev_t) if 0 <= turn < len(turn_t) else 0
            if ctx >= fire * WINDOW and idle >= IDLE and turns_since >= MIN_TURNS and growth is not None:
                cost = ctx * REL["i"] + SUMMARY_OUT * REL["o"] + POST * REL["w"]
                H = min(50, max(1, int((WINDOW - 33_000 - POST) / max(growth, 250))))
                if CONT * H * (ctx - POST) * REL["r"] > cost * MARGIN:
                    sim_cost += cost; offset += ctx - POST; fired += 1; turns_since = 0; turn_ctx = POST
        last_turn = turn
        sr = max(0, r - offset); left = max(0, offset - r); sw = max(0, w - left)
        base_cost += i * REL["i"] + r * REL["r"] + w * REL["w"] + o * REL["o"]
        sim_cost += i * REL["i"] + sr * REL["r"] + sw * REL["w"] + o * REL["o"]
        sim_prev = i + sr + sw; prev_t = t
    return base_cost, sim_cost, fired

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--baseline", default=os.path.expanduser("~/.claude/cache/ctx-suite/baseline-2026-10-05-30d.json"), help="rows from baseline.py --json")
    ap.add_argument("--fire", type=float, nargs="*", default=[0.5, 0.35, 0.2], help="fire lines as a share of the 1M window")
    ap.add_argument("--json")
    a = ap.parse_args()
    base = json.load(open(a.baseline))["rows"]
    results = []
    for fire in a.fire:
        usd_b = usd_s = 0.0; fired_sessions = fires = 0
        for row in base:
            if not os.path.exists(row["file"]): continue
            b, s, f = replay(row["file"], fire)
            if b <= 0: continue
            scale = min(row["usd"] / b, 5.0e-6) if row["usd"] else 0
            usd_b += b * scale; usd_s += s * scale; fires += f; fired_sessions += f > 0
        r = {"fire": fire, "sessions": len(base), "sessionsCompacted": fired_sessions, "compactions": fires,
             "usdBefore": round(usd_b, 2), "usdAfter": round(usd_s, 2), "savedPct": round(100 * (usd_b - usd_s) / usd_b, 1) if usd_b else None}
        results.append(r)
        print(f"fire line {fire:.2f}×1M: compactions {fires} in {fired_sessions}/{len(base)} sessions · USD {usd_b:,.0f} → {usd_s:,.0f} (saves {usd_b-usd_s:,.0f}, {r['savedPct']}%)")
    if a.json:
        json.dump({"baseline": a.baseline, "assumptions": {"window": WINDOW, "postTokens": POST, "summaryOut": SUMMARY_OUT, "idleSeconds": IDLE,
                   "minIntervalTurns": MIN_TURNS, "margin": MARGIN, "continuation": CONT, "prices": REL, "rereadsModelled": False}, "results": results}, open(a.json, "w"), indent=1)
        print(f"→ {a.json}")


if __name__ == "__main__":
    main()
