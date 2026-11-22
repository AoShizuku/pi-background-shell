// The /background panel: a task list in the editor slot at the bottom (like pi's own selectors), and a detail overlay
// with the output for the selected task. Selection lists sit at the bottom; long details are overlays.

import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { type DetailSource, elapsed, isKillable, isMoveKey, OVERLAY_OPTIONS, STATUS_COLORS, shownStatus, TaskDetailView } from "./detail.js";
import { ARMED_HINT, KillConfirm } from "./kill-confirm.js";
import { type BgTask, formatDuration, taskLabel } from "./task.js";

export interface PanelSource {
	list(): BgTask[];
	kill(taskId: string): void;
	/** Running and no kill requested yet (TaskManager.canKill); default: running. */
	canKill?(taskId: string): boolean;
	/** x must be pressed twice (§3.8); default true. */
	confirmKill?(): boolean;
}

export interface PanelHost {
	requestRender(): void;
	readonly terminal: { readonly rows: number };
}

const REFRESH_MS = 1000;

/**
 * Task rows the list shows at once. The bottom slot is not height-bounded by pi, so the list keeps to a
 * small share of the terminal, the same as /agents: at most 10 rows or 40% of the height, never fewer than 3.
 */
export function listRowLimit(terminalRows: number): number {
	return Math.max(3, Math.min(10, Math.floor(terminalRows * 0.4)));
}

/** Window of `size` rows that keeps `index` roughly centred. */
function windowAround(count: number, index: number, size: number): { start: number; end: number } {
	if (count <= size) return { start: 0, end: count };
	const start = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
	return { start, end: start + size };
}

/**
 * Put a row on the theme's selection surface. Truncation leaves a full reset inside the row, and that
 * reset would drop the background for everything after it, so the background is re-applied after each one.
 */
