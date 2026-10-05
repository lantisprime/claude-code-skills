// Measured savings of ctx-suite's own compactions (lib/savings.ts), checked against today's live session.

import type { SessionCompacted } from "claude-code";
import { expect, test } from "claude-code/testing";
import { loadConfig } from "../hooks/lib/config.ts";
import { freshSavings, onCompaction, onContext, onRequest, sumSavings, usageUSD } from "../hooks/lib/savings.ts";
import { Suite } from "../hooks/lib/suite.ts";

const OPUS = "claude-opus-5-5";
// the summarizer call of the live idle-trigger compaction (2026-10-05 12:12 PHT)
const LIVE_USAGE = { input_tokens: 2_255, output_tokens: 9_174, cache_read_input_tokens: 511_667, cache_creation_input_tokens: 1_216 };

test("the live compaction: 108 requests after 514,981 → 27,894 save 52.6M tokens, ≈ $26 against ≈ $0.50", () => {
	let s = onCompaction(freshSavings(), "plugin", 514_981, 27_894, LIVE_USAGE, OPUS);
	expect(s.offset).toBe(487_087);
	for (let i = 0; i < 108; i++) s = onRequest(s, OPUS);
	expect(s.requests).toBe(108);
	expect(s.tokens).toBe(52_605_396);
	expect(Math.round(s.usdSaved * 10) / 10).toBe(26.3);
	expect(Math.round(s.usdSpent * 10) / 10).toBe(0.5);
});

test("only ctx-suite's compactions count; any other compaction, or the overflow line, ends the counterfactual", () => {
	let s = onCompaction(freshSavings(), "plugin", 500_000, 20_000, undefined, OPUS);
	expect(onCompaction(s, "manual", 300_000, 10_000, undefined, OPUS).offset).toBe(0); // the person's /compact
	expect(onCompaction(s, "auto", 900_000, 10_000, undefined, OPUS).offset).toBe(0); // Claude Code's own
	expect(onContext(s, 400_000, 967_000).offset).toBe(480_000); // 880k counterfactual: still under the line
	expect(onContext(s, 500_000, 967_000).offset).toBe(0); // 980k: it would have auto-compacted by now
	s = onContext(s, 500_000, 967_000);
	expect(onRequest(s, OPUS)).toBe(s); // nothing more is counted
	expect(onRequest(freshSavings(), OPUS)).toEqual(freshSavings()); // no compaction, no savings
});

test("prices by model family; an unknown model counts tokens but no dollars", () => {
	const u = { input_tokens: 1_000_000 };
	expect(usageUSD(u, "claude-opus-5-5")).toBe(5);
	expect(usageUSD(u, "claude-sonnet-5-5")).toBe(3);
	expect(usageUSD(u, "claude-haiku-4-5-20251001")).toBe(1);
	expect(usageUSD(u, "glm-5.3")).toBe(0);
	const s = onRequest(onCompaction(freshSavings(), "plugin", 200_000, 10_000, undefined, "glm-5.3"), "glm-5.3");
	expect(s.tokens).toBe(190_000);
	expect(s.usdSaved).toBe(0);
});

test("the suite counts after its compaction, stamps telemetry with the session, and reports this session and all sessions", () => {
	const s = new Suite(loadConfig({}));
	s.sessionId = "S1";
	s.rt.engine.cacheModelKey = OPUS;
	s.onStep(OPUS); // before any compaction: nothing
	s.afterCompaction("plugin", { messages: [], tokensBefore: 514_981, tokensAfter: 27_894, usage: LIVE_USAGE } as unknown as SessionCompacted, 0, 0, 0, 1);
	s.onStep(OPUS);
	s.onStep(OPUS);
	s.onTurnComplete(undefined, { tokens: 80_000, window: 1_000_000 }, "opus", 2);
	expect(s.savingsEntry()?.requests).toBe(2);
	const log = s.takeLog();
	expect(log.every((r) => r.session === "S1")).toBe(true);
	expect(log.find((r) => r.event === "savings")).toMatchObject({ requests: 2, tokens: 974_174 });
	const other = { ...freshSavings(), compactions: 2, requests: 50, tokens: 10_000_000, usdSaved: 5, usdSpent: 1 };
	const text = s.healthText(sumSavings([other, s.savingsEntry()]));
	expect(text).toContain("savings (this session): 974k tok not re-read over 2 requests after 1 ctx-suite compaction");
	expect(text).toContain("savings (all sessions): 11.0M tok not re-read over 52 requests after 3 ctx-suite compactions");
	expect(text).toContain("· 2 sessions");
	expect(new Suite(loadConfig({})).healthText()).toContain("savings (this session): no ctx-suite compaction yet");
});

test("a /clear starts the new conversation's savings from zero under a new session id", () => {
	const s = new Suite(loadConfig({}));
	s.sessionId = "S1";
	s.afterCompaction("plugin", { messages: [], tokensBefore: 300_000, tokensAfter: 10_000 } as unknown as SessionCompacted, 0, 0, 0, 1);
	s.onSessionEnd("other"); // quitting keeps the count (the hook stores it)
	expect(s.savingsEntry()?.offset).toBe(290_000);
	s.onSessionEnd("clear");
	expect(s.savingsEntry()).toBeNull();
	expect(s.sessionId).toBeNull(); // read again at the next turn.start
	s.onStep(OPUS);
	expect(s.rt.savings.tokens).toBe(0); // the cleared context is not credited
});
