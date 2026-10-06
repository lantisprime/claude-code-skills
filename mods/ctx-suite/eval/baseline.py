#!/usr/bin/env python3
"""ctx-suite baseline: context size, relevance and token consumption per session.

Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl), main thread only,
and reports the same three numbers for any set of sessions, so a run without
ctx-suite (the baseline) and a run with it are measured by one yardstick.

  context size  input tokens each model request was answered over
                (uncached + cache read + cache write), per request
  relevance     live share of tool output: 1 - the share ctx-suite's shaping
                rules would stub (stale reads, superseded calls, duplicates,
                identical-failure loops). A deterministic proxy, not a judgment.
  consumption   token totals per session and per user turn, cache hit %,
                relative cost units (input 1, cache write 1.25, cache read 0.1,
                output 5: the ratios the mod's engine uses), and the session's
                own USD total from its cost-state rows.

  python3 baseline.py --days 30                 # every session in the last 30 days
  python3 baseline.py --since 2026-10-05T00:50  # only sessions started after a time
  python3 baseline.py --sessions ID [ID ...]    # named sessions
  python3 baseline.py --without-ctx-suite       # the baseline arm
  python3 baseline.py --with-ctx-suite          # the treatment arm (sessions ctx-suite logged)
  add --json out.json to save the per-session rows
"""

import argparse, glob, json, os, statistics, sys, time
from collections import defaultdict
from datetime import datetime, timezone

DUMP_TOKENS, ERROR_LOOP_MIN = 800, 3
WRITE_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
REL = {"input": 1.0, "cache_write": 1.25, "cache_read": 0.1, "output": 5.0}


def tok(text):
    return (len(text) + 3) // 4


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def args_key(name, inp):
    return name + "|" + json.dumps(sorted((inp or {}).items()), default=str)[:2048]


def err_sig(text):
    import re
    return re.sub(r"\d+", "N", (text.split("\n", 1)[0]).strip())[:160]


def dead_tokens(calls):
    """Tokens ctx-suite's shaping rules (hooks/lib/shape.ts) would stub, by kind."""
    dead = defaultdict(int)
    stubbed = set()
    loops = defaultdict(list)
    for i, c in enumerate(calls):
        if c["err"]:
            loops[(c["key"], err_sig(c["text"]))].append(i)
    for idxs in loops.values():
        if len(idxs) >= ERROR_LOOP_MIN:
            for i in idxs[:-1]:
                stubbed.add(i)
                dead["error-loop"] += calls[i]["tok"]
    last_write, last_key, last_text = {}, {}, {}
    for i, c in enumerate(calls):
        if c["err"]:
            continue
        if c["name"] in WRITE_TOOLS and c["path"]:
            last_write[c["path"]] = i
        last_key[c["key"]] = i
        if c["tok"] >= DUMP_TOKENS:
            last_text[c["text"]] = i
    for i, c in enumerate(calls):
        if i in stubbed or c["err"] or c["tok"] < DUMP_TOKENS:
            continue
        if c["name"] == "Read" and c["path"] and last_write.get(c["path"], -1) > i:
            dead["stale"] += c["tok"]
        elif last_key.get(c["key"], -1) > i:
            dead["superseded"] += c["tok"]
        elif last_text.get(c["text"], -1) > i:
            dead["duplicate"] += c["tok"]
    return dead