function onSelectionSurface(theme: Theme, content: string, armed: boolean): string {
	// An armed row (first x pressed) swaps the selection surface for the error surface (§3.8).
	const surface = armed ? "toolErrorBg" : "selectedBg";
	const band = theme.getBgAnsi(surface);
	return theme.bg(surface, content.replace(/\x1b\[0m/g, `\x1b[0m${band}`));
}

/** Cut a row to the width and pad it, so the selection surface reaches the right edge. */
function fillToWidth(content: string, width: number): string {
	const cut = truncateToWidth(content, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/**
 * A titled rule, `─ left ───── right ─`, the full width (design_style.md §4.1): a bottom panel's top edge, and
 * the same shape for a divider inside a panel. Labels come in already colored; only the rule is painted here.
 * When the row is narrow the fill shrinks to one `─` first, then each right label is tried in turn (full form,
 * then shorter ones) and finally dropped, and last the left label is cut with `…`. The leading `─ ` and the
 * closing `─` always stay.
 */
export function titledRule(
	width: number,
	paint: (rule: string) => string,
	left: string,
	right: string | readonly string[] = [],
): string {
	const rule = (count: number) => paint("─".repeat(count));
	if (width < 4) return rule(Math.max(0, width));
	const leftWidth = visibleWidth(left);
	for (const label of typeof right === "string" ? [right] : right) {
		// `─ ` left ` ` fill ` ` right ` ─`
		const fill = width - leftWidth - visibleWidth(label) - 6;
		if (label && fill >= 1) return `${rule(1)} ${left} ${rule(fill)} ${label} ${rule(1)}`;
	}
	const shown = leftWidth <= width - 4 ? left : truncateToWidth(left, width - 4, "…");
	return `${rule(1)} ${shown} ${rule(width - 3 - visibleWidth(shown))}`;
}

/**
 * Open the task panel and resolve when the user closes it. The list replaces the editor (no overlay) and keeps
 * the transcript visible; Enter opens the detail overlay on top of it. pi hands the keyboard back to the list
 * when the overlay closes, so the list stays open with the same task selected.
 */
export async function openPanel(ctx: Pick<ExtensionContext, "ui">, source: PanelSource): Promise<void> {
	let detailOpen = false;
	const detailSource: DetailSource = {
		get: (taskId) => source.list().find((task) => task.taskId === taskId),
		kill: (taskId) => source.kill(taskId),
		canKill: (taskId) => source.canKill?.(taskId) ?? true,
		confirmKill: () => source.confirmKill?.() ?? true,
	};
	const openDetail = (taskId: string): void => {
		if (detailOpen) return;
		detailOpen = true;
		ctx.ui
			.custom<void>((tui, theme, keybindings, done) => new TaskDetailView(tui, theme, keybindings, detailSource, taskId, () => done()), {
				overlay: true,
				overlayOptions: { ...OVERLAY_OPTIONS },
			})
			.catch(() => {
				// The UI went away (session switch); nothing to restore.
			})
			.finally(() => {
				detailOpen = false;
			});
	};
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => new TaskPanel(tui, theme, keybindings, source, openDetail, () => done()));
}

/** Plain-text task list for modes without a TUI. */
export function describeTasks(tasks: readonly BgTask[], now = Date.now()): string {
	if (tasks.length === 0) return "No background tasks in this session.";
	return tasks.map((task) => `${task.taskId}  ${task.status}  ${formatDuration(elapsed(task, now))}  ${taskLabel(task)}`).join("\n");
}

export class TaskPanel {
	private readonly refresh: ReturnType<typeof setInterval>;
	private selected = 0;
	private closed = false;
	private readonly confirm: KillConfirm;

	constructor(
		private readonly host: PanelHost,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly source: PanelSource,
		private readonly openDetail: (taskId: string) => void,
		private readonly done: () => void,
	) {
		this.confirm = new KillConfirm(() => source.confirmKill?.() ?? true);
		// Durations and statuses change while the panel is open.
		this.refresh = setInterval(() => this.host.requestRender(), REFRESH_MS);
	}

	render(width: number): string[] {
		const tasks = this.source.list();
		this.selected = Math.min(this.selected, Math.max(0, tasks.length - 1));
		return this.renderList(tasks, width).map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const tasks = this.source.list();
		const task = tasks[this.selected];

		// Armed (§3.8): only x goes on to kill. ↑↓ cancel and still move; every other key, Esc and Enter
		// included, only cancels, so backing out of the kill does not also close the panel or open a detail.
		this.confirm.keep(task?.taskId, task !== undefined && isKillable(task, this.source));
		if (this.confirm.isArmed(task?.taskId) && data !== "x") {
			this.confirm.cancel();
			if (!isMoveKey(data, this.keybindings)) return this.host.requestRender();
		}

		if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
			return this.close();
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = Math.min(tasks.length - 1, this.selected + 1);
		} else if (this.keybindings.matches(data, "tui.select.confirm") && task) {
			this.openDetail(task.taskId);
		} else if (data === "x" && task && isKillable(task, this.source)) {
			if (this.confirm.press(task.taskId)) this.source.kill(task.taskId);
		} else {
			return;
		}
		this.host.requestRender();
	}

	invalidate(): void {
		// Rendered from live task state every time.
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.refresh);
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.done();
	}

	private renderList(tasks: readonly BgTask[], width: number): string[] {
		const { theme } = this;
		const running = tasks.filter((task) => task.status === "running").length;
		// The title sits on the top edge, which carries on the editor's top border; the counts go on its right.
		const counts = [`${running} running, ${tasks.length} total`, `${tasks.length} total`].map((text) => theme.fg("dim", text));
		const lines = [titledRule(width, (rule) => theme.fg("borderMuted", rule), theme.bold(theme.fg("accent", "Background tasks")), counts), ""];
		if (tasks.length === 0) lines.push(theme.fg("dim", "  No background tasks in this session."));
		const now = Date.now();
		// The armed task may have exited on its own since the first x: the arm goes with it.
		const selectedTask = tasks[this.selected];
		this.confirm.keep(selectedTask?.taskId, selectedTask !== undefined && isKillable(selectedTask, this.source));
		const armed = this.confirm.isArmed(selectedTask?.taskId);
		const { start, end } = windowAround(tasks.length, this.selected, listRowLimit(this.host.terminal.rows));
		if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
		tasks.slice(start, end).forEach((task, offset) => {
			const isSelected = start + offset === this.selected;
			// The selected row is marked twice: a bar at the left edge and the theme's selection surface.
			// Armed, the bar turns to the error color along with the surface.
			const cursor = isSelected ? theme.fg(armed ? "error" : "accent", "▎ ") : "  ";
			// The selection surface is lighter than the terminal background, so dim text fades on it.
			// The selected row steps one level up to stay readable, the dim `killing` status included.
			const dim = isSelected ? "muted" : "dim";
			const shown = shownStatus(task, this.source);
			// A task being killed is still running; it shows as killing, in the dim color.
			const statusColor = shown === "killing" ? dim : STATUS_COLORS[task.status];
			const status = theme.fg(statusColor, shown.padEnd(9));
			const duration = theme.fg(dim, formatDuration(elapsed(task, now)).padStart(7));
			const content = `${cursor}${theme.fg("text", task.taskId.padEnd(6))} ${status} ${duration}  ${taskLabel(task)}`;
			// The selected row fills the line: the surface runs to the right edge. It is cut to the width
			// first, because cutting it afterwards would drop the background at the cut.
			lines.push(isSelected ? onSelectionSurface(theme, fillToWidth(content, width), armed) : content);
		});
		if (end < tasks.length) lines.push(theme.fg("dim", `  ↓ ${tasks.length - end} more`));
		// Armed, the whole key line gives way to the confirmation prompt.
		lines.push("", armed ? theme.fg("error", ARMED_HINT) : theme.fg("dim", "↑↓ select · enter details · x kill · esc close"));
		return lines;
	}
}
