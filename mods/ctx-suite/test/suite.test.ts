// Suite-level regressions from the second (GLM-5.3) review: turn depth, the forced-run guard, the judge excerpt.

import type { ModelCompleteRequest, SessionMessage } from "claude-code";
import { expect, test } from "claude-code/testing";
import { loadConfig } from "../hooks/lib/config.ts";
import { Suite, type Io } from "../hooks/lib/suite.ts";

const KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0kLmN";
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

test("a subagent's turn pauses smart timing and its completion releases it", () => {
	const s = new Suite(loadConfig({}));
	s.onTurnStart(); // background agent: its turn.start has no agentId
	expect(s.turnRunning).toBe(true);
	s.onTurnEnd(false); // its turn.complete carries one
	expect(s.turnRunning).toBe(false);
	s.onTurnStart();
	s.onTurnStart();
	s.onTurnEnd(true); // a main-loop completion resyncs: a lost completion cannot wedge the count
	expect(s.turnRunning).toBe(false);
	s.onTurnEnd(false);
	expect(s.turnDepth).toBe(0);
});

/** A session past the fire line with an active task, so evaluate reaches the judge. */
function ready(messages: SessionMessage[], seen: ModelCompleteRequest[]): { s: Suite; io: Io } {
	const s = new Suite(loadConfig({}));
	Object.assign(s.rt.engine, { turnsSinceCompaction: 10, growthPerTurn: 2_000, cacheModelKey: "claude-opus-5-5", lastLLMCallAt: 999_000, sessionModel: "opus" });
	s.rt.board = { rows: { "1": { subject: "fix the herdr parser", status: "in_progress" } } };
	const io: Io = {
		context: async () => ({ tokens: 120_000, window: 200_000 }),
		now: async () => 1_000_000,
		messages: async () => messages,
		complete: async (req) => {
			seen.push(req);
			return { isAnswered: true, text: '{"p": 0.5}', usage: USAGE };
		},
		compact: async () => ({ messages: [] }),
		model: async () => "opus",
	};
	return { s, io };
}

test("/compact-smart never compacts into a running turn", async () => {
	const { s, io } = ready([{ role: "user", text: "hello", toolUses: [] }, { role: "assistant", text: "hi", toolUses: [] }], []);
	s.onTurnStart();
	expect(await s.evaluate(io, true)).toBe("a turn is running; not compacting");
});

