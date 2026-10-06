// Compacting before the prompt cache expires (1 h TTL, measured over 30 days of
// sessions: 91% of requests 15-55 min idle hit the cache, 4.5% past 65 min).

import type { SessionCompactResult } from "claude-code";
import { expect, test } from "claude-code/testing";
import { loadConfig } from "../hooks/lib/config.ts";
import { CLAUDE_PROFILE } from "../hooks/lib/engine.ts";
import { freshSavings, onCompaction, onRequest } from "../hooks/lib/savings.ts";
import { Suite, type Io } from "../hooks/lib/suite.ts";

const MIN = 60_000;
const T0 = 10_000_000;
const OPUS = "claude-opus-5-5";
const USAGE = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 100, model: OPUS };

/** A main-loop session at `tokens` of a 1M window: the last turn ended at T0, under the fire line. */
function session(tokens = 240_000, options = {}): { s: Suite; io: (now: number) => Io; compactions: string[] } {
	const s = new Suite(loadConfig(options));
	s.rt.board = { rows: { "1": { subject: "fix the ingest checksum", status: "in_progress" } } };
	Object.assign(s.rt.engine, { turnsSinceCompaction: 10, growthPerTurn: 3_000 });
	s.onTurnComplete(USAGE, { tokens, window: 1_000_000 }, "opus", T0);
	const compactions: string[] = [];
	const io = (now: number): Io => ({
		context: async () => ({ tokens, window: 1_000_000 }),
		now: async () => now,
		messages: async () => [{ role: "user", text: "fix the ingest checksum", toolUses: [] }],
		complete: async () => ({ isAnswered: true, text: '{"p": 0.5}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
		compact: async (instructions): Promise<SessionCompactResult> => {
			compactions.push(instructions);
			return { messages: [], tokensBefore: tokens, tokensAfter: 26_000 };
		},
		model: async () => "opus",
	});
	return { s, io, compactions };
}

test("the engine's cache TTL is an hour, not 5 minutes", () => {
	expect(CLAUDE_PROFILE.cache.ttlShort).toBe(3_600);
	const s = new Suite(loadConfig({}));
	expect(s.evalInput({ tokens: 1, window: 1_000_000 }, 0).profile.cache.ttlShort).toBe(3_600);
	expect(new Suite(loadConfig({ cacheTtlMinutes: 5 })).evalInput({ tokens: 1, window: 1_000_000 }, 0).profile.cache.ttlShort).toBe(300);
});

test("due at 50 minutes idle, not at 49", () => {
	const { s } = session();
	expect(s.expiryDue(T0 + 49 * MIN)).toBe(false);
	expect(s.expiryDue(T0 + 50 * MIN)).toBe(true);
});

test("compacts below the fire line while the cache is warm, and only once per idle stretch", async () => {
	const { s, io, compactions } = session();
	const now = T0 + 50 * MIN;
	expect(s.expiryDue(now)).toBe(true);
	expect(await s.evaluate(io(now), false, true)).toMatch(/^compacted/);
	expect(compactions).toHaveLength(1);
	expect(s.rt.lastDecision?.kind).toBe("expiry");
	expect(s.rt.lastCompaction).toMatchObject({ trigger: "plugin", tokensBefore: 240_000, tokensAfter: 26_000 });
	// no hourly loop: not again in this idle stretch, however long it lasts
	expect(s.expiryDue(T0 + 51 * MIN)).toBe(false);
	expect(s.expiryDue(T0 + 110 * MIN)).toBe(false);
	// a new turn re-arms it
	s.onTurnComplete(USAGE, { tokens: 240_000, window: 1_000_000 }, "opus", T0 + 120 * MIN);
	expect(s.expiryDue(T0 + 170 * MIN)).toBe(true);
});

test("an attempt that does not compact still uses up the idle stretch", async () => {
	const { s, io, compactions } = session(100_000); // under the 150k floor
	const now = T0 + 50 * MIN;
	expect(s.expiryDue(now)).toBe(true);
	expect(await s.evaluate(io(now), false, true)).toMatch(/^no compaction — below window-floor/);
	expect(compactions).toHaveLength(0);
	expect(s.expiryDue(now + MIN)).toBe(false);
});

test("past 55 minutes it is too late: the cache may be cold (a slept laptop), so it skips", () => {
	const { s } = session();
	expect(s.expiryDue(T0 + 56 * MIN)).toBe(false);
	expect(s.takeLog().map((r) => r.event)).toContain("expiry-missed");
	expect(s.expiryDue(T0 + 52 * MIN)).toBe(false); // disarmed: the missed stretch is not retried
});

test("held by a background task, off when disabled, skipped after a model switch, never into a running turn", async () => {
	const { s, io, compactions } = session();
	s.onToolResult("Bash", "b1", { command: "node scripts/slow-red.js", run_in_background: true }, "Command running in background with ID: b1", false, undefined, T0 - MIN);
	expect(await s.evaluate(io(T0 + 50 * MIN), false, true)).toMatch(/waiting on 1 background task/);
	expect(compactions).toHaveLength(0);

	expect(session(240_000, { compactBeforeExpiry: false }).s.expiryDue(T0 + 50 * MIN)).toBe(false);

	// a model switched while idle has a cold cache: nothing to read cheaply
	const switched = session();
	expect(await switched.s.evaluate({ ...switched.io(T0 + 50 * MIN), model: async () => "sonnet" }, false, true)).toMatch(/^no compaction — below fire-line/);
	expect(switched.compactions).toHaveLength(0);

	const busy = session().s;
	busy.onTurnStart();
	expect(busy.expiryDue(T0 + 50 * MIN)).toBe(false);
});

test("a request after the cache expired is credited the re-write it avoided (1.25), not a cached read (0.1)", () => {
	const s0 = onCompaction(freshSavings(), "plugin", 474_000, 26_000, undefined, OPUS); // offset 448k
	const warm = onRequest(s0, OPUS);
	const cold = onRequest(s0, OPUS, true);
	expect(cold.tokens).toBe(warm.tokens);
	expect(Math.round(warm.usdSaved * 1000) / 1000).toBe(0.224); // 448k × $5/M × 0.1
	expect(Math.round(cold.usdSaved * 1000) / 1000).toBe(2.8); // 448k × $5/M × 1.25

	const { s } = session();
	s.rt.savings = s0;
	s.onStep(OPUS, T0 + 5 * MIN); // warm
	s.onStep(OPUS, T0 + 70 * MIN); // back after the TTL: the first request is cold
	s.onStep(OPUS, T0 + 71 * MIN); // the rest of that turn is warm again
	expect(Math.round(s.rt.savings.usdSaved * 1000) / 1000).toBe(Math.round((0.224 * 2 + 2.8) * 1000) / 1000);
});

// --- review fixes ---

test("review 3: an interrupted turn with no usage does not arm it (its idle clock was not refreshed)", () => {
	const s = new Suite(loadConfig({}));
	Object.assign(s.rt.engine, { turnsSinceCompaction: 10, lastLLMCallAt: T0 - 51 * MIN });
	s.onTurnComplete(undefined, { tokens: 240_000, window: 1_000_000 }, "opus", T0);
	expect(s.expiryDue(T0 + MIN)).toBe(false);
});

test("review 4: idle past the late line by compaction time (a slow judge) does not compact", async () => {
	const { s, io, compactions } = session();
	let t = T0 + 50 * MIN;
	const slow: Io = { ...io(t), now: async () => t, complete: async (req) => ((t = T0 + 56 * MIN), io(t).complete(req)) };
	expect(await s.evaluate(slow, false, true)).toMatch(/cache may have expired/);
	expect(compactions).toHaveLength(0);
});

test("review 6: no cold credit without a recorded previous request (a reload mid-turn)", () => {
	const s = new Suite(loadConfig({}));
	s.rt.engine.lastLLMCallAt = T0;
	s.rt.savings = onCompaction(freshSavings(), "plugin", 474_000, 26_000, undefined, OPUS);
	s.onStep(OPUS, T0 + 70 * MIN);
	expect(Math.round(s.rt.savings.usdSaved * 1000) / 1000).toBe(0.224);
});
