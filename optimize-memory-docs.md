# Optimize CLAUDE.md and memory index files

Compact a project's `CLAUDE.md` and any always-loaded memory/context index (e.g. a `MEMORY.md`) so they stay small without losing information. These files are loaded into **every** session, so every byte is recurring context cost — detail belongs in on-demand reference files, not in the always-loaded index.

## When to use

- A session-start hook warns that the memory index exceeds its size limit.
- The "current status / workplan" section has multi-KB narrative blocks for work that has already merged or shipped.
- Index entries sprawl past ~200 chars or span multiple sentences.
- The user asks to optimize, compact, or trim `CLAUDE.md` or a memory index.

## Instructions

1. **Measure.** Run `wc -c` on `CLAUDE.md` and the memory index. Note the gap to any stated size limit; target well under it for headroom.
2. **Classify each status/workplan entry as CURRENT or HISTORICAL.**
   - CURRENT = the active pointer + the single most recent shipped item.
   - HISTORICAL = anything describing merged / closed / completed work. Stale tell-tales: "MERGED", "DEPLOYED", "IN PROGRESS", "OPEN", "NEXT: approve…" for work that has since landed.
3. **Move historical detail to a dated reference file** (e.g. `<index>_history.md`) **verbatim** — move, never delete. Preserve every commit hash, ticket id, and metric. Leave a one-line pointer in the index.
4. **Collapse the status section** to three lines: Active (pointer) · Last shipped (one line) · History (pointer to the reference file).
5. **Enforce one-line entries (≤ ~200 chars).** Use `**[Title](file.md)** (date) — one-line gist.` Detail stays in the linked file. Drop cross-link tails and empirical anecdotes from the index.
6. **Preserve load-bearing content** — never drop trigger/index tables, the "when to load" conditions, always-on rules, or safety notes. Trim only the trailing gist of an entry, never its trigger condition.
7. **Re-measure and verify.** Confirm the index is under its limit, every preserved section survived, and every `[text](file.md)` pointer resolves to a real file.

## Safety

- **Move, never delete** — every removed block lands in a reference file.
- Prefer **targeted edits** over a full rewrite of the always-loaded index: a typo in a full rewrite silently corrupts it; a targeted edit fails loudly on mismatch.
- **Re-read the file fresh** before a large restructure — the index is persistent memory.
- Do **not** rewrite a user's hand-curated rule list (e.g. a global `~/.claude/CLAUDE.md` numbered-rules section) without explicit approval.

## Output

Report: before/after byte size of each file, what moved where (with the new reference file path), and confirmation that the index is under its limit.
