# Optimize CLAUDE.mds — conflict + token audit

Audit instruction docs — global/project `CLAUDE.md`, memory index files, and per-rule feedback/correction files — for **conflicts** and **token efficiency**. Instruction docs accrete rules from different dates that contradict, duplicate, or restate what the harness already enforces. Every always-loaded byte is recurring context cost, and every unflagged conflict silently loses to whichever rule the model reads last. This skill finds both.

For pure size compaction of a memory index, use `/optimize-memory-docs` — run this skill first; never compress a contradiction.

## When to use

- The user asks to optimize a `CLAUDE.md`, check rules for conflicts/contradictions, or audit accumulated feedback rules.
- Two instructions have visibly prescribed opposite actions in a session.
- A rules file has grown by accretion (many dated corrections) and nobody has reconciled it.

## Instructions

### 1. Inventory + weigh

List the docs in scope and classify each as ALWAYS-LOADED (global + project `CLAUDE.md`, the memory index, always-on rule files) or ON-DEMAND (topic/reference files, trigger-loaded rules). `wc -c` each. Optimization effort goes where cost recurs: always-loaded first.

### 2. Conflict detection

Read the always-loaded set fully; cluster on-demand rule files by topic (grep titles/descriptions) and compare only within clusters — never pairwise across everything. Hunt these classes:

- **RULE-VS-RULE** — two rules prescribing opposing actions for the same trigger (e.g. "wait for approval" vs "loop independently"). Accreted correction files are the usual offenders: newer corrections silently contradict older ones instead of superseding them.
- **RULE-VS-MODE** — interactive-era rules ("ask", "wait for approval") that break autonomous/scheduled runs. Fix by scoping, not deleting: state what the rule means in each mode.
- **RULE-VS-HARNESS** — lines restating what the tool's system prompt already enforces (match code style, concise output, …) — pure token cost; cut, noting what each was redundant with.
- **DUPLICATE** — the same rule in two places with drifted wording or anchors. Keep one canonical statement where it's always loaded; replace the others with pointers.
- **STALE** — references to files, flags, scripts, ids, or limits that no longer exist or were superseded. Verify each before keeping (`ls`/`grep` the target); prefer durable handles (tags, search queries) over version-pinned ids.

For every finding record: class, the quoted lines from **both** locations (file:line), and which rule currently wins in practice.

### 3. Token optimization

Only after conflicts are resolved: merge overlapping sections, enforce one-line entries in indexes, move detail to on-demand files, drop scaffolding headers a flat list can replace. Preserve every unique behavioral rule — compaction that loses a rule is a regression, not an optimization.

### 4. Resolve + apply

- **User-owned files** (any `CLAUDE.md`, hand-curated rules): present findings + a proposed rewrite and **wait for approval**. Never weaken or drop a user-owned rule silently.
- **Agent-owned memory** (files the agent itself wrote): apply directly — update the canonical file, fix pointers, delete entries proven wrong.
- Conflicting rule pairs where the user's intent is ambiguous: ask which wins, then encode the winner **with the loser's scope carved out** (e.g. "prefer X — except in context Y"), so both corrections survive.

### 5. Report

Findings table (class · files:lines · resolution), before/after byte size per always-loaded file, and confirmation nothing unique was dropped. Re-read each rewritten file once; verify every `[text](file.md)` pointer resolves.

## Safety

- Resolve conflicts by scoping/merging, not deleting history — move superseded text to a dated reference file if it carries context.
- Targeted edits over full rewrites for indexes; a full rewrite only for files restructured end-to-end **with approval**.
- A global `~/.claude/CLAUDE.md` is high-risk: explicit approval per file before any rewrite.
