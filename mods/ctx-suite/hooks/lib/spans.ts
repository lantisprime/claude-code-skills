// ctx-suite/hooks/lib/spans.ts — tool-output spans: fingerprint, classify,
// staleness, token shares. Ported from pi-extensions context-manager (Phase 1).
// Pure: the hooks module feeds it tool results and file stats.

import type { Span, SpanClass } from "../../types";

export type { Span, SpanClass };

export interface Health {
	spans: number;
	tokens: number;
	/** Token-weighted shares, whole percent. */
	share: Record<SpanClass, number>;
	/** (stale + dup + error) tokens / all tracked tokens, 0..1. */
	impurity: number;
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

const ERROR_TEXT = /exit (code )?[1-9]\d*|^stderr:/im;

export function classify(text: string, isError: boolean, hash: string, spans: readonly Span[]): SpanClass {
	if (isError || ERROR_TEXT.test(text)) return "error";
	if (spans.some((s) => s.hash === hash)) return "dup";
	return "fresh";
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
	const tok: Record<SpanClass, number> = { fresh: 0, stale: 0, dup: 0, error: 0 };
	let total = 0;
	for (const s of spans) {
		tok[s.cls] += s.tok;
		total += s.tok;
	}
	const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
	return {
		spans: spans.length,
		tokens: total,
		share: { fresh: pct(tok.fresh), stale: pct(tok.stale), dup: pct(tok.dup), error: pct(tok.error) },
		impurity: total > 0 ? (tok.stale + tok.dup + tok.error) / total : 0,
	};
}
