// ctx-suite/hooks/lib/shape.ts — compaction-input shaping.
//
// pi's context-manager shaped every model request; Claude Code pins a
// request's messages, so the same rules run on the messages a compaction
// summarizes (session.compact's e.messages). A tool output that is stale,
// superseded, duplicated, or one of an identical-error loop is replaced by a
// one-line stub, so the summarizer neither spends attention on it nor carries
// it forward. The newest messages (the protected tail) are never touched.
//
// A message handed back with its engine `handle` stands as the engine has it;
// a stubbed message is rebuilt from role, text and tool blocks (no handle).

import type { SessionMessage } from "claude-code";
import { actionKey, actionLabel, backgroundStart, errorOrigin, estimateTokens, fingerprint, isWriteTool, pathOf } from "./spans.ts";

export type ShapeKind = "error-loop" | "resolved" | "stale" | "superseded" | "duplicate";

export interface ShapeOptions {
	/** Outputs below this many tokens are left alone (except error loops). */
	dumpTokens: number;
	/** Identical failures needed to collapse a loop. */
	errorLoopMin: number;
	/** The newest messages totalling at least this many tokens are protected. */
	protectTokens: number;
	/** ...and at least this many messages. */
	protectMessages: number;
	/** Files that changed outside the session: path → mtime (the probe). */
	changedAt: ReadonlyMap<string, number>;
	/** When each tool result was captured: tool_use_id → epoch ms (from the spans). */
	capturedAt: ReadonlyMap<string, number>;
}

export interface ShapeResult {
	messages: readonly SessionMessage[];
	stubbed: number;
	byKind: Record<ShapeKind, number>;
	tokensSaved: number;
	/** Paths whose earlier reads are stale, oldest first (named in the instructions when stubs are withheld). */
	staleReads: string[];
}

interface Call {
	id: string;
	tool: string;
	argsKey: string;
	/** lib/spans.ts actionKey: links a failure to the later runs of the same action. */
	action: string;
	path?: string;
	text: string;
	tok: number;
	isError: boolean;
	msg: number;
}

const ARGS_CAP = 2048;

/** Tool name + arguments with sorted keys, capped. */
export function argsKey(tool: string, input: Record<string, unknown>): string {
	const sorted = Object.keys(input)
		.sort()
		.map((k) => [k, input[k]]);
	return `${tool}|${JSON.stringify(sorted)}`.slice(0, ARGS_CAP);
}

/** First line, digits → N: identical failures that differ only by numbers group together. */
export function errorSignature(text: string): string {
	return (text.split("\n", 1)[0] ?? "").trim().replace(/\d+/g, "N").slice(0, 160);
}

function messageTokens(m: SessionMessage): number {
	let n = estimateTokens(m.text);
	for (const u of m.toolUses) n += estimateTokens(u.text ?? "");
	for (const r of m.toolResults ?? []) n += estimateTokens(r.text);
	return n;
}

/** Index of the first protected message. */
export function tailStart(messages: readonly SessionMessage[], protectTokens: number, protectMessages: number): number {
	let tok = 0;
	let i = messages.length;
	while (i > 0 && (tok < protectTokens || messages.length - i < protectMessages)) {
		i--;
		tok += messageTokens(messages[i]!);
	}
	return i;
}

function collectCalls(messages: readonly SessionMessage[]): Call[] {
	const calls: Call[] = [];
	messages.forEach((m, msg) => {
		for (const u of m.toolUses) {
			const text = u.text ?? "";
			calls.push({
				id: u.tool_use_id,
				tool: u.tool,
				argsKey: argsKey(u.tool, u.input),
				action: actionKey(u.tool, u.input),
				path: pathOf(u.input),
				text,
				tok: estimateTokens(text),
				isError: u.isError === true,
				msg,
			});
		}
	});
	return calls;
}

