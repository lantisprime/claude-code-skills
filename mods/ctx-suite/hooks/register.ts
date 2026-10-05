// ctx-suite — pi's context-manager + smart-compaction, as a Claude Code mod.
// Usage and results: README.md. Wiring only; logic is in lib/suite.ts.
//
// Phase 1 observe: spans + health, store-time redaction, cache-hit %, status, /ctx-health, /ctx-task.
// Phase 2 shape:   every main-loop session.compact gets task-aware instructions; stubs on a cold cache only.
// Prompt screen:  an abusive prompt with no task content is dropped before it enters the session.
// Phase 3 timing:  after a turn, once idle, the cost engine + relevance judge decide whether to
//                  compact; /compact-smart forces an evaluation, /compact-why explains.
//
// Fail-open throughout: every hook's .catch passes the event on unchanged.

import type { Register } from "claude-code";
import { loadConfig } from "./lib/config.ts";
import { DROP_NOTICE } from "./lib/abuse.ts";
import { scrubLines } from "./lib/history.ts";
import { sumSavings } from "./lib/savings.ts";
import { redactBlocks } from "./lib/redact.ts";
import { Suite, freshSnapshot } from "./lib/suite.ts";
import { ringAppend } from "./lib/telemetry.ts";

const RT = { plugin: "ctx-suite", key: "rt" } as const;
/** How often the background tick checks for a due idle evaluation and flushes telemetry. */
const TICK_MS = 5_000;
const noop = () => undefined;
/** Store keys of per-session savings ("savings:<session id>"); the oldest go past this many. */
const SAVINGS_PREFIX = "savings:";
const SAVINGS_KEEP = 1000;

