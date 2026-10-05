// ctx-suite $.state contract: the session state that survives a hot reload.

export type SpanClass = "fresh" | "stale" | "dup" | "error";

export interface Span {
	/** tool_use_id of the call. */
	id: string;
	tool: string;
	/** Fingerprint of the result text as the model reads it (after redaction). */
	hash: string;
	/** Estimated tokens. */
	tok: number;
	cls: SpanClass;
	/** File a Read span captured, for staleness. */
	path?: string;
	/** The action that produced it (lib/spans.ts actionKey): links an error to the later runs that resolve or repeat it. */
	action?: string;
	/** An error's origin: the harness refused the call, or the action ran and failed. */
	origin?: "harness" | "command";
	/** The result only sent the run to the background: it is neither a success nor a failure of the action. */
	bg?: true;
	/** Epoch ms the result was captured. */
	at: number;
}

export interface EngineState {
	/** Epoch ms of the last turn with usage (cache-state clock). */
	lastLLMCallAt: number | null;
	cacheModelKey: string | null;
	/** The main loop's model as $.session.model() named it at the last turn (may be an alias). */
	sessionModel: string | null;
	/** EMA of per-turn context growth (tokens). */
	growthPerTurn: number | null;
	lastTurnTokens: number | null;
	/** Turns since the last compaction of ANY origin. */
	turnsSinceCompaction: number;
	/** Context size before the last non-auto compaction; drives the post-compaction gap. */
	lastCompactionTokens: number | null;
	turnCounter: number;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskBoard {
	/** Task id (or TodoWrite position) → row. */
	rows: Record<string, { subject: string; status: TaskStatus }>;
}

/** Measured savings of ctx-suite's own compactions in one session (lib/savings.ts). */
export interface SavingsState {
	/** Tokens the counterfactual context would still carry; 0 once it would have compacted too. */
	offset: number;
	/** ctx-suite compactions counted. */
	compactions: number;
	/** Main-loop requests made while offset > 0. */
	requests: number;
	/** Tokens not re-read: the offset summed over those requests. */
	tokens: number;
	/** API-equivalent USD of those tokens: cache-read price, or cache-write price for a request after the cache expired. */
	usdSaved: number;
	/** API-equivalent USD of the counted compactions' summarizer calls. */
	usdSpent: number;
}

export interface CtxSuiteSnapshot {
	spans: Span[];
	engine: EngineState;
	board: TaskBoard;
	/** The session's first and latest prompts (redacted, clipped): the task subjects when the board has no rows. */
	prompts: { first?: string; recent?: string };
	/** Epoch ms of judge calls in the last hour (rate cap). */
	judgeCallsAt: number[];
	/** Files changed outside the session since a Read of them: path → mtime. */
	changedAt: Record<string, number>;
	redactHits: Record<string, number>;
	/** Abusive prompts dropped before they entered the session (counts only; the text is never kept). */
	promptsDropped: number;
	savings: SavingsState;
	/** Background tasks started and not yet reported back: id → epoch ms started. ctx-suite does not compact while any is outstanding. */
	background: Record<string, number>;
	/** What each outstanding background task runs (id → action label), so a failed one can be named. */
	backgroundLabels?: Record<string, string>;
	/** Background tasks that reported a failure, by action label: still failing until the same action succeeds. */
	backgroundFailing?: string[];
	/** Armed by each main-loop turn, used up by one pre-expiry evaluation: at most one per idle stretch. */
	expiryArmed?: boolean;
	/** Epoch ms of the last main-loop model request, to tell a request after the cache expired. */
	lastStepAt?: number;
	cacheHitPct: number | null;
	lastDecision: { kind: string; why?: string; at: number } | null;
	lastGate: { probability?: number; source: string; action: string; detail?: string; at: number } | null;
	/** `withheld`: stubs planned but not applied because the summarizer's cache was hot. */
	lastCompaction: { trigger: string; at: number; stubbed: number; withheld: number; tokensSaved: number; tokensBefore?: number; tokensAfter?: number } | null;
}

declare module "claude-code" {
	interface PluginState {
		"ctx-suite": { rt: CtxSuiteSnapshot };
	}
}
