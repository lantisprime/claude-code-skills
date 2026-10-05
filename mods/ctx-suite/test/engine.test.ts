// Ported from pi-extensions smart-compaction/test/engine.test.ts: the cases
// that still apply to a Claude-only engine (no catalog pricing, no globs).

import { expect, test } from "claude-code/testing";
import {
	CLAUDE_PROFILE,
	RELATIVE_PRICES,
	effectiveFloor,
	estimateSummaryTokens,
	evaluateEconomy,
	evaluateWarnings,
	focusInstructions,
	initState,
	inputCost,
	isCacheHot,
	nextTriggerLine,
	savingsEstimate,
	tierFor,
	type EvalInput,
	type Profile,
} from "../hooks/lib/engine.ts";

const TIERS = [
	{ upTo: 200_000, inputMult: 1, outputMult: 1 },
	{ upTo: Number.POSITIVE_INFINITY, inputMult: 2, outputMult: 1.5 },
];
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

function input(over: Partial<EvalInput> = {}, profile: Partial<Profile> = {}): EvalInput {
	const state = initState();
	state.turnsSinceCompaction = 10;
	state.growthPerTurn = 2_000;
	state.cacheModelKey = "claude-opus-5-5";
	state.lastLLMCallAt = 1_000_000 - 10_000;
	return {
		profile: { ...CLAUDE_PROFILE, ...profile },
		prices: RELATIVE_PRICES,
		config: { reserveTokens: 33_000, continuationProbability: 0.7, tierSafety: 1.5 },
		state,
		usage: { tokens: 120_000, contextWindow: 200_000 },
		now: 1_000_000,
		modelKey: "claude-opus-5-5",
		...over,
	};
}

test("tierFor and inputCost blend tiers", () => {
	expect(tierFor(TIERS, 200_000)?.inputMult).toBe(1);
	expect(tierFor(TIERS, 200_001)?.inputMult).toBe(2);
	expect(tierFor([], 5)).toBeUndefined();
	// 250k at 1/M: 200k×1 + 50k×2 = 0.3
	near(inputCost(RELATIVE_PRICES, TIERS, 250_000), 0.3);
	near(inputCost(RELATIVE_PRICES, [], 1_000_000), 1);
	near(inputCost(RELATIVE_PRICES, [{ upTo: 100, inputMult: 3, outputMult: 1 }], 200), (200 / 1e6) * 3);
});

test("guards: no usage, min-interval, floor", () => {
	expect(evaluateEconomy(input({ usage: undefined })).kind).toBe("none");
	expect(evaluateEconomy(input({ usage: { tokens: null, contextWindow: 200_000 } }))).toEqual({ kind: "none", why: "no-usage" });
	const early = input();
	early.state.turnsSinceCompaction = 2;
	expect((evaluateEconomy(early) as { why: string }).why).toMatch(/^min-interval \(2\/4\)/);
	const small = evaluateEconomy(input({ usage: { tokens: 30_000, contextWindow: 200_000 } }));
	expect((small as { why: string }).why).toMatch(/^below tokenFloor/);
});

test("floor names the binding constraint and scales with the window", () => {
	expect(effectiveFloor(CLAUDE_PROFILE, 200_000)).toEqual({ floor: 40_000, driver: "tokenFloor" });
	expect(effectiveFloor(CLAUDE_PROFILE, 1_000_000)).toEqual({ floor: 150_000, driver: "window-floor" });
	expect(effectiveFloor({ ...CLAUDE_PROFILE, compaction: { ...CLAUDE_PROFILE.compaction, tokenFloor: 1_000, floorFraction: 0 } }, 100_000).driver).toBe("keepRecent floor");
});

test("fire line gates the economy path; qualityLine moves it", () => {
	const below = evaluateEconomy(input({ usage: { tokens: 90_000, contextWindow: 200_000 } }));
	expect((below as { why: string }).why).toMatch(/^below fire-line/);
	expect(evaluateEconomy(input()).kind).toBe("economy");
	const moved = evaluateEconomy(input({}, { compaction: { ...CLAUDE_PROFILE.compaction, qualityLine: 0.7 } }));
	expect((moved as { why: string }).why).toMatch(/^below fire-line/);
});

test("an active tier regime fires below the fire line (1M window, >200k)", () => {
	const d = evaluateEconomy(input({ usage: { tokens: 260_000, contextWindow: 1_000_000 } }, { tiers: TIERS }));
	expect(d.kind).toBe("economy");
});

test("post-compaction gap stops re-compaction churn; an overflow-line watermark does not", () => {
	const gap = input();
	gap.state.lastCompactionTokens = 110_000;
	expect((evaluateEconomy(gap) as { why: string }).why).toMatch(/^post-compaction gap/);
	const overflow = input();
	overflow.state.lastCompactionTokens = 190_000; // past 200k - 33k
	expect(evaluateEconomy(overflow).kind).toBe("economy");
});

