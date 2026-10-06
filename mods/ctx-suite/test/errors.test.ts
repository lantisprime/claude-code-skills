// Error provenance: each error is tied to the action that produced it, and only
// dead errors (resolved, repeated, harness-refused) count as impurity. A failure
// whose newest run is still failing is live: the session is likely debugging it.

import type { SessionMessage } from "claude-code";
import { expect, test } from "claude-code/testing";
import { loadConfig } from "../hooks/lib/config.ts";
import { liveFailures, shapeMessages } from "../hooks/lib/shape.ts";
import { actionKey, errorOrigin, errorStates, health, normalizeCommand, type Span } from "../hooks/lib/spans.ts";
import { Suite } from "../hooks/lib/suite.ts";

test("actions: a Bash command is normalized; other tools key on their arguments", () => {
	expect(normalizeCommand("cd /repo &&  npm   test")).toBe("npm test");
	expect(normalizeCommand(`cd "/a b"; cd sub && pytest -x tests/api`)).toBe("pytest -x tests/api");
	// a TDD RED run and its GREEN run: different setup steps, the same tests, so they link
	const red = "cd scratch/dry && cp ../b7.patch ../b7.patch.bak && git reset -q && git checkout -q -- . && git apply --include='tools/*' ../b7.patch && python -m pytest tools/seat/tests -q 2>&1 | tail -20";
	const green = "cd scratch/dry && git apply ../b7.patch && python -m pytest tools/seat/tests -q 2>&1 | tail -40";
	expect(normalizeCommand(red)).toBe("python -m pytest tools/seat/tests -q");
	expect(actionKey("Bash", { command: red })).toBe(actionKey("Bash", { command: green }));
	expect(actionKey("Bash", { command: "cd /r && npm test", description: "run tests" })).toBe("Bash|npm test");
	expect(actionKey("Edit", { file_path: "/a.ts", old_string: "x" })).toBe(actionKey("Edit", { old_string: "x", file_path: "/a.ts" }));
	expect(errorOrigin("<tool_use_error>String to replace not found in file.</tool_use_error>")).toBe("harness");
	expect(errorOrigin("The user doesn't want to proceed with this tool use. The tool use was rejected")).toBe("harness");
	expect(errorOrigin("Exit code 1\nFAIL test/checksum.test.js")).toBe("command");
});

const span = (i: number, tool: string, action: string, cls: Span["cls"], tok = 100, origin?: Span["origin"]): Span => ({ id: `t${i}`, tool, hash: `h${i}`, tok, cls, at: i, action, ...(origin ? { origin } : {}) });

test("error states: live while the newest run fails, resolved by a later success, repeated by a later failure", () => {
	const spans = [
		span(0, "Bash", "Bash|npm test", "error", 100, "command"), // fixed later → resolved
		span(1, "Bash", "Bash|npm test", "fresh"),
		span(2, "Bash", "Bash|npm run lint", "error", 100, "command"), // fails again → repeated
		span(3, "Bash", "Bash|npm run lint", "error", 100, "command"), // newest run fails → live
		span(4, "Edit", "Edit|x", "error", 100, "harness"), // refused, then an Edit succeeds → harness (dead)
		span(5, "Edit", "Edit|y", "fresh"),
		span(6, "Bash", "Bash|pytest", "error", 600, "command"), // live
	];
	expect([...errorStates(spans)].sort((a, b) => a[0] - b[0])).toEqual([[0, "resolved"], [2, "repeated"], [3, "live"], [4, "harness"], [6, "live"]]);
	const h = health(spans);
	expect(h.share).toEqual({ fresh: 17, stale: 0, dup: 0, error: 25, live: 58 });
	expect(h.errors).toEqual({ resolved: 1, repeated: 1, harness: 1 });
	expect(h.failing).toEqual(["pytest", "npm run lint"]);
	expect(h.impurity).toBe(0.25); // live failures are not impurity
});

