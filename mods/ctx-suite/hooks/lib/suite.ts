// ctx-suite/hooks/lib/suite.ts — the suite's session state and decisions.
//
// The hooks module may only spell `$` at a call site, so everything here is
// `$`-free: state transitions are plain methods, and the one flow that needs
// the engine (evaluate) takes an Io of closures the hook builds inline.

import { judgeAbuse } from "./abuse.ts";
import { SCRUB_ATTEMPTS, type PendingScrub } from "./history.ts";
import { freshSavings, onCompaction, onContext, onRequest, savingsText, type SavingsState } from "./savings.ts";
import type { ModelCompleteRequest, ModelCompleteResult, SessionCompactResult, SessionCompacted, SessionContextUsage, SessionMessage, TurnUsage } from "claude-code";
import type { CtxSuiteSnapshot } from "../../types";
import type { Config } from "./config.ts";
import { CLAUDE_PROFILE, RELATIVE_PRICES, effectiveFloor, evaluateEconomy, evaluateWarnings, focusInstructions, initState, type Decision, type EvalInput } from "./engine.ts";
import { heuristicRelevance, recentCalls, relevanceGate, type Action } from "./gate.ts";
import { compilePatterns, redactText } from "./redact.ts";
import { shapeMessages, type ShapeResult } from "./shape.ts";
import { addSpan, classify, estimateTokens, fingerprint, health, isWriteTool, markStale, pathOf, probeTargets } from "./spans.ts";
import { PINNED, applyTaskCall, emptyBoard, viewBoard, type BoardView } from "./tasks.ts";
import type { Record_ } from "./telemetry.ts";

/** Marks instructions ctx-suite already wrote, so a compaction is never instructed twice. */
export const MARK = "[ctx-suite focus]";
const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
const DRIFT_TOAST_GAP_MS = 30 * 60_000;
/** Chars of a prompt kept as a task subject. */
const PROMPT_SUBJECT_CHARS = 300;
/** Read paths stat'ed after each turn (rotating) and before a compaction (all, capped). */
const PROBE_PER_TURN = 20;
const PROBE_AT_COMPACTION = 200;
/**
 * A turn within this long keeps the summarizer's prompt cache hot. Claude Code
 * caches for up to an hour; misjudging hot as cold is the expensive mistake.
 */
const STUB_CACHE_HOT_MS = 3_600_000;

export interface Io {
	context: () => Promise<SessionContextUsage>;
	now: () => Promise<number>;
	messages: () => Promise<readonly SessionMessage[]>;
	complete: (req: ModelCompleteRequest) => Promise<ModelCompleteResult>;
	compact: (instructions: string) => Promise<SessionCompactResult>;
	/** The main loop's model as /model shows it. */
	model: () => Promise<string>;
}

export function freshSnapshot(): CtxSuiteSnapshot {
	return { spans: [], engine: initState(), board: emptyBoard(), prompts: {}, judgeCallsAt: [], changedAt: {}, redactHits: {}, promptsDropped: 0, savings: freshSavings(), cacheHitPct: null, lastDecision: null, lastGate: null, lastCompaction: null };
}

export class Suite {
	rt: CtxSuiteSnapshot = freshSnapshot();
	readonly custom;
	/** Epoch ms after which an idle evaluation is due; null while a turn runs or none is armed. */
	idleDue: number | null = null;
	/** An evaluation (judge call and compaction) is running. */
	busy = false;
	/**
	 * Turns in progress, any loop. turn.start carries no agentId, so a subagent's or
	 * fork's start counts here too; every turn.complete subtracts one.
	 */
	turnDepth = 0;

	get turnRunning(): boolean {
		return this.turnDepth > 0;
	}

	onTurnStart(): void {
		this.turnDepth++;
	}

	/** A main-loop completion resyncs to 0, so a start whose completion never came cannot wedge the count. */
	onTurnEnd(isMain: boolean): void {
		this.turnDepth = isMain ? 0 : Math.max(0, this.turnDepth - 1);
	}
	/** This session's id, stamped on every telemetry record. */
	sessionId: string | null = null;
	/** Dropped prompts still to remove from the input history: memory only, never $.state. */
	pendingScrubs: PendingScrub[] = [];
	private lastDriftToast = 0;
	private probeCursor = 0;
	private log: Record_[] = [];

