// ctx-suite/hooks/lib/savings.ts — measured savings of ctx-suite's own compactions.
//
// A compaction ctx-suite started (trigger "plugin") shrinks the context by
// tokensBefore − tokensAfter. Without ctx-suite that shrink would still be in
// context, so every later main-loop request (one turn.step each) would re-read
// it: those are the tokens not re-read. The count stops when the counterfactual
// session would have compacted anyway: the person's /compact, Claude Code's own
// auto compaction, or the counterfactual context reaching the overflow line.
// Each ctx-suite compaction's own summarizer cost is subtracted.
//
// USD is API-equivalent at list input price per model family, with the same
// ratios the engine uses (cache read 0.1, cache write 1.25, output 5). On a
// subscription plan the saving is rate-limit headroom, not dollars.

import type { SavingsState } from "../../types";

export type { SavingsState };

/** List input price, USD per million tokens, by model family. */
const INPUT_USD_PER_M: ReadonlyArray<[RegExp, number]> = [
	[/opus/i, 5],
	[/sonnet/i, 3],
	[/haiku/i, 1],
];
const CACHE_READ = 0.1;

export function inputPrice(model: string | null | undefined): number | null {
	if (!model) return null;
	for (const [re, usd] of INPUT_USD_PER_M) if (re.test(model)) return usd;
	return null;
}

export interface UsageLike {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/** API-equivalent USD of one request's usage; 0 for an unknown model. */
export function usageUSD(u: UsageLike | undefined, model: string | null | undefined): number {
	const p = inputPrice(model);
	if (!u || p === null) return 0;
	const rel = (u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + CACHE_READ * (u.cache_read_input_tokens ?? 0) + 5 * (u.output_tokens ?? 0);
	return (rel / 1e6) * p;
}

export function freshSavings(): SavingsState {
	return { offset: 0, compactions: 0, requests: 0, tokens: 0, usdSaved: 0, usdSpent: 0 };
}

/** One main-loop model request: it re-reads `offset` fewer tokens than it would have. */
export function onRequest(s: SavingsState, model: string): SavingsState {
	if (s.offset <= 0) return s;
	const p = inputPrice(model);
	return { ...s, requests: s.requests + 1, tokens: s.tokens + s.offset, usdSaved: s.usdSaved + (p === null ? 0 : (s.offset / 1e6) * p * CACHE_READ) };
}

/** A compaction: ctx-suite's adds its shrink and its cost; any other means the counterfactual compacted too. */
export function onCompaction(s: SavingsState, trigger: string, before: number | undefined, after: number | undefined, usage: UsageLike | undefined, model: string | null): SavingsState {
	if (trigger !== "plugin") return { ...s, offset: 0 };
	if (before === undefined || after === undefined || before <= after) return s;
	return { ...s, offset: s.offset + (before - after), compactions: s.compactions + 1, usdSpent: s.usdSpent + usageUSD(usage, model) };
}

/** After a turn: past the overflow line, the counterfactual session would have auto-compacted. */
export function onContext(s: SavingsState, tokens: number | null, overflowLine: number): SavingsState {
	if (s.offset <= 0 || tokens === null || tokens + s.offset < overflowLine) return s;
	return { ...s, offset: 0 };
}

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

/** One /ctx-health line. */
export function savingsText(s: SavingsState, label: string): string {
	if (s.compactions === 0) return `${label}: no ctx-suite compaction yet`;
	const net = s.usdSaved - s.usdSpent;
	return `${label}: ${fmtTok(s.tokens)} tok not re-read over ${s.requests} requests after ${s.compactions} ctx-suite compaction${s.compactions === 1 ? "" : "s"} · ≈ ${fmtUSD(s.usdSaved)} saved − ${fmtUSD(s.usdSpent)} spent = ${fmtUSD(net)} net (API-equivalent)`;
}

/** Sum per-session entries (the store's "savings:<session>" values). */
export function sumSavings(entries: readonly unknown[]): SavingsState & { sessions: number } {
	const t = { ...freshSavings(), sessions: 0 };
	for (const v of entries) {
		const e = v as Partial<SavingsState> | undefined;
		if (!e || typeof e.tokens !== "number") continue;
		t.sessions++;
		t.compactions += e.compactions ?? 0;
		t.requests += e.requests ?? 0;
		t.tokens += e.tokens;
		t.usdSaved += e.usdSaved ?? 0;
		t.usdSpent += e.usdSpent ?? 0;
	}
	return t;
}
