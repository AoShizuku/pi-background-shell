// Background task model and the text the model sees in notifications.

export type TaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

/** Why a task was killed; decides whether the model is told about it. */
export type KillReason = "model" | "user" | "timeout" | "output_limit" | "session_end";

export interface BgTask {
	taskId: string;
	command: string;
	description?: string;
	status: TaskStatus;
	exitCode?: number;
	/** Human-readable reason for a non-natural end (kill reason, spawn error). */
	reason?: string;
	startedAt: number;
	endedAt?: number;
	outputPath: string;
	pid?: number;
	/** Set once the task's end has been handed to the model (or must never be). */
	notified: boolean;
}

/** Persisted snapshot of a task; written with pi.appendEntry on every state change. */
export type BgTaskEntry = Omit<BgTask, "notified"> & { notified?: boolean };

export const ENTRY_TYPE = "bg-task";
export const NOTIFICATION_TYPE = "bg-task-notification";
const COMMAND_PREVIEW_CHARS = 200;

/** Format a duration in milliseconds as `42s`, `2m13s` or `1h02m`. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The label shown for a task: its description, else its command. */
export function taskLabel(task: Pick<BgTask, "command" | "description">): string {
	return task.description?.trim() || previewCommand(task.command);
}

/** One-line summary of a finished task, worded per status. */
export function summarize(task: BgTask): string {
	const label = `"${taskLabel(task)}"`;
	switch (task.status) {
		case "completed":
			return `Background task ${task.taskId} ${label} completed (exit code 0).`;
		case "failed":
			return task.exitCode === undefined
				? `Background task ${task.taskId} ${label} failed: ${task.reason ?? "unknown error"}.`
				: `Background task ${task.taskId} ${label} failed (exit code ${task.exitCode}).`;
		case "timeout":
			return `Background task ${task.taskId} ${label} was killed after reaching its timeout.`;
		case "killed":
			return `Background task ${task.taskId} ${label} was killed${task.reason ? ` (${task.reason})` : ""}.`;
		case "running":
			return `Background task ${task.taskId} ${label} is still running.`;
	}
}

/** Build the model-facing notification for a batch of finished tasks. Paths only, never output. */
export function formatNotification(tasks: readonly BgTask[]): string {
	const blocks = tasks.map((task) => {
		const lines = [
			"<task>",
			`<task-id>${task.taskId}</task-id>`,
			`<command>${escapeXml(previewCommand(task.command))}</command>`,
		];
		if (task.description) lines.push(`<description>${escapeXml(task.description)}</description>`);
		lines.push(`<status>${task.status}</status>`);
		if (task.exitCode !== undefined) lines.push(`<exit-code>${task.exitCode}</exit-code>`);
		if (task.reason) lines.push(`<reason>${escapeXml(task.reason)}</reason>`);
		lines.push(`<duration>${formatDuration((task.endedAt ?? task.startedAt) - task.startedAt)}</duration>`);
		lines.push(`<output-file>${escapeXml(task.outputPath)}</output-file>`);
		lines.push("</task>");
		return lines.join("\n");
	});

	const summaries = tasks.map(summarize);
	return [
		"<bg-task-notification>",
		...blocks,
		"</bg-task-notification>",
		"",
		...summaries,
		"Read the output file with the read tool if you need the result.",
	].join("\n");
}

function previewCommand(command: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length > COMMAND_PREVIEW_CHARS ? `${oneLine.slice(0, COMMAND_PREVIEW_CHARS - 1)}…` : oneLine;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
