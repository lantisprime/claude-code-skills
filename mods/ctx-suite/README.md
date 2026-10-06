# ctx-suite

A Claude Code mod that ports pi's `context-manager` and `smart-compaction`. It
does three jobs:

- watches context health;
- redacts secrets in tool results before they are stored;
- times and shapes compactions so long sessions carry less context, and so the
  task-relevant facts survive.

How each part was measured is under Tools and Results below; the tools are in `eval/`.

## What it does

| Phase | What happens |
| --- | --- |
| **Observe** | Each tool result becomes a span, classified fresh, stale, duplicate or error. Secrets are redacted at store time. The status line shows the context mix and the cache hit rate, for example `ctx f97 s0 d3 e0 CH98 · sc idle`. |
| **Shape** | Every main-loop compaction gets task-aware focus instructions: keep task facts as tabulated lists, and keep identifiers verbatim. Stale, superseded, duplicate and repeated-failure tool outputs are stubbed only when the summarizer's cache is cold. With a warm cache, the stale reads are named in the instructions instead. |
| **Screen** | When a prompt you typed is only insults, slurs or hostile profanity, with no task content, it is dropped before it enters the session, so it reaches neither the model's context nor the transcript. You see "prompt not sent or saved". The word list drops prompts that are only strong insults or slurs. Other candidates get a quick Haiku 4.5 check, which drops a prompt only when it is abusive and carries nothing actionable. Negative feedback without abuse ("no, wrong again") always goes through, as does anything with task signal in it ("wrong again you idiot"). If the check fails, the prompt goes through. |
| **Time** | After an answered turn and 20 seconds of idle, the cost engine checks the context against the fire line (0.5 × window). If the saving outweighs the compaction's cost, a Sonnet 5.5 relevance judge picks aggressive, focused or defer, and the mod compacts. |
| **Before the cache expires** | Claude Code's prompt cache lives an hour. After 50 minutes idle, a context past the 150k floor compacts while the summarizer can still read it from cache, so coming back after the break doesn't re-write the whole context at 1.25×. It runs at most once per idle stretch (a new turn re-arms it), skips once 55 minutes have passed (the Mac may have slept and the cache gone cold) or after a model switch, and waits like every ctx-suite compaction for background tasks and the judge. |

**Task subjects.** They come from the task tools (TaskCreate, TaskUpdate,
TodoWrite) when the build has them. Otherwise they are the session's first and
latest prompts, redacted and cut to 300 characters. `/ctx-task` pins one
explicitly.

**Errors.** Each error is tied to the action that produced it:
- **How the action is identified:** Bash by its command, keyed on the chain's last step, without `cd …` or display pipes; other tools by their arguments.
- **What counts as an error:** only a result the harness itself flagged. Text such as `exit 1` in a script that was read does not count.
- **Error states:**
  - **live** (`L` in the status line): the newest run of that action failed, so the session is probably debugging it, as in a TDD RED run. Live failures are not dead weight. Every compaction names them and keeps their latest error output verbatim.
  - **resolved:** a later run of the same action succeeded.
  - **repeated:** a newer identical failure exists.
  - **harness:** Claude Code refused the call, and a later call of that tool succeeded.

  Only the last three are dead weight (`e` in the status line).

**Background tasks.** A shell command or agent sent to the background holds every compaction ctx-suite starts, idle or `/compact-smart`, until its result has been delivered and read, or it is stopped with `TaskStop` or `KillShell` (a stopped shell sends no notification, so the stop itself releases the hold). A background task that fails, such as a RED test run, is named as still failing until the same command passes. A stopped one is not a failure.

**Staleness.** After each turn, 20 read files are checked for outside edits,
rotating through all of them. A compaction checks every read file, up to the
newest 200.

## Commands

