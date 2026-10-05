// Pure-library tests: redaction, compaction shaping, task board, relevance gate, config guardrails.

import type { ModelCompleteRequest, ModelCompleteResult, SessionMessage } from "claude-code";
import { expect, test } from "claude-code/testing";
import { loadConfig } from "../hooks/lib/config.ts";
import { heuristicRelevance, parseJudge, relevanceGate, type JudgeGuardrails } from "../hooks/lib/gate.ts";
import { compilePatterns, redactBlocks, redactText } from "../hooks/lib/redact.ts";
import { shapeMessages, tailStart } from "../hooks/lib/shape.ts";
import { classify, fingerprint, health, markStale, type Span } from "../hooks/lib/spans.ts";
import { applyTaskCall, emptyBoard, viewBoard } from "../hooks/lib/tasks.ts";

const KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0kLmN";

test("redaction: battery, key names kept, idempotent, custom patterns", () => {
	const r = redactText(`key ${KEY} and api_key="hunter2" and AKIA${"ABCDEFGHIJKLMNOP"}`);
	expect(r.text).not.toContain(KEY);
	expect(r.text).toContain("[REDACTED:openai]");
	expect(r.text).toContain("api_key=[REDACTED:assignment]");
	expect(r.kinds).toEqual({ openai: 1, aws: 1, assignment: 1 });
	expect(redactText(r.text).text).toBe(r.text);
	for (const leak of ["GITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz123456", "access_token: abcdefghijklmnopqrstuvwxyz12", '{"password": "hunter2hunter2"}', "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"]) {
		expect(redactText(leak).text).toContain("[REDACTED:assignment]");
	}
	expect(redactText('{"password": "hunter2hunter2"}').text).toBe('{"password": [REDACTED:assignment]}'); // pi drops the quotes too
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
	expect(redactText(pem).text).toBe("[REDACTED:pem]");
	const { patterns, invalid } = compilePatterns(["corp-[0-9]{6}", "(unclosed", "x*", "a".repeat(201)]);
	expect(invalid).toEqual(["(unclosed", "x*", "a".repeat(201)]);
	expect(redactText("id corp-123456", patterns).text).toBe("id [REDACTED:custom]");
});

test("redactBlocks rewrites text and tool_result content, or answers null", () => {
	const r = redactBlocks([
		{ type: "tool_result", tool_use_id: "t1", content: `out ${KEY}` },
		{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: `Bearer ${"x".repeat(30)}` }] },
		{ type: "image", source: {} },
	]);
	expect(r?.content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "out [REDACTED:openai]" });
	expect(r?.content[1]).toEqual({ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "[REDACTED:bearer]" }] });
	expect(r?.content[2]).toEqual({ type: "image", source: {} });
	expect(redactBlocks([{ type: "text", text: "nothing secret" }])).toBeNull();
});

test("spans: classify, staleness, token-weighted health", () => {
	const spans: Span[] = [{ id: "1", tool: "Read", hash: fingerprint("a"), tok: 300, cls: "fresh", path: "/x.ts", at: 1 }];
	expect(classify("a", false, fingerprint("a"), spans)).toBe("dup");
	expect(classify("Process exited with exit code 2", false, "h", spans)).toBe("error");
	expect(classify("b", false, fingerprint("b"), spans)).toBe("fresh");
	expect(markStale(spans, "/x.ts", 5)).toBe(1);
	spans.push({ id: "2", tool: "Bash", hash: "h", tok: 100, cls: "fresh", at: 6 });
	expect(health(spans)).toEqual({ spans: 2, tokens: 400, share: { fresh: 25, stale: 75, dup: 0, error: 0 }, impurity: 0.75 });
});

