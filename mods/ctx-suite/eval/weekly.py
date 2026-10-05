#!/usr/bin/env python3
"""Weekly ctx-suite check: the last 7 days against the 2026-10-05 30-day baseline.

Runs baseline.py over the week's sessions and reports the numbers the request
levers move, next to the baseline snapshot's:

  requests per prompt     fewer when tool calls are batched
  context per request     smaller with an earlier fire line
  subagent share of cost  larger when exploration moves into subagents
  measured savings        ctx-suite's own count, latest telemetry record per session

No model calls: it only parses transcripts and telemetry. Writes
~/.claude/cache/ctx-suite/weekly/<date>.txt and appends a row to summary.jsonl;
with --notify, posts a macOS notification naming the report.

  python3 weekly.py [--days 7] [--notify]
"""
import argparse
import datetime as dt
import glob
import json
import os
import subprocess
import sys

CACHE = os.path.expanduser("~/.claude/cache/ctx-suite")
SNAPSHOT = os.path.join(CACHE, "baseline-2026-10-05-30d.json")
PROJECTS = os.path.expanduser("~/.claude/projects")
WEIGHT = {"input": 1, "cache_write": 1.25, "cache_read": 0.1, "output": 5}
USAGE_KEYS = {"input": "input_tokens", "cache_write": "cache_creation_input_tokens", "cache_read": "cache_read_input_tokens", "output": "output_tokens"}


def metrics(rows):
    """The lever numbers over baseline.py rows."""
    req = sum(r["requests"] for r in rows)
    turns = sum(r["user_turns"] for r in rows)
    ctx = sum(r["tokens"]["input"] + r["tokens"]["cache_write"] + r["tokens"]["cache_read"] for r in rows)
    rel = sum(sum(r["tokens"][k] * w for k, w in WEIGHT.items()) for r in rows)
    return {
        "sessions": len(rows),
        "requests": req,
        "requests_per_prompt": round(req / turns, 1) if turns else None,
        "ctx_per_request": round(ctx / req) if req else None,
        "cache_read_share": round(100 * sum(r["tokens"]["cache_read"] for r in rows) * 0.1 / rel, 1) if rel else None,
        "usd": round(sum(r.get("usd") or 0 for r in rows), 2),
    }


def subagent_share(since):
    """Subagent share of relative cost, over transcripts written since `since` (epoch s)."""
    def cost(paths):
        total = 0.0
        for p in paths:
            if os.path.getmtime(p) < since:
                continue
            with open(p, errors="replace") as f:
                for line in f:
                    if '"usage"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    u = (o.get("message") or {}).get("usage") if o.get("type") == "assistant" else None
                    if u:
                        total += sum((u.get(USAGE_KEYS[k]) or 0) * w for k, w in WEIGHT.items())
        return total
    main = cost(glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")))
    sub = cost(glob.glob(os.path.join(PROJECTS, "*", "*", "subagents", "*.jsonl")))
    return round(100 * sub / (main + sub), 1) if main + sub else None


def measured_savings(since_iso):
    """Sum of each session's latest telemetry savings record in the window."""
    latest = {}
    path = os.path.join(CACHE, "telemetry.jsonl")
    if os.path.exists(path):
        with open(path, errors="replace") as f:
            for line in f:
                if '"event":"savings"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("ts", "") >= since_iso and o.get("session"):
                    latest[o["session"]] = o
    s = {"sessions": len(latest), "compactions": 0, "tokens": 0, "usd_saved": 0.0, "usd_spent": 0.0}
    for o in latest.values():
        s["compactions"] += o.get("compactions", 0)
        s["tokens"] += o.get("tokens", 0)
        s["usd_saved"] += o.get("usdSaved", 0)
        s["usd_spent"] += o.get("usdSpent", 0)
    s["usd_saved"], s["usd_spent"] = round(s["usd_saved"], 2), round(s["usd_spent"], 2)
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--notify", action="store_true")
    a = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=a.days)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%S")
    out_dir = os.path.join(CACHE, "weekly")
    os.makedirs(out_dir, exist_ok=True)
    stamp = now.strftime("%Y-%m-%d")
    rows_path = os.path.join(out_dir, f"{stamp}-rows.json")

    here = os.path.dirname(os.path.abspath(__file__))
    subprocess.run([sys.executable, os.path.join(here, "baseline.py"), "--since", since_iso, "--json", rows_path],
                   check=True, stdout=subprocess.DEVNULL)
    week = metrics(json.load(open(rows_path))["rows"])
    week["subagent_share"] = subagent_share(since.timestamp())
    base = metrics(json.load(open(SNAPSHOT))["rows"]) if os.path.exists(SNAPSHOT) else {}
    saved = measured_savings(since_iso)

    def line(label, key, unit=""):
        b, w = base.get(key), week.get(key)
        return f"  {label:24} {w if w is not None else '-'}{unit}   (baseline {b if b is not None else '-'}{unit})"

    text = "\n".join([
        f"ctx-suite weekly check, {since_iso[:10]} → {stamp} ({a.days} days)",
        f"  sessions                 {week['sessions']}   (baseline 30 days: {base.get('sessions', '-')})",
        line("requests per prompt", "requests_per_prompt"),
        line("context per request", "ctx_per_request", " tok"),
        line("cache-read share", "cache_read_share", "%"),
        f"  subagent share of cost   {week['subagent_share']}%   (baseline 2.0%)",
        f"  measured savings         {saved['tokens'] / 1e6:.1f}M tok not re-read, {saved['compactions']} ctx-suite compactions in "
        f"{saved['sessions']} sessions, ≈ ${saved['usd_saved']} saved − ${saved['usd_spent']} spent (API-equivalent)",
        f"  rows: {rows_path}",
    ])
    with open(os.path.join(out_dir, f"{stamp}.txt"), "w") as f:
        f.write(text + "\n")
    with open(os.path.join(out_dir, "summary.jsonl"), "a") as f:
        f.write(json.dumps({"date": stamp, "days": a.days, "week": week, "baseline": base, "savings": saved}) + "\n")
    print(text)
    if a.notify:
        msg = f"{week['requests_per_prompt']} req/prompt · {saved['tokens'] / 1e6:.1f}M tok saved"
        subprocess.run(["osascript", "-e", f'display notification "{msg}" with title "ctx-suite weekly check"'], check=False)


if __name__ == "__main__":
    main()
