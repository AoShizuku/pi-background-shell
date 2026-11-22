// pi-background-shell: run long shell commands in the background and wake the agent when they exit.

import { join } from "node:path";

import {
	type BoundaryResult,
	type BoundaryState,
	type CustomMessageEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getShellConfig,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { DEFAULT_WINDOW_MS, NotificationBatcher } from "./batcher.js";
import { cleanupOldOutputs } from "./cleanup.js";
import { type BgConfig, CONFIG_FILE_NAME, loadConfig } from "./config.js";
import { TaskManager } from "./manager.js";
import { describeTasks, openPanel } from "./panel.js";
import { setSetting, settingsItems } from "./settings.js";
import { exposeSettings } from "./shizuku-settings.js";
import { backgroundRenderers, killRenderers, type ToolDetails } from "./render.js";
import {
	type BgTask,
	type BgTaskEntry,
	ENTRY_TYPE,
	formatDuration,
	formatNotification,
	NOTIFICATION_TYPE,
	type TaskStatus,
	taskLabel,
} from "./task.js";

/** Event-bus channel carrying {@link BgState}; pi-hud subscribes to it. */
export const STATE_CHANNEL = "bg:state";
/** Emit on this channel to have the current {@link BgState} re-sent. */
export const STATE_REQUEST_CHANNEL = "bg:state:request";
/** Emit on this channel to open the /background list (pi-hud does, when `N shells` is clicked). */
export const OPEN_CHANNEL = "bg:open";

export interface BgState {
	running: number;
}

interface NotificationDetails {
	tasks: Array<{ taskId: string; label: string; status: TaskStatus; exitCode?: number; reason?: string; durationMs: number; outputPath: string }>;
}

const STATUS_KEY = "pi-background-shell";
const TOOL_NAMES: readonly string[] = ["bash_background", "bg_kill"];

/** Status colors of design_style.md §3: running accent, a killed task did not finish but did not fail. */
const STATUS_COLORS: Record<TaskStatus, "accent" | "warning" | "success" | "error"> = {
	running: "accent",
	completed: "success",
	failed: "error",
	killed: "warning",
	timeout: "error",
};

const bgSchema = Type.Object({
	command: Type.String({ description: "Shell command to run in the background" }),
	description: Type.Optional(Type.String({ description: "Short human-readable label for this task, shown to the user" })),
	timeout: Type.Optional(Type.Number({ description: "Kill the task after this many seconds (default: no limit)" })),
});

const killSchema = Type.Object({
	task_id: Type.String({ description: "Id of the background task to stop, e.g. bg-1" }),
});

export default function piBackgroundShell(pi: ExtensionAPI): void {
	let session: Session | undefined;
	let unsubscribeOpen: (() => void) | undefined;
	// The list sits in the editor's place; a second request while it is up (a click on the HUD) is dropped.
	let panelOpen = false;

	const showPanel = async (ctx: ExtensionContext): Promise<void> => {
		const current = session;
		if (!current || panelOpen) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify(describeTasks(current.manager.list()), "info");
			return;
		}
		panelOpen = true;
		try {
			await openPanel(ctx, {
				list: () => current.manager.list(),
				kill: (taskId) => void current.manager.kill(taskId, "user"),
				canKill: (taskId) => current.manager.canKill(taskId),
				confirmKill: () => current.config.confirmKill,
			});
		} finally {
			panelOpen = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		session = startSession(pi, ctx);
		// A panel left open by the previous session never resolves; do not let it block this one.
		panelOpen = false;
		unsubscribeOpen?.();
		unsubscribeOpen = pi.events.on(OPEN_CHANNEL, () => {
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			showPanel(ctx).catch(() => {
				// The UI went away (session switch); nothing to restore.
			});
		});
		// One-shot modes exit when the run ends, killing tasks before any notification could arrive.
		if (ctx.mode === "print" || ctx.mode === "json") {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name)));
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribeOpen?.();
		unsubscribeOpen = undefined;
		panelOpen = false;
		session?.close();
		session = undefined;
	});

	// Busy agent: drain everything that finished during this turn into one message.
	pi.on("turn_end", (event) => session?.drainAtBoundary(event));
	pi.on("agent_before_settle", (event) => session?.drainAtBoundary(event));

	// Tasks that finished after the last boundary. An aborted run is not restarted:
	// the notification is recorded and the model sees it with the next prompt.
	pi.on("agent_settled", (event) => session?.drainSettled(event.aborted));

	pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, (message, options, theme) => {
		const tasks = message.details?.tasks ?? [];
		const lines = tasks.map((task) => notificationLine(task, options.expanded, theme));
		// Markers sit in the gutter's column 0 (pi-shizuku README.md), not at pi's outputPad.
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerTool({
		name: "bash_background",
		label: "Background Bash",
		description:
			"Run a shell command in the background. Returns immediately with a task id and the absolute path of a file that receives the command's combined stdout/stderr. When the command exits you are notified automatically with a <bg-task-notification> message. Tasks are killed when the pi session ends.",
		promptSnippet: "Run long shell commands (builds, test suites, dev servers) in the background without blocking",
		promptGuidelines: [
			"Use bash_background for commands expected to take more than ~30 seconds (builds, test suites, dev servers, deploys); it returns immediately with a task id and an output file path.",
			"When a bash_background task exits you are notified automatically with a <bg-task-notification> message. Do not poll it and do not run sleep in bash to wait for it; continue with other work or end your turn.",
			"Read a bash_background task's output with the read tool on the output file path from the notification; for long output read only the end.",
			"Use bash, not bash_background, for commands that finish within a few seconds; a background task costs an extra turn when it is reported.",
			"To wait for a condition such as a port opening, a file appearing or a log line, run a loop like `until <check>; do sleep 2; done` with bash_background. Never use sleep in bash to wait.",
			"Use bg_kill to stop a bash_background task you no longer need, such as a dev server, before you finish.",
		],
		parameters: bgSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = requireSession(session);
			const task = current.manager.start({ command: params.command, cwd: ctx.cwd, description: params.description, timeout: params.timeout });
			const text = [
				`Started background task ${task.taskId}: ${taskLabel(task)}`,
				`task_id: ${task.taskId}`,
				`output: ${task.outputPath}`,
				"You will be notified automatically when it exits. Do not poll or sleep; continue with other work and read the output file once notified.",
			].join("\n");
			return { content: [{ type: "text", text }], details: { taskId: task.taskId, outputPath: task.outputPath } satisfies ToolDetails };
		},
		// Drawn without pi's colored box so it lines up with the compact tool rows.
		renderShell: "self",
		...backgroundRenderers,
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Kill Background Task",
		description: "Stop a running bash_background task (and its child processes) by task id.",
		promptSnippet: "Stop a running bash_background task",
		parameters: killSchema,
		async execute(_toolCallId, params) {
			const current = requireSession(session);
			const taskId = params.task_id.trim();
			const before = current.manager.get(taskId);
			if (!before) {
				const known = current.manager.list().map((task) => task.taskId);
				throw new Error(`Unknown background task ${taskId}.${known.length > 0 ? ` Known tasks: ${known.join(", ")}.` : ""}`);
			}
			const wasRunning = before.status === "running";
			const task = (await current.manager.kill(taskId, "model")) ?? before;
			const runtimeMs = (task.endedAt ?? Date.now()) - task.startedAt;
			const runtime = formatDuration(runtimeMs);
			let text: string;
			if (!wasRunning) text = `${taskId} had already finished: ${task.status}${task.exitCode !== undefined ? ` (exit code ${task.exitCode})` : ""}.`;
			else if (task.status === "running") text = `Kill signal sent to ${taskId}, but it has not exited yet.`;
			else text = `Stopped ${taskId} (${taskLabel(task)}) after ${runtime}.`;
			return {
				content: [{ type: "text", text: `${text}\noutput: ${task.outputPath}` }],
				details: {
					taskId,
					outputPath: task.outputPath,
					status: task.status,
					label: taskLabel(task),
					runtimeMs,
					wasRunning,
				} satisfies ToolDetails,
			};
		},
		renderShell: "self",
		...killRenderers,
	});

	// The /shizuku panel (pi-shizuku-settings). The running session picks a change up at once.
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	exposeSettings(pi, {
		id: "pi-background-shell",
		title: "pi-background-shell",
		description: "Background shell tasks that wake the agent when they exit",
		file: configPath,
		items: () => settingsItems(session?.config ?? loadConfig(configPath)),
		set: (id, value) =>
			setSetting(configPath, id, value, (config) => {
				if (session) session.config = config;
			}),
	});

	pi.registerCommand("background", {
		description: "Show background tasks (list, output tail, kill)",
		handler: (_args, ctx) => showPanel(ctx),
	});
}