test("no observed growth means no savings: declined, not fired", () => {
	const flat = input();
	flat.state.growthPerTurn = null;
	expect(evaluateEconomy(flat).kind).toBe("none");
});

test("quality mode fires above its line without cost math", () => {
	expect(evaluateEconomy(input({}, { mode: "quality" })).kind).toBe("quality");
	expect(evaluateEconomy(input({ usage: { tokens: 90_000, contextWindow: 200_000 } }, { mode: "quality" })).kind).toBe("none");
});

test("cache hot/cold", () => {
	expect(isCacheHot(input())).toBe(true);
	expect(isCacheHot(input({ now: 1_000_000 + 400_000 }))).toBe(true); // the cache lives an hour, not 5 minutes
	expect(isCacheHot(input({ now: 1_000_000 + 3_600_000 }))).toBe(false);
	expect(isCacheHot(input({ modelKey: "claude-sonnet-5-5" }))).toBe(false);
	expect(isCacheHot(input({}, { cache: { ttlShort: 0 } }))).toBe(false);
});

test("savings: hot marginal is cacheRead × horizon; cold is one full turn + (H-1) cached", () => {
	const i = input();
	const tokens = 120_000;
	const summary = estimateSummaryTokens(tokens);
	const after = 20_000 + summary;
	const hot = savingsEstimate(i, tokens, 200_000, true, 1, summary);
	near(hot.savings, hot.horizonTurns * ((tokens - after) / 1e6) * 0.1);
	const cold = savingsEstimate(i, tokens, 200_000, false, 1, summary);
	near(cold.savings, ((tokens - after) / 1e6) * (1 + (cold.horizonTurns - 1) * 0.1));
	// cost: summarizer input + output + rebuild. On a hot cache the summarizer reads the context from
	// cache (live 2026-10-05: 494,086 and 511,667 tokens read, 1,165 and 1,216 written); cold, at full price.
	near(hot.cost, (tokens / 1e6) * 0.1 + (summary / 1e6) * 5 + (after / 1e6) * 1.25);
	near(cold.cost, tokens / 1e6 + (summary / 1e6) * 5 + after / 1e6);
});

test("horizon clamps to [1, 50]", () => {
	const slow = input();
	slow.state.growthPerTurn = 1; // floored to 250/turn
	expect(savingsEstimate(slow, 120_000, 200_000, true, 1, 6_000).horizonTurns).toBe(50);
	const fast = input();
	fast.state.growthPerTurn = 10_000_000;
	expect(savingsEstimate(fast, 120_000, 200_000, true, 1, 6_000).horizonTurns).toBe(1);
});

test("summary estimate scales with context, clamped 2k-10k", () => {
	expect(estimateSummaryTokens(10_000)).toBe(2_000);
	expect(estimateSummaryTokens(100_000)).toBe(5_000);
	expect(estimateSummaryTokens(1_000_000)).toBe(10_000);
	expect(estimateSummaryTokens(1_000_000, 3_000)).toBe(3_000);
});

test("next trigger line: tier boundary when ahead, overflow when past", () => {
	expect(nextTriggerLine({ ...CLAUDE_PROFILE, tiers: TIERS }, 150_000, 1_000_000, 33_000)).toBe(200_000);
	expect(nextTriggerLine({ ...CLAUDE_PROFILE, tiers: TIERS }, 250_000, 1_000_000, 33_000)).toBe(967_000);
	expect(nextTriggerLine(CLAUDE_PROFILE, 50_000, 200_000, 33_000)).toBe(167_000);
});

test("warnings: overflow line and tier prediction", () => {
	expect(evaluateWarnings(input({ usage: { tokens: 170_000, contextWindow: 200_000 } })).kind).toBe("warn-overflow");
	expect(evaluateWarnings(input({ usage: { tokens: 198_000, contextWindow: 1_000_000 } }, { tiers: TIERS })).kind).toBe("warn-tier");
	expect(evaluateWarnings(input({ usage: { tokens: 50_000, contextWindow: 200_000 } })).kind).toBe("none");
});

test("focus instructions: task subjects, structured verbatim retention", () => {
	const f = focusInstructions("focused", ["Fix parser", "Ship PR"]);
	expect(f).toContain("Fix parser; Ship PR");
	expect(f).toContain("structured lists, NOT prose");
	expect(focusInstructions("aggressive", [])).toMatch(/^Compact aggressively/);
});

test("fast growth on a 200k window declines: the regrowth horizon is too short to pay", () => {
	const fast = input();
	fast.state.growthPerTurn = 20_000; // H = 8 turns: savings ≈ 0.6 × cost < 1.25 × cost
	expect((evaluateEconomy(fast) as { why: string }).why).toMatch(/^savings .* <= cost/);
});