test("the judge excerpt is redacted message by message, even past a large early redaction", async () => {
	const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"k".repeat(9_000)}\n-----END RSA PRIVATE KEY-----`;
	const seen: ModelCompleteRequest[] = [];
	const msgs: SessionMessage[] = [
		{ role: "user", text: pem, toolUses: [] },
		{ role: "user", text: `${"w".repeat(3_980)} ${KEY} tail`, toolUses: [] },
		{ role: "assistant", text: "a", toolUses: [] },
		{ role: "assistant", text: "b", toolUses: [] },
	];
	const { s, io } = ready(msgs, seen);
	await s.evaluate(io, true);
	expect(seen).toHaveLength(1);
	expect(seen[0]?.prompt).not.toContain(KEY.slice(0, 12));
	expect(seen[0]?.prompt).toContain("[REDACTED:pem]");
});

// --- live-eval fixes (2026-10-05 NIAH run): cache-aware stubbing, prompt subjects, /ctx-task, probe rotation ---

/** A Read of /a.ts the session later edited, ahead of a protected tail. */
function staleConvo(): SessionMessage[] {
	const read = "old a.ts " + "x".repeat(4_000);
	return [
		{ role: "user", text: "fix a.ts", toolUses: [], handle: "h0" },
		{ role: "assistant", text: "", toolUses: [{ tool_use_id: "r1", tool: "Read", input: { file_path: "/a.ts" }, text: read }], handle: "h1" },
		{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "r1", text: read, isError: false }], handle: "h2" },
		{ role: "assistant", text: "", toolUses: [{ tool_use_id: "e1", tool: "Edit", input: { file_path: "/a.ts" }, text: "ok" }], handle: "h3" },
		{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "e1", text: "ok", isError: false }], handle: "h4" },
		...Array.from({ length: 8 }, (_, i): SessionMessage => ({ role: i % 2 ? "assistant" : "user", text: "y".repeat(24_000), toolUses: [], handle: `t${i}` })),
	];
}

test("a hot cache withholds stubs: the engine's list goes on as is and the stale read is named instead", () => {
	const s = new Suite(loadConfig({}));
	s.rt.engine.lastLLMCallAt = 1_000_000 - 30_000; // a turn 30 s ago
	const msgs = staleConvo();
	const { instructions, shaped, withheld } = s.shapeCompaction("manual", undefined, msgs, 1_000_000, "opus");
	expect(withheld).toBe(1);
	expect(shaped.stubbed).toBe(0);
	expect(shaped.messages).toBe(msgs);
	expect(instructions).toContain("changed after they were read");
	expect(instructions).toContain("/a.ts");
});

test("a cold cache stubs: nothing is cached to break", () => {
	const s = new Suite(loadConfig({}));
	s.rt.engine.lastLLMCallAt = 1_000_000 - 2 * 3_600_000; // two hours idle
	const { instructions, shaped, withheld } = s.shapeCompaction("auto", undefined, staleConvo(), 1_000_000, "opus");
	expect(withheld).toBe(0);
	expect(shaped.stubbed).toBe(1);
	// a model switched since the last turn is cold too
	Object.assign(s.rt.engine, { lastLLMCallAt: 1_000_000 - 30_000, sessionModel: "opus" });
	expect(s.shapeCompaction("auto", undefined, staleConvo(), 1_000_000, "sonnet").withheld).toBe(0);
	expect(s.shapeCompaction("auto", undefined, staleConvo(), 1_000_000, "opus").withheld).toBe(1);
	expect(shaped.messages[1]?.toolUses[0]?.text).toMatch(/^\[ctx-suite: stale read of \/a\.ts/);
	expect(instructions).not.toContain("changed after they were read");
});

test("with no task rows, the first and latest prompts are the subjects (redacted; slash commands skipped)", () => {
	const s = new Suite(loadConfig({}));
	expect(s.tasks().state).toBe("none");
	s.onPrompt(`Implement REQ-077 in platform/src; token=${KEY}`);
	s.onPrompt("/compact");
	expect(s.tasks()).toEqual({ state: "prompts", activeSubjects: ["Implement REQ-077 in platform/src; token=[REDACTED:openai]"], settledCount: 0 });
	s.onPrompt("now read the ops runbooks");
	expect(s.tasks().activeSubjects).toEqual(["Implement REQ-077 in platform/src; token=[REDACTED:openai]", "now read the ops runbooks"]);
	expect(s.instructionsFor("focused")).toContain("Implement REQ-077");
	// task rows, once there are any, take over
	s.pinTask("fix the herdr parser");
	expect(s.tasks()).toEqual({ state: "active", activeSubjects: ["fix the herdr parser"], settledCount: 0 });
});

test("/ctx-task pins, settles and clears a task; TodoWrite keeps the pin", () => {
	const s = new Suite(loadConfig({}));
	expect(s.pinTask("")).toBe("tasks (none): none");
	expect(s.pinTask("done")).toBe("no pinned task");
	expect(s.pinTask("ship the ingest codec")).toBe("tasks (active): ship the ingest codec");
	s.onToolResult("TodoWrite", "t1", { todos: [{ content: "write tests", status: "pending" }] }, "ok", false, undefined, 1);
	expect(s.tasks().activeSubjects).toEqual(["ship the ingest codec", "write tests"]);
	s.onToolResult("TodoWrite", "t2", { todos: [{ content: "write tests", status: "completed" }] }, "ok", false, undefined, 2);
	expect(s.pinTask("done")).toBe("tasks (settled): 2 settled");
	expect(s.pinTask("clear")).toBe("tasks (settled): 1 settled");
});

test("the per-turn staleness probe rotates through every read path; a compaction probes them all", () => {
	const s = new Suite(loadConfig({}));
	for (let i = 0; i < 42; i++) s.onToolResult("Read", `r${i}`, { file_path: `/f${i}.ts` }, `file ${i} ` + "z".repeat(50), false, undefined, i);
	const seen = new Set<string>();
	for (let turn = 0; turn < 3; turn++) {
		const batch = s.probeTargets();
		expect(batch.length).toBe(20);
		for (const t of batch) seen.add(t.path);
	}
	expect(seen.size).toBe(42); // the eval's touched file was the 18th of 42: the old newest-20 window never reached it
	expect(s.probeTargets(true).length).toBe(42);
	// past the cap, the compaction sweep keeps the newest reads
	for (let i = 42; i < 250; i++) s.onToolResult("Read", `r${i}`, { file_path: `/f${i}.ts` }, `file ${i} ` + "z".repeat(50), false, undefined, i);
	const swept = s.probeTargets(true).map((t) => t.path);
	expect(swept.length).toBe(200);
	expect(swept).toContain("/f249.ts");
	expect(swept).not.toContain("/f0.ts");
});

test("prompt subjects: the keyword fallback answers neutral, since the excerpt quotes the first prompt", async () => {
	const s = new Suite(loadConfig({ judgeEnabled: false }));
	Object.assign(s.rt.engine, { turnsSinceCompaction: 10, growthPerTurn: 2_000, cacheModelKey: "claude-opus-5-5", lastLLMCallAt: 999_000, sessionModel: "opus" });
	s.onPrompt("Implement REQ-077 in platform/src codec-lzw");
	const msgs: SessionMessage[] = [
		{ role: "user", text: "Implement REQ-077 in platform/src codec-lzw", toolUses: [] },
		{ role: "assistant", text: "reading platform/src codec-lzw", toolUses: [] },
	];
	const io: Io = {
		context: async () => ({ tokens: 120_000, window: 200_000 }),
		now: async () => 1_000_000,
		messages: async () => msgs,
		complete: async () => Promise.reject(new Error("judge disabled")),
		compact: async () => ({ messages: [] }),
		model: async () => "opus",
	};
	await s.evaluate(io, true);
	expect(s.rt.lastGate).toMatchObject({ source: "heuristic", probability: 0.5, action: "focused" });
});