	constructor(readonly cfg: Config) {
		this.custom = compilePatterns(cfg.redactPatterns).patterns;
	}

	record(event: string, fields: Record<string, unknown> = {}): void {
		if (this.cfg.telemetry) this.log.push({ ts: new Date().toISOString(), session: this.sessionId ?? undefined, event, ...fields });
	}

	/** Pending telemetry records, handed over once. */
	takeLog(): Record_[] {
		const out = this.log;
		this.log = [];
		return out;
	}

	statusText(note?: string): string {
		const h = health(this.rt.spans);
		const ch = this.rt.cacheHitPct == null ? "" : ` CH${this.rt.cacheHitPct}`;
		const d = this.rt.lastDecision;
		return `ctx f${h.share.fresh} s${h.share.stale} d${h.share.dup} e${h.share.error}${ch} · sc ${note ?? (d && d.kind !== "none" ? d.kind : "idle")}`;
	}

	evalInput(context: SessionContextUsage, now: number): EvalInput {
		const c = this.cfg;
		return {
			profile: {
				...CLAUDE_PROFILE,
				compaction: { ...CLAUDE_PROFILE.compaction, qualityLine: c.qualityLine },
				gate: { enabled: true, aggressiveBelow: c.judge.aggressiveBelow, deferAbove: c.judge.deferAbove },
			},
			prices: RELATIVE_PRICES,
			config: { reserveTokens: c.reserveTokens, continuationProbability: 0.7, tierSafety: 1.5 },
			state: this.rt.engine,
			usage: { tokens: context.tokens ?? null, contextWindow: context.window },
			now,
			modelKey: this.rt.engine.cacheModelKey ?? undefined,
		};
	}

	/** The task board, or with no rows on it, the session's first and latest prompts. */
	tasks(): BoardView {
		const v = viewBoard(this.rt.board);
		const { first, recent } = this.rt.prompts ?? {};
		if (v.state !== "none" || !first) return v;
		return { state: "prompts", activeSubjects: recent && recent !== first ? [first, recent] : [first], settledCount: 0 };
	}

	/** A person's prompt: remembered (redacted, clipped) as a fallback task subject. Slash commands are not tasks. */
	onPrompt(text: string): void {
		const t = text.trim();
		if (!t || t.startsWith("/")) return;
		const clipped = redactText(t, this.custom).text.replace(/\s+/g, " ").slice(0, PROMPT_SUBJECT_CHARS);
		this.rt.prompts = { first: this.rt.prompts?.first ?? clipped, recent: clipped };
	}

	/**
	 * Whether to drop a person's prompt before it enters the session: abusive with
	 * no task content (lib/abuse.ts). Attachments and slash commands always go on.
	 */
	async screenPrompt(text: string, hasAttachments: boolean, complete: (req: ModelCompleteRequest) => Promise<ModelCompleteResult>): Promise<boolean> {
		const t = text.trim();
		if (!this.cfg.dropAbusive || hasAttachments || !t || t.startsWith("/")) return false;
		const v = await judgeAbuse(redactText(t, this.custom).text, this.tasks().activeSubjects, complete);
		if (v.why !== "clean") this.record("prompt-screened", { drop: v.drop, why: v.why });
		if (v.drop) this.rt.promptsDropped = (this.rt.promptsDropped ?? 0) + 1;
		return v.drop;
	}

	/** A main-loop model request (turn.step). */
	onStep(model: string): void {
		this.rt.savings = onRequest(this.rt.savings ?? freshSavings(), model);
	}

	/** This session's measured savings, once ctx-suite has compacted (for the store and telemetry). */
	savingsEntry(): SavingsState | null {
		const sv = this.rt.savings;
		return sv && sv.compactions > 0 ? sv : null;
	}

	/**
	 * The session ended. After a /clear the process goes on under a new session id
	 * with no session.start: the new conversation has saved nothing yet, and its
	 * id is read again at its first turn.
	 */
	onSessionEnd(reason: string): void {
		if (reason !== "clear") return;
		this.rt.savings = freshSavings();
		this.sessionId = null;
	}