| Command | Does |
| --- | --- |
| `/ctx-health` | Context mix, impurity, cache hit, redaction hits, tasks, last compaction, and the **measured savings** for this session and for all sessions |
| `/ctx-task <text>` · `done` · `clear` | Pin the current task, settle it or remove it. With no argument, show the tasks. |
| `/compact-smart` | Evaluate a smart compaction now. This skips the minimum interval, not the guards. |
| `/compact-why` | The last decision, the fire line, the cache state and the judge's guardrails |

## Install

To load it in every repo, add this to the `env` block of `~/.claude/settings.json`:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-skills/mods/ctx-suite"
```

To run one session without it, start Claude Code with
`claude --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":""}}'`.

Each session the mod runs in is listed in `~/.claude/cache/ctx-suite/sessions.txt`.
Telemetry goes to `~/.claude/cache/ctx-suite/telemetry.jsonl`, capped at the last
2000 lines.

## Options (`/config` → ctx-suite)

| Option | Default | Notes |
| --- | --- | --- |
| `redact`, `redactPatterns` | on, none | Extra patterns are space-separated regexes. A pattern is rejected if it is longer than 200 characters or matches the empty string. |
| `shapeCompactions` | on | Stubs apply only on a cold cache. |
| `smartTiming`, `idleSeconds` | on, 20 | |
| `compactBeforeExpiry`, `cacheTtlMinutes` | on, 60 | The pre-expiry compaction, at 50/60 of the TTL. The TTL also sets the engine's hot/cold cache test and when stubbing applies. The TTL depends on your plan; lower it if your cache lives 5 minutes. |
| `qualityLine` | 0.5 | The fire line as a share of the window. A lower line compacts more often (see Savings below). |
| `reserveTokens` | 33000 | |
| `judgeEnabled`, `judgeModel`, `judgeEffort` | on, `claude-sonnet-5-5`, low | |
| `judgeTimeoutMs`, `judgeMaxExcerptChars`, `judgeMaxOutputTokens`, `judgeMaxCallsPerHour` | 15000, 4000, 256, 6 | Guardrails. Each value is clamped to a safe range. |
| `aggressiveBelow`, `deferAbove`, `allowAggressive`, `fallbackMayBeAggressive` | 0.35, 0.7, on, off | The keyword fallback never compacts aggressively unless you allow it. |
| `dropAbusive` | on | The prompt screen. Telemetry records only that a drop happened and why, never the text. |
| `scrubHistory` | on | Also removes a dropped prompt from Claude Code's up-arrow history (`~/.claude/history.jsonl`), within a few seconds of the drop. The file is rewritten whole after a check that nothing was appended since it was read. A session writing at that exact instant can still lose its line. It stops working once the file passes 4 MiB, and logs `history-scrub-missed`. |
| `driftToast`, `telemetry` | on, on | |

## Tools (`eval/`)

| Tool | Measures |
| --- | --- |
| `baseline.py` | Per-session context size per request, the live share of tool output, and token and USD consumption. `--with-ctx-suite` and `--without-ctx-suite` split sessions using `sessions.txt`. |
| `replay.py` | Projected savings: replays baseline sessions request by request as if smart compaction had run. Takes `--fire` for the fire lines and `--json` for an output file. |
| `debugsim.mjs` | A debugging-session simulation: a live failing test, scripts that only *mention* exit codes, a failure later fixed, a repeated failure, a harness refusal, a background RED run and a background wait loop stopped with `TaskStop`, then `/compact` and a recall question |
| `weekly.py` | The last 7 days against the 30-day baseline: requests per prompt, context per request, subagent share of cost and measured savings. No model calls. A launchd job runs it every Monday (see below). |
| `niah.mjs` | A multi-haystack needle-in-a-haystack corpus, combining pi's code and hybrid generator with three unrelated prose haystacks. It produces a tagged question bank for live A/B seats. |

## Results (2026-10-05)

**Retention**, measured over 3 live Sonnet 5.5 pairs:

| Needles | Plain `/compact` | ctx-suite |
| --- | --- | --- |
| Task-relevant, all 3 pairs | 36/57 | **57/57** |

Compaction cost was about the same in both arms: roughly $0.90 per 370k-token
compaction.