def session_row(path):
    reqs = {}  # message.id -> usage (one API response spans several rows)
    uses, calls = {}, []
    compactions = defaultdict(int)
    turns, usd, sid, started = 0, 0.0, None, None
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        sid = sid or d.get("sessionId")
        if d.get("isSidechain"):
            continue
        ts = d.get("timestamp")
        if ts and not started:
            started = ts
        t = d.get("type")
        if t == "cost-state":
            usd = max(usd, float(d.get("totalCostUSD") or 0))
        elif t == "system" and d.get("subtype") == "compact_boundary":
            compactions[(d.get("compactMetadata") or {}).get("trigger", "?")] += 1
        elif t == "assistant":
            m = d.get("message") or {}
            if m.get("usage") and m.get("id"):
                reqs[m["id"]] = m["usage"]
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    uses[b.get("id")] = (b.get("name", ""), b.get("input") or {})
        elif t == "user":
            m = d.get("message") or {}
            content = m.get("content")
            if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                for b in content:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    name, inp = uses.get(b.get("tool_use_id"), ("?", {}))
                    text = text_of(b.get("content"))
                    p = inp.get("file_path") or inp.get("notebook_path")
                    calls.append({"name": name, "key": args_key(name, inp), "path": p if isinstance(p, str) else None,
                                  "text": text, "tok": tok(text), "err": bool(b.get("is_error"))})
            elif not d.get("isMeta"):
                turns += 1
    if not reqs:
        return None
    ctx = [u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0) for u in reqs.values()]
    tot = {k: sum(u.get(f, 0) for u in reqs.values()) for k, f in
           (("input", "input_tokens"), ("cache_write", "cache_creation_input_tokens"), ("cache_read", "cache_read_input_tokens"), ("output", "output_tokens"))}
    all_in = tot["input"] + tot["cache_write"] + tot["cache_read"]
    tool_tok = sum(c["tok"] for c in calls)
    dead = dead_tokens(calls)
    ctx_sorted = sorted(ctx)
    return {
        "session": sid, "file": path, "started": started, "requests": len(reqs), "user_turns": turns,
        "ctx_avg": round(statistics.mean(ctx)), "ctx_p50": ctx_sorted[len(ctx) // 2],
        "ctx_p90": ctx_sorted[min(len(ctx) - 1, int(len(ctx) * 0.9))], "ctx_max": ctx_sorted[-1],
        "tool_output_tok": tool_tok, "dead_tok": dict(dead),
        "live_share": round(1 - sum(dead.values()) / tool_tok, 3) if tool_tok else None,
        "tokens": tot, "cache_hit_pct": round(100 * tot["cache_read"] / all_in, 1) if all_in else None,
        "rel_cost": round(sum(tot[k] * REL[k] for k in REL) / 1e6, 3),
        "rel_cost_per_turn": round(sum(tot[k] * REL[k] for k in REL) / 1e6 / max(turns, 1), 4),
        "usd": round(usd, 2), "compactions": dict(compactions),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--since", help="ISO time; only sessions started at/after it")
    ap.add_argument("--sessions", nargs="*", help="session ids")
    ap.add_argument("--min-requests", type=int, default=20)
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--json")
    arm = ap.add_mutually_exclusive_group()
    arm.add_argument("--with-ctx-suite", action="store_true")
    arm.add_argument("--without-ctx-suite", action="store_true")
    a = ap.parse_args()
    listed = set()
    try:
        listed = set(open(os.path.expanduser("~/.claude/cache/ctx-suite/sessions.txt")).read().split())
    except OSError:
        pass
    cutoff = time.time() - a.days * 86400
    rows = []
    for f in glob.glob(os.path.join(a.root, "*", "*.jsonl")):
        if a.sessions:
            if os.path.basename(f)[:-6] not in a.sessions:
                continue
        elif os.path.getmtime(f) < cutoff:
            continue
        sid = os.path.basename(f)[:-6]
        if (a.with_ctx_suite and sid not in listed) or (a.without_ctx_suite and sid in listed):
            continue
        r = session_row(f)
        if not r or r["requests"] < a.min_requests:
            continue
        if a.since and (r["started"] or "") < a.since:
            continue
        rows.append(r)
    if not rows:
        sys.exit("no sessions matched")
    med = lambda k: statistics.median(r[k] for r in rows if r[k] is not None)
    req_total = sum(r["requests"] for r in rows)
    pooled_ctx = sum(r["ctx_avg"] * r["requests"] for r in rows) / req_total
    comp = defaultdict(int)
    for r in rows:
        for k, v in r["compactions"].items():
            comp[k] += v
    print(f"sessions: {len(rows)} · requests: {req_total} · user turns: {sum(r['user_turns'] for r in rows)}")
    print(f"context size   pooled avg/request {pooled_ctx:,.0f} tok · median of session avgs {med('ctx_avg'):,.0f} · median p90 {med('ctx_p90'):,.0f} · max {max(r['ctx_max'] for r in rows):,}")
    dead = defaultdict(int)
    for r in rows:
        for k, v in r["dead_tok"].items():
            dead[k] += v
    tool = sum(r["tool_output_tok"] for r in rows)
    print(f"relevance      live share of tool output: pooled {1 - sum(dead.values()) / tool:.1%} · median {med('live_share'):.1%} · dead by kind {dict(dead)}")
    print(f"consumption    median rel-cost/turn {med('rel_cost_per_turn')} · median cache hit {med('cache_hit_pct')}% · total USD {sum(r['usd'] for r in rows):,.2f} · median USD/session {med('usd')}")
    print(f"compactions    {dict(comp)}")
    if a.json:
        with open(a.json, "w") as fh:
            json.dump({"generated": datetime.now(timezone.utc).isoformat(), "args": vars(a), "rows": rows}, fh, indent=1)
        print(f"rows → {a.json}")


if __name__ == "__main__":
    main()