	/** A dropped prompt, to remove from the input history on the next ticks. */
	queueScrub(text: string, at: number): void {
		if (this.cfg.scrubHistory) this.pendingScrubs.push({ text, at, attempts: 0 });
	}

	/** After a tick's removal attempt: settle the removed, retry the rest, give up past the attempts. */
	settleScrubs(removed: readonly PendingScrub[]): void {
		const gone = new Set(removed);
		if (gone.size > 0) this.record("history-scrubbed", { lines: gone.size });
		const left: PendingScrub[] = [];
		for (const p of this.pendingScrubs) {
			if (gone.has(p)) continue;
			if (++p.attempts >= SCRUB_ATTEMPTS) this.record("history-scrub-missed", {});
			else left.push(p);
		}
		this.pendingScrubs = left;
	}

	/** /ctx-task: "" shows, "done" settles, "clear" removes, anything else pins the task. */
	pinTask(args: string): string {
		const a = args.trim();
		const rows = { ...this.rt.board.rows };
		if (a === "done" || a === "clear") {
			if (!rows[PINNED]) return "no pinned task";
			if (a === "clear") delete rows[PINNED];
			else rows[PINNED] = { ...rows[PINNED]!, status: "completed" };
			this.rt.board = { rows };
		} else if (a) {
			rows[PINNED] = { subject: redactText(a, this.custom).text.slice(0, PROMPT_SUBJECT_CHARS), status: "in_progress" };
			this.rt.board = { rows };
		}
		const v = this.tasks();
		return `tasks (${v.state}): ${v.activeSubjects.join("; ") || (v.state === "settled" ? `${v.settledCount} settled` : "none")}`;
	}

	instructionsFor(action: Exclude<Action, "defer">): string {
		const subjects = this.tasks().activeSubjects;
		return `${MARK} ${focusInstructions(action, subjects)} Tool outputs replaced by "[ctx-suite: …]" stubs are stale, superseded, duplicated or repeated failures: do not carry them forward.`;
	}

	/** Phase 1: one span per main-loop tool result; task calls feed the board. */
	onToolResult(tool: string, id: string, input: Record<string, unknown>, rawText: string, isError: boolean, result: unknown, now: number): void {
		const text = redactText(rawText, this.custom).text;
		const hash = fingerprint(text);
		const path = tool === "Read" ? pathOf(input) : undefined;
		this.rt.spans = addSpan(this.rt.spans, { id, tool, hash, tok: estimateTokens(text), cls: classify(text, isError, hash, this.rt.spans), path, at: now }, this.cfg.keepSpans);
		const written = isWriteTool(tool) && !isError ? pathOf(input) : undefined;
		if (written) markStale(this.rt.spans, written, now);
		if (TASK_TOOLS.has(tool) && !isError) this.rt.board = applyTaskCall(this.rt.board, tool, input, result);
	}

	countRedactions(kinds: Record<string, number>): void {
		for (const [k, n] of Object.entries(kinds)) this.rt.redactHits[k] = (this.rt.redactHits[k] ?? 0) + n;
		this.record("redacted", { kinds });
	}

	/** After a main-loop turn: cache hit, model switch, growth EMA. Returns the status note. */
	onTurnComplete(usage: TurnUsage | undefined, context: SessionContextUsage, sessionModel: string, now: number): string | undefined {
		const eng = this.rt.engine;
		eng.sessionModel = sessionModel;
		if (usage) {
			const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
			if (total > 0) this.rt.cacheHitPct = Math.round((usage.cache_read_input_tokens / total) * 100);
			if (eng.cacheModelKey !== null && eng.cacheModelKey !== usage.model) {
				// New model: cold cache; growth measured on the old tokenizer no longer applies.
				eng.growthPerTurn = null;
				eng.lastTurnTokens = null;
				eng.lastCompactionTokens = null;
			}
			eng.lastLLMCallAt = now;
			eng.cacheModelKey = usage.model;
		}
		eng.turnCounter++;
		eng.turnsSinceCompaction++;
		if (context.tokens != null) {
			if (eng.lastTurnTokens != null) {
				const delta = context.tokens - eng.lastTurnTokens;
				eng.growthPerTurn = eng.growthPerTurn == null ? delta : eng.growthPerTurn * 0.7 + delta * 0.3;
			}
			eng.lastTurnTokens = context.tokens;
		}
		const sv = this.savingsEntry();
		if (sv) {
			this.rt.savings = onContext(sv, context.tokens ?? null, context.window - this.cfg.reserveTokens);
			this.record("savings", { ...this.rt.savings });
		}
		const w = evaluateWarnings(this.evalInput(context, now));
		return w.kind === "warn-overflow" ? "overflow soon" : w.kind === "warn-tier" ? `tier@${Math.round(w.boundary / 1000)}k soon` : undefined;
	}

