// ctx-suite/hooks/lib/telemetry.ts — bounded JSONL decision log.
//
// $.fs has no append, so the log is a ring: the newest MAX_LINES lines are
// rewritten whole. Records hold redacted text and counts only. Write failures
// are swallowed: telemetry never breaks the session.

export const MAX_LINES = 2_000;

export type Record_ = { ts: string; event: string; [field: string]: unknown };

/** Next file content: old lines plus the new ones, the newest MAX_LINES kept. */
export function ringAppend(existing: string, records: readonly Record_[]): string {
	const lines = existing.split("\n").filter(Boolean);
	for (const r of records) lines.push(JSON.stringify(r));
	return `${lines.slice(-MAX_LINES).join("\n")}\n`;
}
