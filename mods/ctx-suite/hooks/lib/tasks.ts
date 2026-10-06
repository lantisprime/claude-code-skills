// ctx-suite/hooks/lib/tasks.ts — task-subject tracking from the task tools.
//
// pi parsed a <session-tasks> block out of its system prompt; Claude Code's
// task list is driven by the TaskCreate / TaskUpdate / TodoWrite tools, so the
// board is rebuilt from their calls. Three states, as in pi's fix of
// 2026-10-03: no board, a board with active rows, and a board whose rows are
// all settled. A settled board is NOT "no tasks": the conversation is the
// finished work, and the relevance gate defers on it.

import type { TaskBoard, TaskStatus } from "../../types";

export type { TaskBoard, TaskStatus };

export interface BoardView {
	/** "prompts": no task rows; the subjects are the session's first and latest prompts. */
	state: "none" | "active" | "settled" | "prompts";
	activeSubjects: string[];
	settledCount: number;
}

const MAX_SUBJECTS = 8;
/** The board row /ctx-task sets. */
export const PINNED = "ctx-task";

export function emptyBoard(): TaskBoard {
	return { rows: {} };
}

/**
 * Apply one task-tool call. `input` is the call's arguments, `result` the
 * tool's record (TaskCreate's carries the new id). Returns a new board, or
 * the same one when the call is not a task call.
 */
export function applyTaskCall(board: TaskBoard, tool: string, input: Record<string, unknown>, result: unknown): TaskBoard {
	const rows = { ...board.rows };
	if (tool === "TaskCreate") {
		const task = (result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task;
		const id = typeof task?.id === "string" ? task.id : undefined;
		const subject = typeof input.subject === "string" ? input.subject : typeof task?.subject === "string" ? task.subject : undefined;
		if (!id || !subject) return board;
		rows[id] = { subject, status: "pending" };
		return { rows };
	}
	if (tool === "TaskUpdate") {
		const id = typeof input.taskId === "string" ? input.taskId : undefined;
		if (!id) return board;
		if (input.status === "deleted") {
			delete rows[id];
			return { rows };
		}
		const prev = rows[id] ?? { subject: id, status: "pending" as TaskStatus };
		const status = input.status === "pending" || input.status === "in_progress" || input.status === "completed" ? input.status : prev.status;
		rows[id] = { subject: typeof input.subject === "string" ? input.subject : prev.subject, status };
		return { rows };
	}
	if (tool === "TodoWrite" && Array.isArray(input.todos)) {
		// TodoWrite replaces the whole list, except the task /ctx-task pinned.
		const next: TaskBoard["rows"] = rows[PINNED] ? { [PINNED]: rows[PINNED] } : {};
		(input.todos as Array<{ content?: unknown; status?: unknown }>).forEach((t, i) => {
			if (typeof t.content !== "string") return;
			const status = t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
			next[`todo-${i}`] = { subject: t.content, status };
		});
		return { rows: next };
	}
	return board;
}

export function viewBoard(board: TaskBoard): BoardView {
	const rows = Object.values(board.rows);
	if (rows.length === 0) return { state: "none", activeSubjects: [], settledCount: 0 };
	const active = rows.filter((r) => r.status !== "completed");
	const settledCount = rows.length - active.length;
	if (active.length === 0) return { state: "settled", activeSubjects: [], settledCount };
	// in-progress first: they name what the session is doing right now
	active.sort((a, b) => (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1));
	return { state: "active", activeSubjects: active.slice(0, MAX_SUBJECTS).map((r) => r.subject), settledCount };
}