	/** Read paths to stat: after a turn a rotating window of them, before a compaction all of them (capped). */
	probeTargets(all = false): Array<{ path: string; at: number }> {
		if (all) return probeTargets(this.rt.spans, PROBE_AT_COMPACTION);
		const out = probeTargets(this.rt.spans, PROBE_PER_TURN, this.probeCursor);
		this.probeCursor += PROBE_PER_TURN;
		return out;
	}

	/** A probed file's mtime moved past its read. */
	onFileChanged(path: string, mtimeMs: number): void {
		if (markStale(this.rt.spans, path, mtimeMs) > 0) this.rt.changedAt[path] = Math.max(this.rt.changedAt[path] ?? 0, mtimeMs);
	}

	/**
	 * Phase 2: the instructions and messages a main-loop compaction runs with.
	 *
	 * Stubs apply only on a cold cache. On a hot one they never pay: every token
	 * after the first stub moves from cache read (0.1) to cache write (1.25),
	 * while the saving is at most the stubbed tokens at read price (live eval
	 * 2026-10-05: 4.6k tokens stubbed, 295k rewritten, ~5x the compaction's cost).
	 * Withheld stubs keep the engine's list as is; stale reads are named in the
	 * instructions instead, so the summarizer still drops them.
	 */
	shapeCompaction(trigger: string, instructions: string | undefined, messages: readonly SessionMessage[], now: number, model: string): { instructions: string; shaped: ShapeResult; withheld: number } {
		const c = this.cfg;
		let ins = instructions?.includes(MARK) ? instructions : [instructions, this.instructionsFor("focused")].filter(Boolean).join("\n\n");
		const none: ShapeResult = { messages, stubbed: 0, byKind: { "error-loop": 0, stale: 0, superseded: 0, duplicate: 0 }, tokensSaved: 0, staleReads: [] };
		// A compaction raised outside a session (the test kit) carries no message list.
		const planned = c.shapeCompactions && Array.isArray(messages)
			? shapeMessages(messages, { dumpTokens: c.dumpTokens, errorLoopMin: c.errorLoopMin, protectTokens: c.protectTokens, protectMessages: c.protectMessages, changedAt: new Map(Object.entries(this.rt.changedAt)), capturedAt: new Map(this.rt.spans.map((sp) => [sp.id, sp.at])) })
			: none;
		const { lastLLMCallAt: last, sessionModel } = this.rt.engine;
		// A model switched since the last turn shares no cache entries with it.
		const hot = last !== null && now - last < STUB_CACHE_HOT_MS && (sessionModel === null || sessionModel === model);
		const withheld = hot ? planned.stubbed : 0;
		const shaped = hot ? none : planned;
		if (withheld > 0 && planned.staleReads.length > 0) {
			ins += `\n\nThese files changed after they were read; their earlier contents are stale, do not carry them forward: ${planned.staleReads.slice(-20).join(", ")}.`;
		}
		this.record("compact-shaped", { trigger, messages: messages?.length ?? 0, cacheHot: hot, stubbed: shaped.stubbed, withheld, byKind: planned.byKind, tokensSaved: shaped.tokensSaved, staleReads: planned.staleReads.length });
		return { instructions: ins, shaped, withheld };
	}

	afterCompaction(trigger: string, r: SessionCompacted, stubbed: number, withheld: number, tokensSaved: number, at: number): void {
		const e = this.rt.engine;
		e.turnsSinceCompaction = 0;
		// An auto compaction fires near the window's end; arming the gap from it would silence the engine.
		if (trigger !== "auto") e.lastCompactionTokens = r.tokensBefore ?? e.lastTurnTokens;
		e.lastTurnTokens = null;
		this.rt.spans = [];
		this.rt.changedAt = {};
		this.rt.lastCompaction = { trigger, at, stubbed, withheld, tokensSaved, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter };
		this.rt.savings = onCompaction(this.rt.savings ?? freshSavings(), trigger, r.tokensBefore, r.tokensAfter, r.usage, e.cacheModelKey);
		this.record("compacted", { ...this.rt.lastCompaction, usage: r.usage });
	}