test("a debugging session no longer reads as impure; reading a script that says `exit 1` is not an error", () => {
	const s = new Suite(loadConfig({}));
	s.onToolResult("Read", "r1", { file_path: "/deploy.sh" }, "#!/bin/bash\n[ -f x ] || exit 1\n" + "echo ok\n".repeat(50), false, undefined, 1);
	s.onToolResult("Bash", "b1", { command: "npm test" }, "Exit code 1\nFAIL checksum.test.js\n  expected 4217, got 4271 at src/checksum.js:88\n" + "  at frame\n".repeat(120), true, undefined, 2);
	const h = health(s.rt.spans);
	expect(h.share.error).toBe(0);
	expect(h.share.live).toBeGreaterThan(70);
	expect(h.impurity).toBe(0);
	expect(s.statusText()).toMatch(/^ctx f\d+ s0 d0 e0 L\d+ · sc idle$/);
	expect(s.healthText()).toContain("still failing: npm test");
	// the fix lands: the same action passes, the failure is now dead history
	s.onToolResult("Bash", "b2", { command: "cd /repo && npm test" }, "PASS checksum.test.js", false, undefined, 3);
	const after = health(s.rt.spans);
	expect(after.share.live).toBe(0);
	expect(after.errors.resolved).toBe(1);
	expect(after.impurity).toBeGreaterThan(0.6);
});

const fail = "Exit code 1\nFAIL checksum.test.js\n  expected 4217, got 4271 at src/checksum.js:88\n" + "  at frame\n".repeat(400);
const tail = Array.from({ length: 8 }, (_, i): SessionMessage => ({ role: i % 2 ? "assistant" : "user", text: "y".repeat(24_000), toolUses: [], handle: `t${i}` }));
const call = (id: string, command: string, text: string, isError: boolean): SessionMessage[] => [
	{ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command }, text, isError }], handle: `a${id}` },
	{ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text, isError }], handle: `u${id}` },
];

test("compaction: a still-failing action is named for verbatim keeping; a resolved failure is stubbed on a cold cache", () => {
	const live = [...call("b1", "npm test", fail, true), ...call("g1", "git status", "clean", false), ...tail];
	expect(liveFailures(live)).toEqual(["npm test"]);
	const s = new Suite(loadConfig({}));
	const { instructions } = s.shapeCompaction("manual", undefined, live, 1_000_000, "opus");
	expect(instructions).toContain("still failing when this compaction ran");
	expect(instructions).toContain("`npm test`");
	expect(instructions).toContain("verbatim");
	const fixed = [...call("b1", "npm test", fail, true), ...call("b2", "cd /r && npm test", "PASS", false), ...tail];
	expect(liveFailures(fixed)).toEqual([]);
	const shaped = shapeMessages(fixed, { dumpTokens: 800, errorLoopMin: 3, protectTokens: 40_000, protectMessages: 8, changedAt: new Map(), capturedAt: new Map() });
	expect(shaped.byKind.resolved).toBe(1);
	expect(shaped.messages[0]?.toolUses[0]?.text).toMatch(/^\[ctx-suite: this Bash run failed; a later run of the same action succeeded\]/);
	expect(s.shapeCompaction("manual", undefined, fixed, 1_000_000, "opus").instructions).not.toContain("still failing");
});