// --- shaping ---
const big = (s: string) => s + "x".repeat(4_000);
let n = 0;
function call(tool: string, input: Record<string, unknown>, text: string, isError = false): SessionMessage[] {
	const id = `t${++n}`;
	return [
		{ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool, input, text, ...(isError ? { isError: true as const } : {}) }], handle: `a${id}` },
		{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text, isError }], handle: `u${id}` },
	];
}
function convo(): SessionMessage[] {
	n = 0;
	return [
		{ role: "user", text: "start", toolUses: [], handle: "h0" },
		...call("Read", { file_path: "/a.ts" }, big("old a")), // t1 stale (edited later)
		...call("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }, "ok"), // t2
		...call("Bash", { command: "npm test" }, "Error: failed at 12", true), // t3 loop
		...call("Bash", { command: "npm test" }, "Error: failed at 13", true), // t4 loop
		...call("Bash", { command: "npm test" }, "Error: failed at 14", true), // t5 newest, kept
		...call("Bash", { command: "ls" }, big("files v1")), // t6 superseded
		...call("Bash", { command: "cat log" }, big("same")), // t7 duplicate of t8
		...call("Bash", { command: "cat log2" }, big("same")), // t8
		...call("Bash", { command: "ls" }, big("files v2")), // t9
		{ role: "assistant", text: "done", toolUses: [], handle: "h-end" },
	];
}
const OPT = { dumpTokens: 800, errorLoopMin: 3, protectTokens: 10, protectMessages: 2, changedAt: new Map<string, number>(), capturedAt: new Map<string, number>() };

test("shape: stale, error-loop, superseded and duplicate outputs are stubbed; the rest keep their handles", () => {
	const msgs = convo();
	const r = shapeMessages(msgs, OPT);
	expect(r.byKind).toEqual({ "error-loop": 2, stale: 1, superseded: 1, duplicate: 1 });
	expect(r.stubbed).toBe(5);
	expect(r.tokensSaved).toBeGreaterThan(2_900);
	const text = (id: string) => r.messages.flatMap((m) => m.toolUses).find((u) => u.tool_use_id === id)?.text ?? "";
	const result = (id: string) => r.messages.flatMap((m) => m.toolResults ?? []).find((u) => u.tool_use_id === id)?.text ?? "";
	expect(text("t1")).toMatch(/^\[ctx-suite: stale read of \/a\.ts/);
	expect(result("t1")).toBe(text("t1"));
	expect(text("t3")).toMatch(/failed identically ×3/);
	expect(text("t5")).toBe("Error: failed at 14");
	expect(text("t6")).toMatch(/superseded Bash/);
	expect(text("t7")).toMatch(/duplicate Bash/);
	expect(text("t8")).toBe(big("same"));
	expect(r.messages.filter((m) => m.handle === undefined)).toHaveLength(10); // 5 calls × (assistant + user)
	expect(r.messages[0]).toBe(msgs[0]);
});

test("shape: the protected tail is never touched, and no stub returns the same array", () => {
	const msgs = convo();
	expect(tailStart(msgs, 10, msgs.length)).toBe(0);
	const r = shapeMessages(msgs, { ...OPT, protectMessages: msgs.length });
	expect(r.stubbed).toBe(0);
	expect(r.messages).toBe(msgs);
});

test("shape: a file changed outside stubs only the reads captured before the change", () => {
	n = 0;
	const msgs = [
		...call("Read", { file_path: "/b.ts" }, big("b v1")), // t1, captured at 100
		...call("Read", { file_path: "/b.ts", offset: 1 }, big("b v2")), // t2, captured at 300, after the change
		{ role: "user" as const, text: "next", toolUses: [] },
	];
	const opt = { ...OPT, protectTokens: 0, protectMessages: 1, changedAt: new Map([["/b.ts", 200]]), capturedAt: new Map([["t1", 100], ["t2", 300]]) };
	const r = shapeMessages(msgs, opt);
	expect(r.byKind.stale).toBe(1);
	const text = (id: string) => r.messages.flatMap((m) => m.toolUses).find((u) => u.tool_use_id === id)?.text ?? "";
	expect(text("t1")).toMatch(/^\[ctx-suite: stale read/);
	expect(text("t2")).toBe(big("b v2"));
	// a read with no capture time (its span was dropped) is never guessed stale
	expect(shapeMessages(msgs, { ...opt, capturedAt: new Map() }).stubbed).toBe(0);
});

test("shape: a failed edit does not make the earlier read stale", () => {
	n = 0;
	const msgs = [
		...call("Read", { file_path: "/c.ts" }, big("c")),
		...call("Edit", { file_path: "/c.ts", old_string: "a", new_string: "b" }, "old_string not found", true),
		{ role: "user" as const, text: "next", toolUses: [] },
	];
	expect(shapeMessages(msgs, { ...OPT, protectTokens: 0, protectMessages: 1 }).stubbed).toBe(0);
});

test("shape: 600 distinct 16 KB outputs plan in linear time", () => {
	n = 0;
	const msgs = Array.from({ length: 600 }, (_, i) => call("Bash", { command: `cmd ${i}` }, `${i} ` + "z".repeat(16_000))).flat();
	const t0 = Date.now();
	const r = shapeMessages(msgs, OPT);
	expect(r.stubbed).toBe(0);
	expect(Date.now() - t0).toBeLessThan(2_000);
});

// --- task board ---
test("task board: create, progress, settle, delete, TodoWrite replace", () => {
	let b = applyTaskCall(emptyBoard(), "TaskCreate", { subject: "Fix parser", description: "" }, { task: { id: "1", subject: "Fix parser" } });
	b = applyTaskCall(b, "TaskCreate", { subject: "Ship PR", description: "" }, { task: { id: "2", subject: "Ship PR" } });
	b = applyTaskCall(b, "TaskUpdate", { taskId: "2", status: "in_progress" }, {});
	expect(viewBoard(b)).toEqual({ state: "active", activeSubjects: ["Ship PR", "Fix parser"], settledCount: 0 });
	b = applyTaskCall(b, "TaskUpdate", { taskId: "1", status: "completed" }, {});
	b = applyTaskCall(b, "TaskUpdate", { taskId: "2", status: "completed" }, {});
	expect(viewBoard(b)).toEqual({ state: "settled", activeSubjects: [], settledCount: 2 });
	b = applyTaskCall(b, "TaskUpdate", { taskId: "1", status: "deleted" }, {});
	b = applyTaskCall(b, "TaskUpdate", { taskId: "2", status: "deleted" }, {});
	expect(viewBoard(b).state).toBe("none");
	b = applyTaskCall(b, "TodoWrite", { todos: [{ content: "Write docs", status: "pending", activeForm: "" }] }, {});
	expect(viewBoard(b).activeSubjects).toEqual(["Write docs"]);
	expect(applyTaskCall(b, "Bash", {}, {})).toBe(b);
});

// --- relevance gate ---
const G: JudgeGuardrails = {
	enabled: true, model: "claude-sonnet-5-5", effort: "low", timeoutMs: 15_000, maxExcerptChars: 4_000, maxOutputTokens: 256,
	maxCallsPerHour: 6, aggressiveBelow: 0.35, deferAbove: 0.7, allowAggressive: true, fallbackMayBeAggressive: false,
};
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const answer = (text: string) => async (): Promise<ModelCompleteResult> => ({ isAnswered: true, text, usage: USAGE });
const ACTIVE = { state: "active" as const, activeSubjects: ["fix the herdr parser"], settledCount: 0 };

test("gate: the judge answers within guardrails", async () => {
	const seen: ModelCompleteRequest[] = [];
	const complete = async (req: ModelCompleteRequest) => {
		seen.push(req);
		return answer('Sure: {"p": 0.2, "reason": "old work"}')();
	};
	const r = await relevanceGate({ board: ACTIVE, excerpt: "y".repeat(9_000), g: G, now: 10, callsAt: [], complete });
	expect(r.result).toEqual({ probability: 0.2, source: "judge", action: "aggressive", detail: "old work" });
	expect(r.callsAt).toEqual([10]);
	expect(seen[0]?.model).toBe("claude-sonnet-5-5");
	expect(seen[0]?.maxTokens).toBe(256);
	expect(seen[0]?.timeoutMs).toBe(15_000);
	expect(seen[0]?.prompt.length).toBeLessThan(4_200); // excerpt capped
	const tame = await relevanceGate({ board: ACTIVE, excerpt: "e", g: { ...G, allowAggressive: false }, now: 10, callsAt: [], complete });
	expect(tame.result.action).toBe("focused");
	const defer = await relevanceGate({ board: ACTIVE, excerpt: "e", g: G, now: 10, callsAt: [], complete: answer('{"p":0.9}') });
	expect(defer.result.action).toBe("defer");
});

test("gate: rate cap, bad replies and errors fall back to the heuristic, never aggressive by default", async () => {
	const capped = await relevanceGate({ board: ACTIVE, excerpt: "unrelated", g: G, now: 4_000_000, callsAt: [3_999_000, 3_999_001, 3_999_002, 3_999_003, 3_999_004, 3_999_005], complete: answer('{"p":0.1}') });
	expect(capped.result.source).toBe("heuristic");
	expect(capped.result.detail).toMatch(/rate cap/);
	expect(capped.result.action).toBe("focused"); // heuristic p=0 would be aggressive
	expect(capped.callsAt).toHaveLength(6);
	const garbled = await relevanceGate({ board: ACTIVE, excerpt: "x", g: G, now: 1, callsAt: [], complete: answer("maybe?") });
	expect(garbled.result.detail).toBe("judge reply did not parse");
	const failed = await relevanceGate({ board: ACTIVE, excerpt: "x", g: G, now: 1, callsAt: [], complete: async () => ({ isAnswered: false, reason: "aborted", usage: USAGE }) as ModelCompleteResult });
	expect(failed.result.detail).toBe("judge aborted");
	const thrown = await relevanceGate({ board: ACTIVE, excerpt: "x", g: G, now: 1, callsAt: [], complete: async () => Promise.reject(new Error("blocked model")) });
	expect(thrown.result.detail).toBe("judge request refused");
	const loose = await relevanceGate({ board: ACTIVE, excerpt: "x", g: { ...G, enabled: false, fallbackMayBeAggressive: true }, now: 1, callsAt: [], complete: answer("") });
	expect(loose.result.action).toBe("aggressive");
});

test("gate: settled board defers by policy; no board proceeds focused", async () => {
	const settled = await relevanceGate({ board: { state: "settled", activeSubjects: [], settledCount: 3 }, excerpt: "", g: G, now: 1, callsAt: [], complete: answer("") });
	expect(settled.result.source).toBe("task-board");
	expect(settled.result.action).toBe("defer");
	const none = await relevanceGate({ board: { state: "none", activeSubjects: [], settledCount: 0 }, excerpt: "", g: G, now: 1, callsAt: [], complete: answer("") });
	expect(none.result).toEqual({ probability: 0.5, source: "default", action: "focused", detail: "no active tasks" });
	// aggressiveBelow above 0.5 must not turn a no-task default into an aggressive compaction
	const high = await relevanceGate({ board: { state: "none", activeSubjects: [], settledCount: 0 }, excerpt: "", g: { ...G, aggressiveBelow: 0.6, deferAbove: 0.8 }, now: 1, callsAt: [], complete: answer("") });
	expect(high.result.action).toBe("focused");
});

test("judge parse is strict; heuristic is word overlap", () => {
	expect(parseJudge('{"p": 1.5}')).toBeNull();
	expect(parseJudge('{"p": "0.3"}')).toBeNull();
	expect(parseJudge('noise {"p": 0.3} more')).toEqual({ p: 0.3, reason: undefined });
	expect(heuristicRelevance(["fix herdr parser"], "fix the herdr parser now")).toBe(1);
	expect(heuristicRelevance(["fix herdr parser"], "the herdr parser broke")).toBe(2 / 3);
	expect(heuristicRelevance([], "x")).toBe(0.5);
});

test("config clamps every guardrail to a safe range", () => {
	const c = loadConfig({ judgeTimeoutMs: 0, judgeMaxExcerptChars: 1e9, judgeMaxCallsPerHour: -5, aggressiveBelow: 0.9, deferAbove: 0.1, judgeEffort: "max", redactPatterns: "a+  b+", idleSeconds: 1 });
	expect(c.judge.timeoutMs).toBe(1_000);
	expect(c.judge.maxExcerptChars).toBe(20_000);
	expect(c.judge.maxCallsPerHour).toBe(0);
	expect([c.judge.aggressiveBelow, c.judge.deferAbove]).toEqual([0.35, 0.7]);
	expect(c.judge.effort).toBe("low");
	expect(c.redactPatterns).toEqual(["a+", "b+"]);
	expect(c.idleMs).toBe(5_000);
	expect(loadConfig({}).judge.model).toBe("claude-sonnet-5-5");
});