**Debugging simulation**, one live Sonnet 5.5 pair (`eval/results/debugsim-2026-10-05-sonnet.json`):
- **Recall after a plain `/compact`:** ctx-suite 10/10, control 9/10. Control lost the background RED test's failure.
- **Background hold:** `/compact-smart` refused with "waiting on 1 background task" while the RED run was out, then released once its result was read.
- **Error accounting:** the old text rule would have counted 11% of tool output as errors, against 4% the harness actually flagged.

**Projected savings**, from `replay.py` over 163 sessions in 30 days (82% of that
spend was cache reads of large contexts):

| Fire line | Compactions | Sessions affected | Saving |
| --- | --- | --- | --- |
| **0.5, the default** | 82 | 71 / 163 | **24%** |
| 0.35 | 138 | 87 / 163 | 35% |
| 0.2 | 241 | 97 / 163 | 44% |

Re-reads after a compaction are not modelled, so these are upper bounds. Expect
**15–25% at the default**.

**Measured live (2026-10-05).** The idle trigger fired in a real session after it
passed the fire line:

- **Decision:** `economy`, with the cache hot.
- **Compaction:** 514,981 → 27,894 tokens.
- **Its cost:** the summarizer hit the cache, reading 511,667 tokens and writing
  1,216, so the compaction cost about $0.50 at Opus prices.
- **Payback:** over the next 108 requests the session re-read 487k fewer tokens
  each, 52.6M in all. That is about $26 at the cache-read price, roughly 50× the
  compaction's cost.

On a subscription plan, this saving shows up as slower use of the 5-hour and
7-day limits rather than a lower bill.

**Measured automatically.** After each compaction ctx-suite starts, it counts every
later main-loop request, using one `turn.step` per request. Each request is credited
with the tokens it did not re-read. The compaction's own summarizer cost is subtracted.
The first request after the prompt cache expired is credited at cache-write price (1.25), since
without the compaction it would have re-written the whole context. The count stops when the session would have compacted anyway: your `/compact`, Claude
Code's own auto-compaction, or the counterfactual context reaching the overflow line.

The result appears in `/ctx-health`:

```
savings (this session): 52.6M tok not re-read over 108 requests after 1 ctx-suite compaction · ≈ $26.30 saved − $0.50 spent = $25.80 net (API-equivalent)
savings (all sessions): … · N sessions
```

Per-session totals persist in the mod's store, one entry per session, so concurrent
sessions never overwrite each other. Telemetry adds a `savings` record each turn. Every
telemetry record now carries its session id. USD is priced at list input price by model
family (Opus $5/M, Sonnet $3/M, Haiku $1/M); an unknown model counts tokens only.

To check the overall saving against the baseline after a week of use:

```sh
python3 eval/baseline.py --since 2026-10-05 --with-ctx-suite
```

`eval/weekly.py` does this every week. To schedule it on macOS, install a LaunchAgent that runs
`python3 eval/weekly.py --notify` (for example every Monday at 09:07); the report lands in
`~/.claude/cache/ctx-suite/weekly/<date>.txt`, with one row per week in `summary.jsonl`.

Compare its output with the snapshot in
`~/.claude/cache/ctx-suite/baseline-2026-10-05-30d.json`, and confirm that
telemetry shows `"compacted"` records with `"trigger":"plugin"`.

## Development

```sh
claude plugin validate mods/ctx-suite
claude plugin test mods/ctx-suite
npx -p typescript@5 tsc -p mods/ctx-suite --noEmit
```

The hooks module only wires events, in `hooks/register.ts`. The logic is free of
`$` and lives in `hooks/lib/`:

| File | Holds |
| --- | --- |
| `suite.ts` | The session state and decisions |
| `engine.ts` | The cost engine |
| `gate.ts` | The relevance judge |
| `shape.ts` | Compaction-input stubs |
| `redact.ts` | The redaction patterns |
| `spans.ts` | Span classification and the staleness probe |
| `tasks.ts` | The task board |
| `abuse.ts` | The prompt screen |
