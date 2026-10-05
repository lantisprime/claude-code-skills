// ctx-suite/hooks/lib/history.ts — remove a dropped prompt from Claude Code's input history.
//
// Claude Code records every submitted prompt in ~/.claude/history.jsonl (the
// up-arrow history) before any hook runs, so a prompt the screen dropped is
// still there. The engine offers whole-file read and write only, so removal is
// read, filter, re-read to check nothing was appended meanwhile, then write: a
// session appending between that check and the write can still lose its line.
// Only the newest line matching the dropped text, from this session and since
// the drop, is removed. The text waits in memory alone, never in $.state.

/** Prompt lines are matched within this long of the drop (history's own timestamp). */
const MATCH_WINDOW_MS = 120_000;
/** Ticks a pending removal is retried before it is given up. */
export const SCRUB_ATTEMPTS = 4;

export interface PendingScrub {
	text: string;
	/** Epoch ms of the drop. */
	at: number;
	attempts: number;
}

/**
 * Remove each pending prompt's newest matching line. Returns the new file text
 * (null when nothing matched) and which pending entries were removed.
 */
export function scrubLines(file: string, pending: readonly PendingScrub[], sessionId: string): { text: string | null; removed: PendingScrub[] } {
	const lines = file.split("\n");
	const drop = new Set<number>();
	const removed: PendingScrub[] = [];
	for (const p of pending) {
		for (let i = lines.length - 1; i >= 0; i--) {
			if (drop.has(i) || !lines[i]) continue;
			let row: { display?: unknown; timestamp?: unknown; sessionId?: unknown };
			try {
				row = JSON.parse(lines[i]!) as typeof row;
			} catch {
				continue;
			}
			if (row.display !== p.text) continue;
			if (typeof row.timestamp === "number" && row.timestamp < p.at - MATCH_WINDOW_MS) break; // older lines are not this drop
			if (typeof row.sessionId === "string" && row.sessionId !== sessionId) continue;
			drop.add(i);
			removed.push(p);
			break;
		}
	}
	if (drop.size === 0) return { text: null, removed };
	return { text: lines.filter((_, i) => !drop.has(i)).join("\n"), removed };
}