/** Decide which calls to stub, newest-wins. Pure. */
export function planStubs(calls: readonly Call[], resultMsg: ReadonlyMap<string, number>, tail: number, opt: ShapeOptions): Map<string, { kind: ShapeKind; stub: string }> {
	const out = new Map<string, { kind: ShapeKind; stub: string }>();
	const shapeable = (c: Call) => c.msg < tail && (resultMsg.get(c.id) ?? c.msg) < tail && !c.text.startsWith("[ctx-suite");

	const loops = new Map<string, Call[]>();
	for (const c of calls) {
		if (!c.isError) continue;
		const key = `${c.argsKey}|${errorSignature(c.text)}`;
		loops.set(key, [...(loops.get(key) ?? []), c]);
	}
	for (const group of loops.values()) {
		if (group.length < opt.errorLoopMin) continue;
		for (const c of group.slice(0, -1)) {
			if (shapeable(c)) out.set(c.id, { kind: "error-loop", stub: `[ctx-suite: ${c.tool} failed identically ×${group.length}; the newest failure is kept]` });
		}
	}

	// A failure a later run of the same action fixed is history, not the bug at hand.
	const laterOk = new Set<string>();
	for (let i = calls.length - 1; i >= 0; i--) {
		const c = calls[i]!;
		if (c.isError && !out.has(c.id) && laterOk.has(c.action) && shapeable(c)) {
			out.set(c.id, { kind: "resolved", stub: `[ctx-suite: this ${c.tool} run failed; a later run of the same action succeeded]` });
		}
		if (!c.isError && !backgroundStart(c.text)) laterOk.add(c.action);
	}

	// One pass builds the newest index of each write path, call and output, so the
	// stale / superseded / duplicate checks below are O(n), not O(n²).
	const lastWrite = new Map<string, number>();
	const lastArgs = new Map<string, number>();
	const lastFp = new Map<string, number>();
	const fp = new Map<number, string>();
	calls.forEach((c, i) => {
		if (c.isError) return;
		if (isWriteTool(c.tool) && c.path) lastWrite.set(c.path, i);
		lastArgs.set(c.argsKey, i);
		// a duplicate has the same text, so the same size: only big outputs need a fingerprint
		if (c.tok >= opt.dumpTokens) {
			const f = fingerprint(c.text);
			fp.set(i, f);
			lastFp.set(f, i);
		}
	});
	calls.forEach((c, i) => {
		if (out.has(c.id) || c.isError || c.tok < opt.dumpTokens || !shapeable(c)) return;
		const changed = c.path ? opt.changedAt.get(c.path) : undefined;
		const captured = opt.capturedAt.get(c.id);
		const changedOutside = changed !== undefined && captured !== undefined && captured < changed;
		if (c.tool === "Read" && c.path && ((lastWrite.get(c.path) ?? -1) > i || changedOutside)) {
			out.set(c.id, { kind: "stale", stub: `[ctx-suite: stale read of ${c.path}; the file changed after this read]` });
		} else if ((lastArgs.get(c.argsKey) ?? -1) > i) {
			out.set(c.id, { kind: "superseded", stub: `[ctx-suite: superseded ${c.tool} output; the same call ran again later]` });
		} else if ((lastFp.get(fp.get(i) ?? "") ?? -1) > i) {
			out.set(c.id, { kind: "duplicate", stub: `[ctx-suite: duplicate ${c.tool} output; an identical one follows]` });
		}
	});
	return out;
}

export function shapeMessages(messages: readonly SessionMessage[], opt: ShapeOptions): ShapeResult {
	const byKind: Record<ShapeKind, number> = { "error-loop": 0, resolved: 0, stale: 0, superseded: 0, duplicate: 0 };
	const calls = collectCalls(messages);
	const resultMsg = new Map<string, number>();
	messages.forEach((m, i) => {
		for (const r of m.toolResults ?? []) resultMsg.set(r.tool_use_id, i);
	});
	const stubs = planStubs(calls, resultMsg, tailStart(messages, opt.protectTokens, opt.protectMessages), opt);
	if (stubs.size === 0) return { messages, stubbed: 0, byKind, tokensSaved: 0, staleReads: [] };

	let tokensSaved = 0;
	const staleReads = new Set<string>();
	for (const c of calls) {
		const s = stubs.get(c.id);
		if (!s) continue;
		byKind[s.kind]++;
		tokensSaved += Math.max(0, c.tok - estimateTokens(s.stub));
		if (s.kind === "stale" && c.path) staleReads.add(c.path);
	}
	const rebuilt = messages.map((m): SessionMessage => {
		const touches = m.toolUses.some((u) => stubs.has(u.tool_use_id)) || (m.toolResults ?? []).some((r) => stubs.has(r.tool_use_id));
		if (!touches) return m;
		return {
			role: m.role,
			text: m.text,
			toolUses: m.toolUses.map((u) => {
				const s = stubs.get(u.tool_use_id);
				if (!s) return u;
				const { result: _dropped, ...rest } = u;
				return { ...rest, text: s.stub };
			}),
			...(m.toolResults
				? {
						toolResults: m.toolResults.map((r) => {
							const s = stubs.get(r.tool_use_id);
							if (!s) return r;
							const { result: _dropped, ...rest } = r;
							return { ...rest, text: s.stub };
						}),
					}
				: {}),
		};
	});
	return { messages: rebuilt, stubbed: stubs.size, byKind, tokensSaved, staleReads: [...staleReads] };
}

/**
 * Actions whose newest run in `messages` failed (the harness's refusals aside),
 * newest first: what the session is most likely debugging. A compaction keeps
 * their latest error output verbatim, so the work can go on from the summary.
 */
export function liveFailures(messages: readonly SessionMessage[], limit = 8): string[] {
	const last = new Map<string, { isError: boolean; text: string; path?: string; at: number }>();
	let n = 0;
	for (const m of messages) {
		for (const u of m.toolUses) {
			// a run sent to the background neither fails nor passes here
			if (u.isError !== true && backgroundStart(u.text ?? "")) continue;
			last.set(actionKey(u.tool, u.input), { isError: u.isError === true, text: u.text ?? "", path: pathOf(u.input), at: n++ });
		}
	}
	return [...last]
		.filter(([, v]) => v.isError && errorOrigin(v.text) === "command")
		.sort((a, b) => b[1].at - a[1].at)
		.slice(0, limit)
		.map(([action, v]) => actionLabel(action, v.path));
}