	/** Phase 3 drift: a long prompt sharing no words with the active tasks, in a full context. */
	driftToast(text: string, context: SessionContextUsage, now: number): boolean {
		const v = viewBoard(this.rt.board);
		if (!this.cfg.driftToast || v.state !== "active" || now - this.lastDriftToast < DRIFT_TOAST_GAP_MS) return false;
		if (text.split(/\s+/).length < 6 || (context.tokens ?? 0) < effectiveFloor(CLAUDE_PROFILE, context.window).floor) return false;
		if (heuristicRelevance([text], v.activeSubjects.join(" ")) !== 0) return false;
		this.lastDriftToast = now;
		return true;
	}

	/** Phase 3: decide, judge, compact. `force` bypasses min-interval only (the guards stay). */
	async evaluate(io: Io, force: boolean): Promise<string> {
		if (this.busy) return "a ctx-suite evaluation is already running";
		this.busy = true;
		try {
			return await this.decideAndCompact(io, force);
		} catch (err) {
			this.record("evaluate-failed", { error: String(err).slice(0, 200) });
			return "evaluation failed (a turn is running?)";
		} finally {
			this.busy = false;
		}
	}

	private async decideAndCompact(io: Io, force: boolean): Promise<string> {
		const now = await io.now();
		const input = this.evalInput(await io.context(), now);
		if (force) input.state = { ...input.state, turnsSinceCompaction: Number.MAX_SAFE_INTEGER };
		// A model switched since the last turn has a cold cache.
		const model = await io.model();
		if (this.rt.engine.sessionModel !== null && model !== this.rt.engine.sessionModel) input.cacheHot = false;
		let d: Decision = evaluateEconomy(input);
		const impurity = health(this.rt.spans).impurity;
		// pi's purity budget, folded in: a context this full of dead output may compact below the fire line.
		if (d.kind === "none" && d.why.startsWith("below fire-line") && impurity >= this.cfg.purityHard) d = { kind: "quality", tokens: input.usage?.tokens ?? 0, line: 0 };
		this.rt.lastDecision = { kind: d.kind, why: d.kind === "none" ? d.why : undefined, at: now };
		this.record("decision", { force, decision: d, impurity });
		if (d.kind !== "economy" && d.kind !== "quality") return `no compaction — ${d.kind === "none" ? d.why : d.kind}`;

		const msgs = await io.messages();
		const texts = msgs.map((m) => m.text).filter(Boolean);
		// Redact each message whole before joining, and stop once there is enough: no cut ever crosses raw text.
		const parts: string[] = [];
		let size = 0;
		for (const t of texts.slice(0, Math.ceil(texts.length / 2))) {
			if (size >= this.cfg.judge.maxExcerptChars) break;
			const r = redactText(t, this.custom).text;
			parts.push(r);
			size += r.length + 1;
		}
		const excerpt = parts.join("\n");
		const gate = await relevanceGate({ board: this.tasks(), excerpt, g: this.cfg.judge, now, callsAt: this.rt.judgeCallsAt, complete: io.complete });
		this.rt.judgeCallsAt = gate.callsAt;
		this.rt.lastGate = { ...gate.result, at: now };
		this.record("gate", { ...gate.result });
		const action = gate.result.action;
		if (action === "defer") return `deferred — ${gate.result.detail ?? "the context is task-relevant"}`;
		if (this.turnRunning) return "a turn is running; not compacting";

		const r = await io.compact(this.instructionsFor(action));
		if (r.skip !== undefined) {
			this.record("compact-skipped", { skip: r.skip });
			return `compaction skipped — ${r.skip}`;
		}
		// When our own session.compact hook ran (it may be skipped for our call), it already recorded this.
		if ((this.rt.lastCompaction?.at ?? 0) < now) this.afterCompaction("plugin", r, 0, 0, 0, now);
		const p = gate.result.probability;
		return `compacted (${action}, p=${p == null ? "n/a" : p.toFixed(2)}, ${gate.result.source})`;
	}