test("a background task holds every ctx-suite compaction until its notification is read", async () => {
	const s = new Suite(loadConfig({}));
	Object.assign(s.rt.engine, { turnsSinceCompaction: 10, growthPerTurn: 2_000, cacheModelKey: "claude-opus-5-5", lastLLMCallAt: 999_000, sessionModel: "opus" });
	let compacted = 0;
	const io = {
		context: async () => ({ tokens: 700_000, window: 1_000_000 }),
		now: async () => 1_000_000,
		messages: async () => [],
		complete: async () => ({ isAnswered: true, text: '{"p": 0.5}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
		compact: async () => {
			compacted++;
			return { messages: [] };
		},
		model: async () => "opus",
	};
	// a RED run sent to the background (ctrl+b, or run_in_background)
	s.onToolResult("Bash", "b1", { command: "pytest tools/seat/tests" }, "Command running in background with ID: bk7rq2x. Output is being written to: /tmp/x.output", false, undefined, 1);
	s.onToolResult("Agent", "a1", { prompt: "review" }, "Async agent launched successfully.\nagentId: ad55e3d4", false, undefined, 2);
	expect(s.backgroundPending(1_000_000)).toEqual(["bk7rq2x", "ad55e3d4"]);
	expect(await s.evaluate(io, true)).toBe("no compaction — waiting on 2 background tasks (bk7rq2x, ad55e3d4) until their result is read");
	expect(compacted).toBe(0);
	expect(s.healthText()).toContain("background: bk7rq2x, ad55e3d4 running or unread — compaction holds");
	// the test run reports back (its turn reads it); the agent is still out
	s.onTaskNotification("<task-notification>\n<task-id>bk7rq2x</task-id>\n<status>completed</status>\n</task-notification>");
	expect(await s.evaluate(io, true)).toMatch(/waiting on 1 background task \(ad55e3d4\)/);
	s.onTaskNotification("<task-notification><task-id>ad55e3d4</task-id><status>completed</status></task-notification>");
	expect(s.backgroundPending(1_000_000)).toEqual([]);
	expect(await s.evaluate(io, true)).toMatch(/^compacted/);
	expect(compacted).toBe(1);
	// one never reported back stops holding after 6 h; a failed background RED run is named at compaction until it passes
	s.onToolResult("Bash", "b3", { command: "cd /r && node scripts/slow-red.js" }, "Command running in background with ID: red1", false, undefined, 1_000_000);
	s.onTaskNotification('<task-notification><task-id>red1</task-id><status>completed</status><summary>Background command "node scripts/slow-red.js" completed (exit code 1)</summary></task-notification>');
	expect(s.rt.backgroundFailing).toEqual(["node scripts/slow-red.js"]);
	expect(s.shapeCompaction("manual", undefined, [], 1_000_000, "opus").instructions).toContain("`node scripts/slow-red.js`");
	expect(s.healthText()).toContain("still failing: node scripts/slow-red.js");
	s.onToolResult("Bash", "b4", { command: "node scripts/slow-red.js" }, "ok", false, undefined, 1_000_001); // GREEN
	expect(s.rt.backgroundFailing).toEqual([]);
	s.onToolResult("Bash", "b2", { command: "sleep 99999" }, "Command was moved to the background (ID: zz9)", false, undefined, 1_000_000);
	expect(s.backgroundPending(1_000_000 + 7 * 3_600_000)).toEqual([]);
});

// --- review 2026-10-05 (Sonnet): the reviewer's failing inputs ---

test("review 1: heredocs, loops, continuations and quoted separators never collide into one action", () => {
	const keys = [
		"python - <<'EOF'\nraise SystemExit(1)\nEOF",
		"cat > f.txt <<'EOF'\nhello\nEOF",
		"for f in a b; do echo $f; done",
		"pytest \\\n  tests/x.py",
		'git commit -m "a; b"',
	].map((command) => actionKey("Bash", { command }));
	expect(new Set(keys).size).toBe(keys.length);
	expect(keys[4]).toBe('Bash|git commit -m "a; b"'); // a quoted `;` is not a step
	expect(normalizeCommand('pytest x; echo "exit=$?"')).toBe("pytest x"); // a report step never names the action
});

test("review 2: output that merely prints the harness's background sentence starts no hold", () => {
	const s = new Suite(loadConfig({}));
	s.onToolResult("Bash", "c1", { command: "cat test/errors.test.ts" }, 'const t = "Command running in background with ID: bk7rq2x";\n', false, undefined, 1);
	s.onToolResult("Bash", "c2", { command: "git diff" }, "+ s.onToolResult(... \"Command running in background with ID: zz\")", false, undefined, 2);
	s.onToolResult("Bash", "c3", { command: "x" }, "Command running in background with ID: err1", true, undefined, 3); // a failure is not a start
	expect(s.backgroundPending(10)).toEqual([]);
});

test("review 3: /clear drops the cleared conversation's background holds and failures", () => {
	const s = new Suite(loadConfig({}));
	s.onToolResult("Bash", "b1", { command: "pytest", run_in_background: true }, "Command running in background with ID: q1", false, undefined, 1);
	s.rt.backgroundFailing = ["npm test"];
	s.onSessionEnd("clear");
	expect(s.backgroundPending(10)).toEqual([]);
	expect(s.rt.backgroundFailing).toEqual([]);
});

test("review 4: a passing background run that prints `exit code 1` is not a failure", () => {
	const s = new Suite(loadConfig({}));
	s.onToolResult("Bash", "b1", { command: "node test/exit-codes.js" }, "Command running in background with ID: p1", false, undefined, 1);
	s.onTaskNotification('<task-notification><task-id>p1</task-id><status>completed</status><summary>Background command "node test/exit-codes.js" completed (exit code 0)</summary><result>ok: child returned exit code 1 as expected</result></task-notification>');
	expect(s.rt.backgroundFailing ?? []).toEqual([]);
});

test("review 5 + 6: action keys hold no secrets and no file content, and stay small", () => {
	const s = new Suite(loadConfig({}));
	const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ01";
	s.onToolResult("Bash", "b1", { command: `curl -H "Authorization: Bearer ${token}" https://api.test` }, "Exit code 22", true, undefined, 1);
	s.onToolResult("Write", "w1", { file_path: "/a.ts", content: "SECRET-BODY ".repeat(100_000) }, "ok", false, undefined, 2);
	const saved = JSON.stringify(s.rt);
	expect(saved).not.toContain(token);
	expect(saved).not.toContain("SECRET-BODY");
	expect(s.rt.spans[1]?.action?.startsWith("Write|/a.ts|")).toBe(true);
	expect((s.rt.spans[1]?.action ?? "").length).toBeLessThan(250);
});

test("review 7: re-running the RED test in the background does not resolve its earlier failure", () => {
	const s = new Suite(loadConfig({}));
	s.onToolResult("Bash", "r1", { command: "pytest tests/red" }, "Exit code 1\nFAILED tests/red", true, undefined, 1);
	s.onToolResult("Bash", "r2", { command: "pytest tests/red", run_in_background: true }, "Command running in background with ID: rb2", false, undefined, 2);
	expect(health(s.rt.spans).failing).toEqual(["pytest tests/red"]); // still live
	expect(health(s.rt.spans).errors.resolved).toBe(0);
});

test("review 8 + 9: non-Bash labels say what the call was about; quoted harness words do not make a harness error", () => {
	expect(errorOrigin("Exit code 1\ngrep found: <tool_use_error>String to replace not found</tool_use_error>")).toBe("command");
	const s = new Suite(loadConfig({}));
	s.onToolResult("Agent", "a1", { description: "review the parser", prompt: "long prompt" }, "Async agent launched successfully.\nagentId: ag1", false, undefined, 1);
	expect(s.rt.backgroundLabels?.ag1).toBe("Agent review the parser");
});

// --- 2026-10-06: a stopped background shell sends no task-notification ---

const stopped = (id: string) => `{"message":"Successfully stopped task: ${id} (sleep 3600)","task_id":"${id}","task_type":"local_bash","command":"sleep 3600"}`;

test("a successful TaskStop releases the hold; a failed one, or one naming no held task, changes nothing", () => {
	const s = new Suite(loadConfig({}));
	s.onToolResult("Bash", "w1", { command: "sleep 3600" }, "Command running in background with ID: wt1", false, undefined, 1);
	s.onToolResult("Bash", "w2", { command: "sleep 3601" }, "Command running in background with ID: wt2", false, undefined, 2);
	s.onToolResult("TaskStop", "k0", { task_id: "wt1" }, "<tool_use_error>No task found with ID: wt1</tool_use_error>", true, undefined, 3);
	s.onToolResult("TaskStop", "k1", { task_id: "zz0" }, stopped("zz0"), false, { task_id: "zz0" }, 4);
	expect(s.backgroundPending(10)).toEqual(["wt1", "wt2"]);
	s.onToolResult("TaskStop", "k2", { task_id: "wt1" }, stopped("wt1"), false, { task_id: "wt1", task_type: "local_bash" }, 5);
	// the deprecated shell_id, and an id taken from the structured result alone
	s.onToolResult("KillShell", "k3", { shell_id: "wt2" }, "Successfully killed shell: wt2", false, undefined, 6);
	expect(s.backgroundPending(10)).toEqual([]);
	expect(s.rt.backgroundLabels).toEqual({});
	expect(s.rt.backgroundFailing ?? []).toEqual([]);
	s.onToolResult("Bash", "w3", { command: "sleep 3602" }, "Command running in background with ID: wt3", false, undefined, 7);
	s.onToolResult("TaskStop", "k4", {}, stopped("wt3"), false, { task_id: "wt3" }, 8);
	expect(s.backgroundPending(10)).toEqual([]);
	// the input names a task no longer held, the result the held one: the held one is released
	s.onToolResult("Bash", "w4", { command: "sleep 3603" }, "Command running in background with ID: wt4", false, undefined, 9);
	s.onToolResult("TaskStop", "k5", { task_id: "gone1" }, stopped("wt4"), false, { task_id: "wt4" }, 10);
	expect(s.backgroundPending(11)).toEqual([]);
});

test("a stop is not a failure: a killed notification names nothing, and a stop never clears a real failure", () => {
	const s = new Suite(loadConfig({}));
	// a background agent stopped on purpose: its notification says killed, and may come before the stop's result
	s.onToolResult("Agent", "a1", { description: "review the plan", prompt: "p" }, "Async agent launched successfully.\nagentId: ag1", false, undefined, 1);
	s.onTaskNotification("<task-notification><task-id>ag1</task-id><status>killed</status><summary>Agent \"review the plan\" was stopped</summary></task-notification>");
	s.onToolResult("TaskStop", "k1", { task_id: "ag1" }, stopped("ag1"), false, { task_id: "ag1", task_type: "local_agent" }, 2);
	expect(s.backgroundPending(10)).toEqual([]);
	expect(s.rt.backgroundFailing ?? []).toEqual([]);
	// a killed notification with no TaskStop seen first is not a failure either
	s.onToolResult("Bash", "b1", { command: "sleep 3600" }, "Command running in background with ID: bk1", false, undefined, 3);
	s.onTaskNotification("<task-notification><task-id>bk1</task-id><status>killed</status></task-notification>");
	expect(s.rt.backgroundFailing ?? []).toEqual([]);
	// a RED run that failed, then a stop of the same id: the failure stays named
	s.onToolResult("Bash", "r1", { command: "node scripts/slow-red.js" }, "Command running in background with ID: red1", false, undefined, 4);
	s.onTaskNotification('<task-notification><task-id>red1</task-id><status>completed</status><summary>Background command "node scripts/slow-red.js" completed (exit code 1)</summary></task-notification>');
	s.onToolResult("TaskStop", "k2", { task_id: "red1" }, stopped("red1"), false, { task_id: "red1" }, 5);
	expect(s.rt.backgroundFailing).toEqual(["node scripts/slow-red.js"]);
	expect(health(s.rt.spans).failing).toEqual([]); // the TaskStop result itself is no error and no background start
	expect(s.rt.spans.at(-1)?.bg).toBeUndefined();
});
