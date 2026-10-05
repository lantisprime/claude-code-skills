// Hook wiring against the engine's own $: the test's hooks sit beneath the mod and stand for core.

import type { On, SessionMessage } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";
import { MARK } from "../hooks/lib/suite.ts";

/** The nouns beneath the mod that the tests do not exercise: a clock and a small, fresh context. */
function world(on: On, tokens = 5_000) {
	mock.clock(on, { now: 1_000_000 });
	on("session.usage", () => ({ value: { startedAt: 0, context: { tokens, window: 200_000, percent: Math.round(tokens / 2_000) }, rateLimits: [] } }));
	on("session.model", () => ({ value: "opus" }));
}

/** A slash command as the person types it at a terminal. */
const run = ($: Engine, command: string, args = "") => $.command.run({ command, args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } });

/** A stale read (the file was edited after it), then a short protected tail. */
function convo(): SessionMessage[] {
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

test("every compaction gets ctx-suite's focus instructions after the person's own", async ($, on) => {
	world(on);
	let seen: { instructions?: string; messages: readonly SessionMessage[] } | undefined;
	on("session.compact", ($, e) => {
		seen = { instructions: e.instructions, messages: e.messages };
		return { messages: e.messages.slice(-2) };
	});
	const r = await $.session.compact({ trigger: "manual", instructions: "keep the deploy plan", messages: convo() });
	expect(r.skip).toBeUndefined();
	expect(seen?.instructions).toMatch(/^keep the deploy plan\n\n\[ctx-suite focus\] Preserve ALL information/);
	// the stale read reaches the summarizer as a stub; the rest keep their handles
	expect(seen?.messages[1]?.toolUses[0]?.text).toMatch(/^\[ctx-suite: stale read of \/a\.ts/);
	expect(seen?.messages[1]?.handle).toBeUndefined();
	expect(seen?.messages[3]?.handle).toBe("h3");
	const { text } = await run($, "ctx-health");
	expect(text).toMatch(/last compaction: manual, 1 outputs stubbed/);
});

test("shaping off: the engine's messages go on untouched", { options: { shapeCompactions: false } }, async ($, on) => {
	world(on);
	let first: SessionMessage | undefined;
	on("session.compact", ($, e) => {
		first = e.messages[1];
		return { messages: e.messages.slice(-2) };
	});
	await $.session.compact({ trigger: "auto", messages: convo() });
	expect(first?.handle).toBe("h1");
});

test("instructions ctx-suite already wrote are not doubled", async ($, on) => {
	world(on);
	let instructions: string | undefined;
	on("session.compact", ($, e) => {
		instructions = e.instructions;
		return { messages: e.messages.slice(-2) };
	});
	await $.session.compact({ trigger: "plugin", instructions: `${MARK} mine`, messages: convo() });
	expect(instructions).toBe(`${MARK} mine`);
});

test("task tools feed the board /ctx-health reports", async ($, on) => {
	world(on);
	on("tool.call", { tool: "TaskCreate" }, () => ({ result: { task: { id: "7", subject: "Fix the herdr parser" } } }));
	await $.tool.call({ tool: "TaskCreate", subject: "Fix the herdr parser", description: "pane refs" });
	const { text } = await run($, "ctx-health");
	expect(text).toContain("tasks: active — Fix the herdr parser");
	expect(text).toContain("redaction: on");
});

test("a denied tool call is not recorded as a span", async ($, on) => {
	world(on);
	on("tool.call", { tool: "Bash" }, () => ({ deny: "no" }));
	await $.tool.call({ tool: "Bash", command: "rm -rf /" });
	const { text } = await run($, "ctx-health");
	expect(text).toMatch(/^spans: 0 /);
});

test("/compact-why names the judge guardrails from the options", { options: { judgeMaxCallsPerHour: 3, allowAggressive: false } }, async ($, on) => {
	world(on);
	const { text } = await run($, "compact-why");
	expect(text).toContain("judge: claude-sonnet-5-5 · effort low");
	expect(text).toContain("≤3/h");
	expect(text).toContain("aggressive <0.35 (disabled)");
});

test("/compact-smart reports the decision without compacting an empty session", async ($, on) => {
	world(on);
	let compacted = false;
	on("session.compact", ($, e) => {
		compacted = true;
		return { messages: e.messages };
	});
	const { text } = await run($, "compact-smart");
	expect(text).toMatch(/^no compaction — /); // Claude Code adds the plugin name itself
	expect(compacted).toBe(false);
});

test("/ctx-task pins the task the focus instructions name", async ($, on) => {
	world(on);
	let instructions: string | undefined;
	on("session.compact", ($, e) => {
		instructions = e.instructions;
		return { messages: e.messages.slice(-2) };
	});
	expect((await run($, "ctx-task", "ship the ingest codec")).text).toBe("tasks (active): ship the ingest codec");
	await $.session.compact({ trigger: "manual", messages: convo() });
	expect(instructions).toContain("current tasks: ship the ingest codec");
});

test("a submitted prompt becomes the task subject when no task tools ran", async ($, on) => {
	world(on);
	on("prompt.submit", ($, e) => ({ text: e.text }));
	await $.prompt.submit({ text: "Implement REQ-077 in platform/src" });
	const { text } = await run($, "ctx-health");
	expect(text).toContain("tasks: prompts — Implement REQ-077 in platform/src");
});
