// ctx-suite/hooks/lib/engine.ts — pure cost model + trigger evaluation.
//
// Ported from pi-extensions smart-compaction/lib/engine.ts + the claude-*
// profile from lib/profiles.ts. No `$` here: data in, decision out.
//
// Prices are RELATIVE units (input = 1). Every term of the savings/cost test
// scales linearly with the base input price, so only the ratios matter:
// Anthropic cache reads 0.1x, cache writes 1.25x, output 5x input.

import type { EngineState } from "../../types";

export interface Prices {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Tier {
	upTo: number;
	inputMult: number;
	outputMult: number;
}

export interface Profile {
	mode: "balanced" | "quality";
	tiers: Tier[];
	cache: { ttlShort: number };
	compaction: {
		tokenFloor: number;
		floorFraction?: number;
		minGapTokens?: number;
		minIntervalTurns: number;
		/** Fire line as a fraction of the window (default 0.5). */
		qualityLine?: number;
	};
	gate: { enabled: boolean; aggressiveBelow: number; deferAbove: number };
}

export const RELATIVE_PRICES: Prices = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export const CLAUDE_PROFILE: Profile = {
	mode: "balanced",
	tiers: [],
	// Claude Code's prompt cache lives an hour (30 days of sessions: 91% of requests 15-55 min idle hit it, 4.5% past 65 min).
	cache: { ttlShort: 3_600 },
	compaction: { tokenFloor: 40_000, floorFraction: 0.15, minGapTokens: 20_000, minIntervalTurns: 4, qualityLine: 0.5 },
	gate: { enabled: true, aggressiveBelow: 0.35, deferAbove: 0.7 },
};

/** Tier containing `tokens` (tiers sorted by upTo ascending). */
export function tierFor(tiers: Tier[], tokens: number): Tier | undefined {
	for (const t of tiers) if (tokens <= t.upTo) return t;
	return tiers.length > 0 ? tiers[tiers.length - 1] : undefined;
}

/** Cost of sending `tokens` input tokens, spread across tiers. */
export function inputCost(prices: Prices, tiers: Tier[], tokens: number): number {
	if (tokens <= 0) return 0;
	if (tiers.length === 0) return (tokens / 1_000_000) * prices.input;
	let cost = 0;
	let prev = 0;
	let remaining = tokens;
	for (let i = 0; i < tiers.length; i++) {
		const t = tiers[i]!;
		const isLast = i === tiers.length - 1;
		const span = t.upTo === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : t.upTo - prev;
		const inTier = isLast && t.upTo !== Number.POSITIVE_INFINITY ? remaining : Math.min(remaining, span);
		if (inTier > 0) cost += (inTier / 1_000_000) * prices.input * t.inputMult;
		remaining -= inTier;
		prev = t.upTo;
		if (remaining <= 0) break;
	}
	return cost;
}

export type { EngineState };

export function initState(): EngineState {
	return {
		lastLLMCallAt: null,
		cacheModelKey: null,
		sessionModel: null,
		growthPerTurn: null,
		lastTurnTokens: null,
		turnsSinceCompaction: 0,
		lastCompactionTokens: null,
		turnCounter: 0,
	};
}

/** Horizon cap shared by the fire condition and the savings integral. */
export const HORIZON_CAP = 50;
/** Tokens a compaction keeps verbatim (engine-level assumption). */
const KEEP_RECENT_TOKENS = 20_000;
const KEEP_RECENT_FLOOR = 24_000;

/** First tier boundary still ahead, else the overflow line. */
export function nextTriggerLine(profile: Profile, tokens: number, window: number, reserveTokens: number): number {
	const t0 = profile.tiers[0];
	const boundary = t0 && Number.isFinite(t0.upTo) && tokens < t0.upTo ? t0.upTo : undefined;
	return boundary ?? window - reserveTokens;
}

/** Summary output estimate: ~5% of context, clamped to the live-observed 2k-10k range. */
export function estimateSummaryTokens(tokens: number, fixed?: number): number {
	if (fixed != null) return fixed;
	return Math.min(10_000, Math.max(2_000, Math.round(tokens * 0.05)));
}

export interface EvalInput {
	profile: Profile;
	prices: Prices;
	config: { reserveTokens: number; continuationProbability: number; tierSafety: number; marginFactor?: number; summaryTokens?: number };
	state: EngineState;
	/** From $.session.usage().context — undefined tokens must no-op. */
	usage: { tokens: number | null; contextWindow: number } | undefined;
	now: number;
	modelKey?: string;
	cacheHot?: boolean;
}

export type Decision =
	| { kind: "none"; why: string }
	| { kind: "economy"; cacheHot: boolean; savings: number; cost: number; continuationProbability: number; horizonTurns: number }
	| { kind: "warn-overflow"; tokens: number; line: number }
	| { kind: "warn-tier"; tokens: number; boundary: number; projected: number }
	| { kind: "quality"; tokens: number; line: number }
	| { kind: "expiry"; tokens: number; idleMs: number };

export function isCacheHot(input: EvalInput): boolean {
	if (input.profile.mode === "quality") return false;
	if (input.state.cacheModelKey === null || input.state.lastLLMCallAt === null) return false;
	if (input.modelKey !== undefined && input.state.cacheModelKey !== input.modelKey) return false;
	const ttl = input.profile.cache.ttlShort;
	if (ttl <= 0) return false;
	return input.now - input.state.lastLLMCallAt < ttl * 1000;
}

/** Overflow / tier early warnings, after each turn. Never compacts. */
export function evaluateWarnings(input: EvalInput): Decision {
	const { usage, state, profile, config } = input;
	if (!usage || usage.tokens === null) return { kind: "none", why: "no-usage" };
	const tokens = usage.tokens;
	const line = usage.contextWindow - config.reserveTokens;
	if (tokens >= line) return { kind: "warn-overflow", tokens, line };
	const boundary = profile.tiers[0]?.upTo;
	if (boundary !== undefined && Number.isFinite(boundary) && tokens < boundary) {
		const projected = tokens + Math.max(state.growthPerTurn ?? 0, 0) * config.tierSafety;
		if (projected >= boundary) return { kind: "warn-tier", tokens, boundary, projected };
	}
	return { kind: "none", why: "no-warning" };
}

/** The effective floor and the constraint that binds it. */
export function effectiveFloor(profile: Profile, window: number): { floor: number; driver: string } {
	const windowFloor = profile.compaction.floorFraction ? window * profile.compaction.floorFraction : 0;
	const floor = Math.max(profile.compaction.tokenFloor, windowFloor, KEEP_RECENT_FLOOR);
	const driver = windowFloor >= floor ? "window-floor" : KEEP_RECENT_FLOOR >= floor ? "keepRecent floor" : "tokenFloor";
	return { floor, driver };
}

/** Economy evaluation at an idle point after a turn. */
export function evaluateEconomy(input: EvalInput): Decision {
	const { usage, state, profile, config } = input;
	if (!usage || usage.tokens === null) return { kind: "none", why: "no-usage" };
	const tokens = usage.tokens;
	const window = usage.contextWindow;

	const minInterval = profile.compaction.minIntervalTurns;
	if (state.turnsSinceCompaction < minInterval) {
		return { kind: "none", why: `min-interval (${state.turnsSinceCompaction}/${minInterval})` };
	}
	const { floor, driver } = effectiveFloor(profile, window);
	if (tokens < floor) return { kind: "none", why: `below ${driver} (${tokens} < ${Math.round(floor)})` };

	// Post-compaction gap: a compaction that barely shrank the context must not
	// re-fire on the same material. A watermark at/past the overflow line can
	// never be regrown past, so it counts as no gap.
	const minGap = profile.compaction.minGapTokens ?? 0;
	const overflowLine = window - config.reserveTokens;
	const gapFrom = state.lastCompactionTokens != null && state.lastCompactionTokens < overflowLine ? state.lastCompactionTokens : null;
	if (minGap > 0 && gapFrom != null && tokens < gapFrom + minGap) {
		return { kind: "none", why: `post-compaction gap (${tokens} < ${gapFrom} + ${minGap})` };
	}

	if (profile.mode === "quality") {
		const ql = (profile.compaction.qualityLine ?? 0.5) * window;
		if (tokens > ql) return { kind: "quality", tokens, line: ql };
		return { kind: "none", why: `below qualityLine (${tokens} <= ${ql})` };
	}

	// The fire line is the policy (pi 2026-10-04 amendment): past it, retention,
	// latency and cache-read cost outweigh summarization loss. The margin test
	// below is a sanity check. A tiered model may also fire once the expensive
	// tier is already active.
	const fireLine = (profile.compaction.qualityLine ?? 0.5) * window;
	const t0 = profile.tiers[0];
	const regimeActive = t0 !== undefined && Number.isFinite(t0.upTo) && tokens >= t0.upTo;
	if (tokens < fireLine && !regimeActive) {
		return { kind: "none", why: `below fire-line (${tokens} < ${Math.round(fireLine)} = qualityLine×${window})` };
	}

	const hot = input.cacheHot ?? isCacheHot(input);
	const continuation = config.continuationProbability;
	const margin = config.marginFactor ?? 1.25;
	const summaryTokens = estimateSummaryTokens(tokens, config.summaryTokens);
	const { savings, cost, horizonTurns } = savingsEstimate(input, tokens, window, hot, continuation, summaryTokens);
	if (savings === 0 && cost === 0) return { kind: "none", why: "pricing-unavailable (savings and cost are both 0)" };
	if (savings > cost * margin) {
		return { kind: "economy", cacheHot: hot, savings, cost, continuationProbability: continuation, horizonTurns };
	}
	return {
		kind: "none",
		why: `savings ${savings.toFixed(4)} <= cost ${cost.toFixed(4)} × ${margin} (tokens=${tokens}, growth=${state.growthPerTurn?.toFixed(0) ?? "null"}, hot=${hot}, H=${horizonTurns})`,
	};
}

/** Savings of carrying fewer tokens over the regrowth horizon vs the compaction's cost. */
export function savingsEstimate(
	input: EvalInput,
	tokens: number,
	window: number,
	hot: boolean,
	continuation: number,
	summaryTokens: number,
): { savings: number; cost: number; horizonTurns: number } {
	const { profile, prices, config, state } = input;
	const tiers = profile.tiers;
	const afterTokens = Math.min(KEEP_RECENT_TOKENS, tokens) + summaryTokens;

	// On a hot cache the summarizer request reads the conversation from cache (live 2026-10-05: 494,086
	// and 511,667 tokens read, ~1.2k written, in two compactions); on a cold one it pays full input price.
	const summaryInputCost = inputCost(prices, tiers, tokens) * (hot ? prices.cacheRead / prices.input : 1);
	const summaryOutputCost = (summaryTokens / 1_000_000) * prices.output;
	const rebuildCost = (afterTokens / 1_000_000) * (hot ? prices.cacheWrite : prices.input);
	const cost = summaryInputCost + summaryOutputCost + rebuildCost;

	// No growth observed → no regrowth → economy savings are 0.
	const growth = state.growthPerTurn;
	if (growth == null) return { savings: 0, cost, horizonTurns: 0 };
	const g = Math.max(growth, 250);
	const nextLine = nextTriggerLine(profile, tokens, window, config.reserveTokens);
	const horizonTurns = Math.min(HORIZON_CAP, Math.max(1, Math.ceil(Math.max(nextLine - afterTokens, 0) / g)));

	// hot: every future call re-reads the shrink at the cache-read rate.
	// cold: the next call pays full price on the shrink once, then it caches.
	const shrink = tokens - afterTokens;
	const marginal = hot
		? horizonTurns * (shrink / 1_000_000) * prices.cacheRead
		: (shrink / 1_000_000) * (prices.input + (horizonTurns - 1) * prices.cacheRead);
	let savings = continuation * marginal;

	// Tier avoidance: only the shrink above the boundary earns the tier-2 delta.
	const boundary = tiers[0] && Number.isFinite(tiers[0].upTo) ? tiers[0].upTo : undefined;
	if (boundary !== undefined && tokens > boundary && afterTokens < boundary) {
		const aboveTier = tierFor(tiers, boundary + 1);
		const delta = prices.input * ((aboveTier?.inputMult ?? tiers[0]!.inputMult) - tiers[0]!.inputMult);
		savings += continuation * horizonTurns * ((tokens - boundary) / 1_000_000) * delta;
	}
	return { savings, cost, horizonTurns };
}

/** Focus instructions for a compaction (task-aware). */
export function focusInstructions(action: "aggressive" | "focused", subjects: string[]): string {
	if (action === "aggressive") {
		return (
			"Compact aggressively: keep only a minimal summary. The summarized context is " +
			"largely unrelated to the current tasks" +
			(subjects.length ? ` (${subjects.join("; ")})` : "") +
			". Preserve any single line that does mention them."
		);
	}
	return (
		"Preserve ALL information related to the current tasks" +
		(subjects.length ? `: ${subjects.join("; ")}` : "") +
		". Record task-related facts as structured lists, NOT prose — summaries retain tabulated facts and " +
		"lose prose. The summary must keep, verbatim where possible: exact identifiers, constants and their " +
		"values, file paths, branch/PR names, exact commands, decisions WITH their rationale, and open questions. " +
		"Summarize unrelated content more briefly."
	);
}