export const register: Register = (on, options) => {
	const s = new Suite(loadConfig(options));
	let logPath: string | undefined;
	let historyPath: string | undefined;
	/** A tick is running; the next ones skip, so evaluations and telemetry flushes never overlap. */
	let ticking = false;

	on("session.start", async ($, e, next) => {
		const held = await $.state.get(RT);
		// A snapshot from an older version of the mod lacks newer fields.
		s.rt = { ...freshSnapshot(), ...held.value };
		s.sessionId = await $.session.id();
		// Lifetime savings: one store entry per session, so concurrent sessions never overwrite each other.
		const keys = (await $.store.keys().catch(() => [] as string[])).filter((k) => k.startsWith(SAVINGS_PREFIX));
		for (const k of keys.slice(0, Math.max(0, keys.length - SAVINGS_KEEP))) await $.store.delete(k).catch(noop);
		const home = await $.env.get("HOME");
		if (home) {
			logPath = `${home}/.claude/cache/ctx-suite/telemetry.jsonl`;
			historyPath = `${(await $.env.get("CLAUDE_CONFIG_DIR")) || `${home}/.claude`}/history.jsonl`;
			// The sessions ctx-suite ran in: eval/baseline.py splits with/without on this list.
			const listPath = `${home}/.claude/cache/ctx-suite/sessions.txt`;
			const id = s.sessionId;
			const list = await $.fs.read(listPath).catch(() => "");
			const ids = (typeof list === "string" ? list : "").split("\n").filter(Boolean);
			if (!ids.includes(id)) await $.fs.write(listPath, `${[...ids, id].slice(-1000).join("\n")}\n`).catch(noop);
		}
		await $.command.register({ name: "ctx-health", description: "ctx-suite: context health (fresh/stale/dup/error shares, cache hit, redaction)" });
		await $.command.register({ name: "compact-smart", description: "ctx-suite: evaluate a smart compaction now (bypasses min-interval, not the guards)" });
		await $.command.register({ name: "ctx-task", description: "ctx-suite: pin the current task (`/ctx-task <text>`), `done`, `clear`, or show the tasks" });
		await $.command.register({ name: "compact-why", description: "ctx-suite: explain the last compaction decision, profile and guardrails" });
		$.ui.status(s.statusText());
		// Background work outlives this dispatch on a timer started here (the engine's pattern).
		$.clock.every(TICK_MS, () => {
			if (ticking) return;
			ticking = true;
			void (async () => {
				const now = await $.clock.now();
				if (s.cfg.smartTiming && s.idleDue !== null && now >= s.idleDue && !s.busy && !s.turnRunning) {
					s.idleDue = null;
					$.ui.status(s.statusText("evaluating"));
					await s.evaluate(
						{
							context: async () => (await $.session.usage()).context,
							now: () => $.clock.now(),
							messages: () => $.session.messages(),
							complete: (req) => $.model.complete(req),
							compact: (instructions) => $.session.compact({ instructions }),
							model: () => $.session.model(),
						},
						false,
					);
					void $.state.set(RT, s.rt).catch(noop);
					const sv = s.savingsEntry();
					if (sv && s.sessionId) void $.store.set(`${SAVINGS_PREFIX}${s.sessionId}`, sv).catch(noop);
					$.ui.status(s.statusText());
				}
				// Remove dropped prompts from the input history once Claude Code has written them.
				if (s.pendingScrubs.length > 0 && historyPath) {
					const path = historyPath;
					// over 4 MiB the read rejects: the attempt counts, and the drop is logged as missed
					const before = await $.fs.read(path).catch(() => null);
					let removed: ReturnType<typeof scrubLines>["removed"] = [];
					if (typeof before === "string") {
						const r = scrubLines(before, s.pendingScrubs, await $.session.id());
						// Write only if nothing was appended since the read; otherwise the next tick retries.
						if (r.text !== null && (await $.fs.read(path).catch(() => null)) === before) {
							const wrote = await $.fs.write(path, r.text).then(() => true, () => false);
							if (wrote) removed = r.removed;
						}
					}
					s.settleScrubs(removed);
				}
				const batch = s.takeLog();
				if (logPath && batch.length > 0) {
					const path = logPath;
					const old = await $.fs.read(path).catch(() => "");
					await $.fs.write(path, ringAppend(typeof old === "string" ? old : "", batch)).catch(noop);
				}
			})()
				.catch(noop)
				.finally(() => {
					ticking = false;
				});
		});
		return next(e);
	}).catch(($, e, next) => next(e));

	// Phase 1: redact secrets in every tool result before it is stored or sent.
	on("session.append", { door: "tool-result" }, ($, e, next) => {
		if (!s.cfg.redact) return next(e);
		const r = redactBlocks(e.message.content, s.custom);
		if (!r) return next(e);
		s.countRedactions(r.kinds);
		void $.state.set(RT, s.rt).catch(noop);
		return next({ ...e, message: { ...e.message, content: r.content } });
	}).catch(($, e, next) => next(e));

	on("tool.call", async ($, e, next) => {
		const r = await next(e);
		if (e.agentId !== undefined || r.deny !== undefined) return r;
		const { tool, tool_use_id, agentId: _a, ...input } = e as { tool: string; tool_use_id: string; agentId?: string } & Record<string, unknown>;
		s.onToolResult(tool, tool_use_id, input, r.text ?? "", r.isError === true, r.result, await $.clock.now());
		void $.state.set(RT, s.rt).catch(noop);
		$.ui.status(s.statusText());
		return r;
	}).catch(($, e, next) => next(e));

	// One main-loop model request: what the savings count per request.
	on("turn.step", async function* ($, e, next) {
		if (e.agentId === undefined) s.onStep(e.model);
		return yield* next(e);
	});

	on("turn.start", async ($, e, next) => {
		// Pauses an armed idle evaluation (the tick waits for depth 0) rather than cancelling it.
		s.onTurnStart();
		// After a /clear no session.start fires: the new id is read here.
		if (s.sessionId === null) s.sessionId = await $.session.id();
		return next(e);
	}).catch(($, e, next) => next(e));

	on("turn.complete", async ($, e, next) => {
		const r = await next(e);
		s.onTurnEnd(e.agentId === undefined);
		if (e.agentId !== undefined) return r;
		const now = await $.clock.now();
		const note = s.onTurnComplete(e.usage, (await $.session.usage()).context, await $.session.model(), now);
		// Staleness probe: a file changed outside the session since it was read.
		for (const t of s.probeTargets()) {
			const st = await $.fs.stat(t.path).catch(noop);
			if (st && st.mtimeMs > t.at) s.onFileChanged(t.path, st.mtimeMs);
		}
		const sv = s.savingsEntry();
		if (sv && s.sessionId) void $.store.set(`${SAVINGS_PREFIX}${s.sessionId}`, sv).catch(noop);
		// Only an answered turn arms the idle evaluation; an interrupted or failed one disarms it.
		s.idleDue = e.reason === "answer" ? now + s.cfg.idleMs : null;
		void $.state.set(RT, s.rt).catch(noop);
		$.ui.status(s.statusText(note));
		return r;
	}).catch(($, e, next) => next(e));

	// Phase 2: instruct and shape every main-loop compaction, whoever started it.
	on("session.compact", async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);
		const at = await $.clock.now();
		// Every read path, not the per-turn window: a change missed here reaches the summary as current.
		for (const t of s.probeTargets(true)) {
			const st = await $.fs.stat(t.path).catch(noop);
			if (st && st.mtimeMs > t.at) s.onFileChanged(t.path, st.mtimeMs);
		}
		const { instructions, shaped, withheld } = s.shapeCompaction(e.trigger, e.instructions, e.messages, at, await $.session.model());
		// The engine's own list goes on untouched unless something was stubbed.
		const r = await next(shaped.stubbed > 0 ? { ...e, instructions, messages: shaped.messages } : { ...e, instructions });
		if (r.skip === undefined && e.trigger !== "precompute") {
			s.afterCompaction(e.trigger, r, shaped.stubbed, withheld, shaped.tokensSaved, at);
			void $.state.set(RT, s.rt).catch(noop);
			const sv = s.savingsEntry();
			if (sv && s.sessionId) void $.store.set(`${SAVINGS_PREFIX}${s.sessionId}`, sv).catch(noop);
			$.ui.status(s.statusText());
		}
		return r;
	}).catch(($, e, next) => next(e));

	// Keep the ending session's savings, then start the next conversation's from zero after a /clear.
	on("session.end", async ($, e, next) => {
		const sv = s.savingsEntry();
		if (sv) await $.store.set(`${SAVINGS_PREFIX}${e.sessionId}`, sv).catch(noop);
		s.onSessionEnd(e.reason);
		return next(e);
	}).catch(($, e, next) => next(e));

	on("prompt.submit", async ($, e, next) => {
		// A background task reported back: its result is read in this prompt's turn.
		if (e.origin?.kind === "task-notification") {
			s.onTaskNotification(e.text);
			void $.state.set(RT, s.rt).catch(noop);
			return next(e);
		}
		// The person's own prompts only: answering without next enters nothing, in the context or the transcript.
		const own = e.origin?.kind === "composer" || e.origin?.kind === "bridge";
		if (own && (await s.screenPrompt(e.text, (e.attachments?.length ?? 0) > 0, (req) => $.model.complete(req)))) {
			s.queueScrub(e.text, await $.clock.now());
			void $.state.set(RT, s.rt).catch(noop);
			return { drop: DROP_NOTICE };
		}
		s.onPrompt(e.text);
		void $.state.set(RT, s.rt).catch(noop);
		if (s.driftToast(e.text, (await $.session.usage()).context, await $.clock.now())) {
			$.ui.toast("ctx-suite: this prompt looks unrelated to the active tasks — /compact-smart can trim the old context");
		}
		return next(e);
	}).catch(($, e, next) => next(e));

	on("command.run", { command: "ctx-health" }, async ($) => {
		const keys = (await $.store.keys().catch(() => [] as string[])).filter((k) => k.startsWith(SAVINGS_PREFIX));
		const entries = await Promise.all(keys.map((k) => $.store.get(k).catch(() => undefined)));
		// This session's entry from memory, which is newer than the store's.
		const own = s.savingsEntry();
		const others = keys.map((k, i) => (k === `${SAVINGS_PREFIX}${s.sessionId}` ? undefined : entries[i]));
		return { text: s.healthText(sumSavings(own ? [...others, own] : others)) };
	}).catch(($, e, next) => next(e));

	on("command.run", { command: "ctx-task" }, async ($, e) => {
		const text = s.pinTask(e.args);
		void $.state.set(RT, s.rt).catch(noop);
		return { text };
	}).catch(($, e, next) => next(e));

	on("command.run", { command: "compact-smart" }, async ($) => {
		const text = await s.evaluate(
			{
				context: async () => (await $.session.usage()).context,
				now: () => $.clock.now(),
				messages: () => $.session.messages(),
				complete: (req) => $.model.complete(req),
				compact: (instructions) => $.session.compact({ instructions }),
				model: () => $.session.model(),
			},
			true,
		);
		void $.state.set(RT, s.rt).catch(noop);
		$.ui.status(s.statusText());
		return { text };
	}).catch(($, e, next) => next(e));

	on("command.run", { command: "compact-why" }, async ($) => ({
		text: s.whyText((await $.session.usage()).context, await $.clock.now(), logPath),
	})).catch(($, e, next) => next(e));
};
