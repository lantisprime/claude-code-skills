// ctx-suite/hooks/lib/config.ts — userConfig options → sanitized config.
//
// Every number is clamped to a safe range, so a typo in /config cannot turn a
// guardrail off (a 0 ms timeout, a 1e9-char excerpt, inverted thresholds).

import type { PluginOptions } from "claude-code";
import type { JudgeGuardrails } from "./gate.ts";

export interface Config {
	redact: boolean;
	redactPatterns: string[];
	shapeCompactions: boolean;
	smartTiming: boolean;
	idleMs: number;
	qualityLine: number;
	reserveTokens: number;
	driftToast: boolean;
	/** Drop abusive prompts that carry no task content before they enter the session. */
	dropAbusive: boolean;
	/** Also remove a dropped prompt from Claude Code's input history (~/.claude/history.jsonl). */
	scrubHistory: boolean;
	telemetry: boolean;
	judge: JudgeGuardrails;
	/** Shaping knobs (not exposed in /config; pi's defaults). */
	dumpTokens: number;
	errorLoopMin: number;
	protectTokens: number;
	protectMessages: number;
	keepSpans: number;
	/** Impurity share past which a compaction may fire below the fire line (pi purity budget × hard multiplier). */
	purityHard: number;
}

function num(v: unknown, dflt: number, min: number, max: number): number {
	return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
}
function bool(v: unknown, dflt: boolean): boolean {
	return typeof v === "boolean" ? v : dflt;
}
function str(v: unknown, dflt: string): string {
	return typeof v === "string" && v.trim() ? v.trim() : dflt;
}

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";

export function loadConfig(o: PluginOptions): Config {
	let aggressiveBelow = num(o.aggressiveBelow, 0.35, 0, 1);
	let deferAbove = num(o.deferAbove, 0.7, 0, 1);
	if (aggressiveBelow >= deferAbove) {
		aggressiveBelow = 0.35;
		deferAbove = 0.7;
	}
	const effort = o.judgeEffort === "medium" || o.judgeEffort === "high" ? o.judgeEffort : "low";
	const patterns = typeof o.redactPatterns === "string" ? o.redactPatterns.split(/\s+/).filter(Boolean) : [];
	return {
		redact: bool(o.redact, true),
		redactPatterns: patterns.slice(0, 32),
		shapeCompactions: bool(o.shapeCompactions, true),
		smartTiming: bool(o.smartTiming, true),
		idleMs: num(o.idleSeconds, 20, 5, 600) * 1000,
		qualityLine: num(o.qualityLine, 0.5, 0.2, 0.9),
		reserveTokens: num(o.reserveTokens, 33_000, 0, 200_000),
		driftToast: bool(o.driftToast, true),
		dropAbusive: bool(o.dropAbusive, true),
		scrubHistory: bool(o.scrubHistory, true),
		telemetry: bool(o.telemetry, true),
		judge: {
			enabled: bool(o.judgeEnabled, true),
			model: str(o.judgeModel, DEFAULT_JUDGE_MODEL),
			effort,
			timeoutMs: num(o.judgeTimeoutMs, 15_000, 1_000, 60_000),
			maxExcerptChars: num(o.judgeMaxExcerptChars, 4_000, 500, 20_000),
			maxOutputTokens: num(o.judgeMaxOutputTokens, 256, 64, 1_024),
			maxCallsPerHour: num(o.judgeMaxCallsPerHour, 6, 0, 60),
			aggressiveBelow,
			deferAbove,
			allowAggressive: bool(o.allowAggressive, true),
			fallbackMayBeAggressive: bool(o.fallbackMayBeAggressive, false),
		},
		dumpTokens: 800,
		errorLoopMin: 3,
		protectTokens: 40_000,
		protectMessages: 8,
		keepSpans: 500,
		purityHard: 0.3,
	};
}
