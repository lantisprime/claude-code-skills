// Prompt screen: abusive prompts with no task content are dropped; everything else goes on.

import type { ModelCompleteRequest, ModelCompleteResult } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { judgeAbuse, parseVerdict, screen } from "../hooks/lib/abuse.ts";
import { SCRUB_ATTEMPTS, scrubLines } from "../hooks/lib/history.ts";
import { loadConfig } from "../hooks/lib/config.ts";
import { Suite } from "../hooks/lib/suite.ts";

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const reply = (text: string, seen: ModelCompleteRequest[] = []) => async (req: ModelCompleteRequest): Promise<ModelCompleteResult> => {
	seen.push(req);
	return { isAnswered: true, text, usage: USAGE };
};
const never = async (): Promise<ModelCompleteResult> => Promise.reject(new Error("the judge must not be called"));

test("screen: a strong insult alone drops locally; weak words and anything beside them go to the judge", () => {
	expect(screen("you are a useless idiot").kind).toBe("drop");
	expect(screen("y0u stuuupid 1d10t!!!").kind).toBe("drop"); // leetspeak folded, runs squeezed
	expect(screen("fuck you").kind).toBe("ask"); // weak only: the judge decides
	expect(screen("idiot, read auth-jwt.ts first").kind).toBe("ask");
	expect(screen("no, wrong again").kind).toBe("clean"); // bare negative feedback is never a candidate
	expect(screen("I hate this").kind).toBe("clean");
	expect(screen("trash the old branch").kind).toBe("clean");
	expect(screen("idiot " + "x".repeat(700)).kind).toBe("clean"); // long prompts are not screened
	expect(screen("ídíot").kind).toBe("drop"); // accents stripped
});

test("screen never drops locally what it cannot read: other scripts, digits, questions, quotes, imperatives", () => {
	// GLM-5.3 review: each of these carries task content the word list cannot see
	for (const t of ["重写这个函数，you idiot", "исправь это, moron", "42, dumbass", "just go, asshole", "go on, you idiot", "ok go, moron", 'who is "moron"?']) {
		expect(screen(t).kind).toBe("ask");
	}
});

test("judgeAbuse: task signal keeps the prompt without a model call; the judge drops only abusive and not actionable", async () => {
	expect(await judgeAbuse("you idiot", [], never)).toEqual({ drop: true, why: "wordlist" });
	expect(await judgeAbuse("wrong again you idiot", [], never)).toEqual({ drop: false, why: "signal" });
	expect(await judgeAbuse("idiot, the build broke", [], never)).toEqual({ drop: false, why: "signal" });
	const seen: ModelCompleteRequest[] = [];
	expect(await judgeAbuse("fuck you", ["ship the codec"], reply('{"abusive": true, "actionable": false}', seen))).toEqual({ drop: true, why: "judge" });
	expect(seen[0]?.model).toBe("claude-haiku-4-5-20251001");
	expect(seen[0]?.prompt).toContain("- ship the codec");
	expect(await judgeAbuse("fucking useless", [], reply('{"abusive": true, "actionable": true}'))).toEqual({ drop: false, why: "judge-keep" });
});

test("judgeAbuse fails open: a refused, failed or garbled judge keeps the prompt", async () => {
	expect(await judgeAbuse("fuck you", [], never)).toEqual({ drop: false, why: "judge-failed" });
	expect(await judgeAbuse("fuck you", [], reply("maybe"))).toEqual({ drop: false, why: "judge-failed" });
	expect(await judgeAbuse("fuck you", [], async () => ({ isAnswered: false, reason: "aborted", usage: USAGE }) as ModelCompleteResult)).toEqual({ drop: false, why: "judge-failed" });
	expect(parseVerdict('{"abusive": "yes", "actionable": false}')).toBeNull();
});

test("screenPrompt: counted, never logged; slash commands, attachments and the option bypass it", async () => {
	const s = new Suite(loadConfig({}));
	expect(await s.screenPrompt("you moron", false, never)).toBe(true);
	expect(s.rt.promptsDropped).toBe(1);
	const log = JSON.stringify(s.takeLog());
	expect(log).toContain('"why":"wordlist"');
	expect(log).not.toContain("moron");
	expect(await s.screenPrompt("/compact you moron", false, never)).toBe(false);
	expect(await s.screenPrompt("you moron", true, never)).toBe(false);
	const off = new Suite(loadConfig({ dropAbusive: false }));
	expect(await off.screenPrompt("you moron", false, never)).toBe(false);
	expect(s.healthText()).toContain("abusive prompts dropped: 1");
});

// The test kit stamps its own prompts as a plugin's ({ kind: "plugin" }); the person's own drop is verified live.
test("a prompt that is not the person's own (a plugin's, a peer's) is never screened", async ($, on) => {
	mock.clock(on, { now: 1_000_000 });
	on("session.usage", () => ({ value: { startedAt: 0, context: { tokens: 5_000, window: 200_000, percent: 3 }, rateLimits: [] } }));
	on("session.model", () => ({ value: "opus" }));
	const entered: string[] = [];
	on("prompt.submit", ($, e) => {
		entered.push(e.text);
		return { text: e.text };
	});
	const r = await $.prompt.submit({ text: "you absolute idiot" });
	expect(r.drop).toBeUndefined();
	expect(entered).toEqual(["you absolute idiot"]);
});

// --- input history removal (lib/history.ts) ---

const line = (display: string, timestamp: number, sessionId = "S1") => JSON.stringify({ display, pastedContents: {}, timestamp, project: "/p", sessionId });

test("scrubLines removes only the newest matching line of this session, since the drop", () => {
	const file = [line("you moron", 1_000), line("hello", 900_000), line("you moron", 950_000, "S2"), line("you moron", 990_000), line("next", 995_000), ""].join("\n");
	const p = { text: "you moron", at: 1_000_000, attempts: 0 };
	const r = scrubLines(file, [p], "S1");
	expect(r.removed).toEqual([p]);
	expect(r.text).toBe([line("you moron", 1_000), line("hello", 900_000), line("you moron", 950_000, "S2"), line("next", 995_000), ""].join("\n"));
});

test("scrubLines leaves the file alone when the line is not written yet, or only an old one matches", () => {
	const file = [line("you moron", 1_000), line("hello", 990_000), "not json", ""].join("\n");
	expect(scrubLines(file, [{ text: "you moron", at: 1_000_000, attempts: 0 }], "S1")).toEqual({ text: null, removed: [] });
});

test("queued removals retry a few ticks, then are logged as missed without the text", () => {
	const s = new Suite(loadConfig({}));
	s.queueScrub("you moron", 1);
	for (let i = 0; i < SCRUB_ATTEMPTS - 1; i++) s.settleScrubs([]);
	expect(s.pendingScrubs).toHaveLength(1);
	s.settleScrubs([]);
	expect(s.pendingScrubs).toHaveLength(0);
	const log = JSON.stringify(s.takeLog());
	expect(log).toContain("history-scrub-missed");
	expect(log).not.toContain("moron");
	const off = new Suite(loadConfig({ scrubHistory: false }));
	off.queueScrub("you moron", 1);
	expect(off.pendingScrubs).toHaveLength(0);
});