interface Session {
	manager: TaskManager;
	config: BgConfig;
	drainAtBoundary(event: BoundaryState): BoundaryResult | undefined;
	drainSettled(aborted: boolean): void;
	close(): void;
}

function startSession(pi: ExtensionAPI, ctx: ExtensionContext): Session {
	const sessionManager = ctx.sessionManager;
	const outputRoot = join(sessionManager.getSessionDir(), "bg-tasks");
	const sessionId = sessionManager.getSessionId();
	// Finished tasks still report through the exit callback after shutdown; the old pi/ctx must not be touched then.
	let closed = false;

	const emitState = (): void => {
		if (closed) return;
		const running = manager.runningCount();
		pi.events.emit(STATE_CHANNEL, { running } satisfies BgState);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, running > 0 ? `${running} shell${running === 1 ? "" : "s"}` : undefined);
	};

	const deliver = (batch: BgTask[], triggerTurn: boolean): void => {
		markNotified(batch);
		pi.sendMessage(notificationMessage(batch), { triggerTurn, deliverAs: "steer" });
	};

	const manager: TaskManager = new TaskManager({
		outputDir: join(outputRoot, sessionId),
		resolveShell: () => getShellConfig(pi.getSettings().shellPath),
		persist: (task) => {
			if (!closed) pi.appendEntry(ENTRY_TYPE, toEntry(task));
		},
		onFinished: (task) => {
			if (!closed) batcher.enqueue(task);
		},
		onChange: () => {
			// After close, keep the exit hook until the last killed task has really exited.
			if (closed) {
				if (manager.runningCount() === 0) process.off("exit", onExit);
				return;
			}
			emitState();
		},
	});

	const batcher = new NotificationBatcher({
		isIdle: () => ctx.isIdle(),
		hasRunning: () => manager.runningCount() > 0,
		deliverIdle: (batch) => deliver(batch, true),
		windowMs: DEFAULT_WINDOW_MS,
	});

	const entries: BgTaskEntry[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) entries.push(entry.data as BgTaskEntry);
	}
	for (const task of manager.restore(entries)) pi.appendEntry(ENTRY_TYPE, toEntry(task));

	// session_shutdown does not run when pi exits on a signal or crash; kill synchronously on the way out.
	const onExit = (): void => manager.killAllSync();
	process.on("exit", onExit);
	const unsubscribeRequest = pi.events.on(STATE_REQUEST_CHANNEL, emitState);

	void cleanupOldOutputs(outputRoot, sessionId);
	emitState();

	return {
		manager,
		config: loadConfig(join(getAgentDir(), CONFIG_FILE_NAME)),
		drainAtBoundary(event) {
			if (closed || event.outcome !== "completed" || batcher.size === 0) return undefined;
			const batch = batcher.take();
			markNotified(batch);
			const draft: CustomMessageEntryDraft = { type: "custom_message", ...notificationMessage(batch) };
			return { entries: [...event.entries, draft], continue: true };
		},
		drainSettled(aborted) {
			if (closed || batcher.size === 0) return;
			deliver(batcher.take(), !aborted);
		},
		close() {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			pi.events.emit(STATE_CHANNEL, { running: 0 } satisfies BgState);
			closed = true;
			batcher.dispose();
			manager.shutdown();
			unsubscribeRequest();
			if (manager.runningCount() === 0) process.off("exit", onExit);
		},
	};
}