	/** `lifetime`: every session's entry summed, from the store (the hook reads it). */
	healthText(lifetime?: SavingsState & { sessions: number }): string {
		const h = health(this.rt.spans);
		const v = this.tasks();
		const hits = Object.entries(this.rt.redactHits).map(([k, n]) => `${k}×${n}`).join(", ") || "none";
		const lc = this.rt.lastCompaction;
		return [
			`spans: ${h.spans} (${h.tokens} tok) · fresh ${h.share.fresh}% · stale ${h.share.stale}% · dup ${h.share.dup}% · error ${h.share.error}%`,
			`impurity: ${(h.impurity * 100).toFixed(0)}% (purity override at ${(this.cfg.purityHard * 100).toFixed(0)}%) · files changed outside: ${Object.keys(this.rt.changedAt).length}`,
			`cache hit (last turn): ${this.rt.cacheHitPct == null ? "n/a" : `${this.rt.cacheHitPct}%`}`,
			`redaction: ${this.cfg.redact ? "on" : "OFF"} · hits: ${hits} · abusive prompts dropped: ${this.cfg.dropAbusive ? (this.rt.promptsDropped ?? 0) : "OFF"}`,
			`tasks: ${v.state}${v.activeSubjects.length ? ` — ${v.activeSubjects.join("; ")}` : ""}`,
			`last compaction: ${lc ? `${lc.trigger}, ${lc.stubbed} outputs stubbed (~${lc.tokensSaved} tok)${lc.withheld ? `, ${lc.withheld} withheld (cache hot)` : ""}, ${lc.tokensBefore ?? "?"} → ${lc.tokensAfter ?? "?"} tok` : "none yet"}`,
			savingsText(this.rt.savings ?? freshSavings(), "savings (this session)"),
			...(lifetime && lifetime.sessions > 0 ? [`${savingsText(lifetime, "savings (all sessions)")} · ${lifetime.sessions} session${lifetime.sessions === 1 ? "" : "s"}`] : []),
		].join("\n");
	}

	whyText(context: SessionContextUsage, now: number, logPath: string | undefined): string {
		const c = this.cfg;
		const e = this.rt.engine;
		const g = c.judge;
		const fl = effectiveFloor(CLAUDE_PROFILE, context.window);
		const gt = this.rt.lastGate;
		const d = this.rt.lastDecision;
		return [
			`context: ${context.tokens ?? "?"} / ${context.window} tok · fire line ${Math.round(c.qualityLine * context.window)} · floor ${Math.round(fl.floor)} (${fl.driver}) · reserve ${c.reserveTokens}`,
			`model: ${e.cacheModelKey ?? "unknown"} · cache ${e.lastLLMCallAt ? `${Math.round((now - e.lastLLMCallAt) / 1000)}s since last call` : "cold"} · prices: relative (in 1, out 5, read 0.1, write 1.25)`,
			`growth/turn: ${e.growthPerTurn?.toFixed(0) ?? "?"} tok · turns since compaction: ${e.turnsSinceCompaction} · smart timing: ${c.smartTiming ? `on (idle ${c.idleMs / 1000}s)` : "off"}`,
			`last decision: ${d ? `${d.kind}${d.why ? ` — ${d.why}` : ""}` : "none yet"}`,
			`last gate: ${gt ? `${gt.action} via ${gt.source}${gt.probability != null ? ` p=${gt.probability.toFixed(2)}` : ""}${gt.detail ? ` — ${gt.detail}` : ""}` : "none yet"}`,
			`judge: ${g.enabled ? g.model : "OFF"} · effort ${g.effort} · timeout ${g.timeoutMs}ms · excerpt ≤${g.maxExcerptChars} chars · ≤${g.maxCallsPerHour}/h (${recentCalls(this.rt.judgeCallsAt, now).length} used) · aggressive <${g.aggressiveBelow}${g.allowAggressive ? "" : " (disabled)"} · defer >${g.deferAbove} · heuristic aggressive: ${g.fallbackMayBeAggressive ? "allowed" : "no"}`,
			`telemetry: ${c.telemetry ? (logPath ?? "no HOME") : "off"}`,
		].join("\n");
	}
}
