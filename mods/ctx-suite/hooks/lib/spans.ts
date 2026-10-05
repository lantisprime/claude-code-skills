// ctx-suite/hooks/lib/spans.ts — tool-output spans: fingerprint, classify,
// staleness, token shares. Ported from pi-extensions context-manager (Phase 1).
// Pure: the hooks module feeds it tool results and file stats.

import type { Span, SpanClass } from "../../types";

export type { Span, SpanClass };

export interface Health {
	spans: number;
	tokens: number;
	/**
	 * Token-weighted shares, whole percent. `error` is dead errors only (resolved,
	 * repeated, harness-refused); `live` is failures still current: the newest run of
	 * an action failed, which is likely what the session is debugging.
	 */
	share: Record<SpanClass | "live", number>;
	/** (stale + dup + dead error) tokens / all tracked tokens, 0..1. Live failures are not impurity. */
	impurity: number;
	/** Dead errors by kind, as counts of tool results. */
	errors: { resolved: number; repeated: number; harness: number };
	/** Actions whose newest run failed, newest first (labels). */
	failing: string[];
}

/** Rough tokens from characters (4 chars/token), as pi's estimate. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** FNV-1a 32-bit + length: cheap, sync, good enough to spot identical outputs. */
export function fingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${(h >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

/**
 * Errors come from the harness's own flag (a tool result marked is_error), never
 * from the output's text: a script read from disk that contains "exit 1" is not a
 * failure. Of the last 60 live sessions' tool output, the old text rule flagged
 * 4.5% as errors on successful results, against 2.0% that really failed.
 */
export function classify(text: string, isError: boolean, hash: string, spans: readonly Span[]): SpanClass {
	if (isError) return "error";
	if (spans.some((s) => s.hash === hash)) return "dup";
	return "fresh";
}

/**
 * The harness refused the call (bad input, an unread file, a rejection or an
 * interrupt) rather than the action failing. Anchored at the start: a failing
 * command whose output merely quotes these words is still the command's failure.
 */
const HARNESS_ERROR = /^\s*(?:<tool_use_error>|The user doesn't want to proceed|\[Request interrupted)/i;

export function errorOrigin(text: string): "harness" | "command" {
	return HARNESS_ERROR.test(text) ? "harness" : "command";
}

/**
 * The harness's own sentences for work sent to the background, anchored at the
 * start of a result: output that merely prints such a sentence (a diff, a test
 * file) never starts a hold.
 */
const BACKGROUND_STARTED = [/^\s*Command running in background with ID: ([\w-]+)/, /^\s*Command [^\n]{0,200}?moved to the background \(ID: ([\w-]+)\)/, /^\s*Async agent launched successfully\.[\s\S]{0,400}?agentId: ([\w-]+)/];

/** The background task id when this (successful) result sent work to the background. */
export function backgroundStart(text: string): string | undefined {
	for (const re of BACKGROUND_STARTED) {
		const m = re.exec(text);
		if (m?.[1]) return m[1];
	}
	return undefined;
}

/** Top-level steps of a shell command: split at `&&`, `||`, `;` outside quotes. */
function shellSteps(cmd: string): string[] {
	const steps: string[] = [];
	let cur = "";
	let q: string | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i]!;
		if (q) {
			if (c === q && cmd[i - 1] !== "\\") q = null;
			cur += c;
		} else if (c === "'" || c === '"') {
			q = c;
			cur += c;
		} else if (c === ";" || ((c === "&" || c === "|") && cmd[i + 1] === c)) {
			steps.push(cur);
			cur = "";
			if (c !== ";") i++;
		} else cur += c;
	}
	steps.push(cur);
	return steps.map((x) => x.trim()).filter(Boolean);
}

/** Steps that only report (`echo "exit=$?"`, `true`): they never say which action this was. */
const REPORT_STEP = /^(?:echo|printf|true|:)\b/;

/**
 * A Bash command as an action. A plain chain keys on its last real step, which
 * sets the exit code: `cd … && git apply … && pytest x | tail -20` is the
 * `pytest x` action, so a RED run and the GREEN run of the same tests link even
 * when their setup differs. Display pipes, `2>&1` and trailing report steps are
 * dropped. A heredoc, a multi-line script, a line continuation or an unbalanced
 * quote keys on the whole command collapsed: its steps cannot be read safely.
 */
export function normalizeCommand(cmd: string): string {
	const whole = cmd.trim().replace(/\s+/g, " ").slice(0, 300);
	if (/<<|\\\n|\n/.test(cmd.trim()) || (cmd.match(/'/g) ?? []).length % 2 === 1 || (cmd.match(/"/g) ?? []).length % 2 === 1) return whole;
	const steps = shellSteps(cmd);
	while (steps.length > 1 && REPORT_STEP.test(steps[steps.length - 1]!)) steps.pop();
	let c = (steps[steps.length - 1] ?? whole).replace(/\s+/g, " ");
	for (;;) {
		const next = c.replace(/\s*\|\s*(?:tail|head|grep|cat|less|tee)\b[^|]*$/, "").replace(/\s*2>&1\s*$/, "").trim();
		if (next === c) break;
		c = next;
	}
	return c.slice(0, 300) || whole;
}

/** The one argument that names what a non-Bash call is about. */
const PRIMARY = ["file_path", "notebook_path", "path", "pattern", "url", "query", "description", "subagent_type", "skill"];

/**
 * What a tool call did, for linking an error to later runs: Bash by its command,
 * other tools by their primary argument and a fingerprint of the rest, so no
 * content (a Write's body, an agent's prompt) is kept and the key stays small.
 * Callers redact the key before keeping it.
 */
export function actionKey(tool: string, input: Record<string, unknown>): string {
	if (tool === "Bash" && typeof input.command === "string") return `Bash|${normalizeCommand(input.command)}`;
	const k = PRIMARY.find((p) => typeof input[p] === "string");
	const rest = Object.keys(input)
		.filter((x) => x !== k)
		.sort()
		.map((x) => [x, input[x]]);
	return `${tool}|${k ? String(input[k]).slice(0, 200) : ""}|${fingerprint(JSON.stringify(rest))}`;
}

/** A short name for an action: the command for Bash, else the tool and what it was about. */
export function actionLabel(action: string, path?: string): string {
	const [tool, ...rest] = action.split("|");
	if (tool === "Bash") return rest.join("|").slice(0, 80);
	const primary = path ?? rest[0];
	return primary ? `${tool} ${primary.slice(0, 80)}` : (tool ?? action);
}

export type ErrorState = "live" | "resolved" | "repeated" | "harness";

/**
 * Each error span's state, by the later spans of its action: a later success
 * resolves it, a later failure only repeats it, none makes it live. A harness
 * refusal is dead once a later call of the same tool succeeds. Errors from an
 * older version of the mod (no action) count as dead, as they always did.
 */
export function errorStates(spans: readonly Span[]): Map<number, ErrorState> {
	const out = new Map<number, ErrorState>();
	const laterOk = new Set<string>();
	const laterAny = new Set<string>();
	const toolOkLater = new Set<string>();
	for (let i = spans.length - 1; i >= 0; i--) {
		const s = spans[i]!;
		if (s.cls === "error") {
			if (s.origin === "harness") out.set(i, toolOkLater.has(s.tool) ? "harness" : "live");
			else if (!s.action) out.set(i, "repeated");
			else out.set(i, laterOk.has(s.action) ? "resolved" : laterAny.has(s.action) ? "repeated" : "live");
		}
		// a result that only sent the run to the background is no run of it yet: neither a success nor a repeat
		if (s.bg) continue;
		const ok = s.cls !== "error";
		if (s.action) {
			laterAny.add(s.action);
			if (ok) laterOk.add(s.action);
		}
		if (ok) toolOkLater.add(s.tool);
	}
	return out;
}

/** Tools whose input names the file they write. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** The file a tool call reads or writes, from its arguments. */
export function pathOf(input: Record<string, unknown>): string | undefined {
	const p = input.file_path ?? input.notebook_path;
	return typeof p === "string" ? p : undefined;
}

export function isWriteTool(tool: string): boolean {
	return WRITE_TOOLS.has(tool);
}

/** Append a span, keeping at most `keep` (oldest dropped). */
export function addSpan(spans: readonly Span[], span: Span, keep: number): Span[] {
	const next = [...spans, span];
	return next.length > keep ? next.slice(next.length - keep) : next;
}

/** Mark earlier Read spans of `path` stale (the file changed at `at`). Returns the count marked. */
export function markStale(spans: Span[], path: string, at: number): number {
	let n = 0;
	for (const s of spans) {
		if (s.path === path && s.at < at && s.cls !== "stale" && s.cls !== "error") {
			s.cls = "stale";
			n++;
		}
	}
	return n;
}

/** Distinct paths of non-stale Read spans with their newest capture time, bounded. */
/**
 * Up to `limit` read paths to stat: with an `offset`, a window starting there and
 * wrapping, so successive calls rotate through every path; without, the newest.
 */
export function probeTargets(spans: readonly Span[], limit: number, offset?: number): Array<{ path: string; at: number }> {
	const newest = new Map<string, number>();
	for (const s of spans) {
		if (!s.path || s.cls === "stale" || s.cls === "error") continue;
		newest.set(s.path, Math.max(newest.get(s.path) ?? 0, s.at));
	}
	const all = [...newest].map(([path, at]) => ({ path, at }));
	if (all.length <= limit) return all;
	if (offset === undefined) return all.slice(-limit);
	const start = offset % all.length;
	return [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
}

export function health(spans: readonly Span[]): Health {
	const tok: Record<SpanClass | "live", number> = { fresh: 0, stale: 0, dup: 0, error: 0, live: 0 };
	const errors = { resolved: 0, repeated: 0, harness: 0 };
	const failing: string[] = [];
	const states = errorStates(spans);
	let total = 0;
	spans.forEach((s, i) => {
		const st = states.get(i);
		if (st === "live") tok.live += s.tok;
		else tok[s.cls] += s.tok;
		if (st && st !== "live") errors[st]++;
		total += s.tok;
	});
	for (let i = spans.length - 1; i >= 0 && failing.length < 5; i--) {
		const s = spans[i]!;
		if (states.get(i) !== "live" || s.origin === "harness" || !s.action) continue;
		const label = actionLabel(s.action, s.path);
		if (!failing.includes(label)) failing.push(label);
	}
	const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
	return {
		spans: spans.length,
		tokens: total,
		share: { fresh: pct(tok.fresh), stale: pct(tok.stale), dup: pct(tok.dup), error: pct(tok.error), live: pct(tok.live) },
		impurity: total > 0 ? (tok.stale + tok.dup + tok.error) / total : 0,
		errors,
		failing,
	};
}