function requireSession(session: Session | undefined): Session {
	if (!session) throw new Error("pi-background-shell is not ready: no active session");
	return session;
}

function markNotified(batch: readonly BgTask[]): void {
	for (const task of batch) task.notified = true;
}

function notificationMessage(batch: readonly BgTask[]): { customType: string; content: string; display: boolean; details: NotificationDetails } {
	return {
		customType: NOTIFICATION_TYPE,
		content: formatNotification(batch),
		display: true,
		details: {
			tasks: batch.map((task) => ({
				taskId: task.taskId,
				label: taskLabel(task),
				status: task.status,
				exitCode: task.exitCode,
				reason: task.reason,
				durationMs: (task.endedAt ?? task.startedAt) - task.startedAt,
				outputPath: task.outputPath,
			})),
		},
	};
}

function toEntry(task: BgTask): BgTaskEntry {
	const { notified: _notified, ...entry } = task;
	return entry;
}

function notificationLine(task: NotificationDetails["tasks"][number], expanded: boolean, theme: Theme): string {
	const exit = task.exitCode !== undefined && task.status !== "completed" ? ` (exit ${task.exitCode})` : "";
	const reason = task.reason ? theme.fg("dim", ` · ${task.reason}`) : "";
	const head = `${theme.fg(STATUS_COLORS[task.status], "●")} ${theme.fg("accent", task.taskId)} ${task.label} ${theme.fg(STATUS_COLORS[task.status], `${task.status}${exit}`)}${reason} ${theme.fg("dim", `· ${formatDuration(task.durationMs)}`)}`;
	return expanded ? `${head}\n  ${theme.fg("dim", task.outputPath)}` : head;
}
