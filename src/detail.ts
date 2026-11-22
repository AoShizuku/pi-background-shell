// Detail overlay for one task: its fields and a scrollable, tail -f style view of its output file.
//
// The overlay windows its own content: pi renders an overlay by calling render() and cutting the result to
// maxHeight, so returning every output line would just lose the bottom of the box. Wheel events over an
// overlay go to its handleMouse, which scrolls this view. Mirrors pi-subagent's agent detail overlay.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TuiMouseEvent, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { ARMED_HINT, KillConfirm } from "./kill-confirm.js";
import { type BgTask, formatDuration, type TaskStatus } from "./task.js";

export interface DetailSource {
	get(taskId: string): BgTask | undefined;
	kill(taskId: string): void;
	/** Running and no kill requested yet (TaskManager.canKill); default: running. */
	canKill?(taskId: string): boolean;
	/** x must be pressed twice (§3.8); default true. */
	confirmKill?(): boolean;
}

/** x can kill it: running, and no kill requested yet. */
export function isKillable(task: BgTask, source: Pick<DetailSource, "canKill">): boolean {
	return task.status === "running" && (source.canKill?.(task.taskId) ?? true);
}

/** Between the kill request and the process exit the task is still `running`; it shows as killing. */
export function shownStatus(task: BgTask, source: Pick<DetailSource, "canKill">): string {
	return task.status === "running" && !isKillable(task, source) ? "killing" : task.status;
}

/** Keys that move (a selection or a scroll position): they cancel an armed kill and still move. */
export function isMoveKey(data: string, keybindings: KeybindingsManager): boolean {
	return (
		keybindings.matches(data, "tui.select.up") ||
		keybindings.matches(data, "tui.select.down") ||
		matchesKey(data, "pageUp") ||
		matchesKey(data, "pageDown") ||
		matchesKey(data, "home") ||
		matchesKey(data, "end")
	);
}

export interface DetailHost {
	requestRender(): void;
	readonly terminal: { readonly rows: number };
}

export interface OutputTail {
	lines: string[];
	/** Earlier output was left out (byte or line cap). */
	truncated: boolean;
}

export type TailFn = (path: string) => OutputTail;

export const OVERLAY_OPTIONS = { width: "90%", maxHeight: "80%", anchor: "center" } as const;
export const TAIL_BYTES = 256 * 1024;
export const TAIL_LINES = 2000;
const REFRESH_MS = 1000;
const MIN_VIEWPORT = 3;
const TAB = "    ";

/** Status colors of design_style.md §3: running accent, a killed task did not finish but did not fail. */
export const STATUS_COLORS: Record<TaskStatus, ThemeColor> = {
	running: "accent",
	completed: "success",
	failed: "error",
	killed: "warning",
	timeout: "error",
};

export function elapsed(task: BgTask, now: number): number {
	return (task.endedAt ?? (task.status === "running" ? now : task.startedAt)) - task.startedAt;
}

/** Strip escape sequences and control characters; they would corrupt the overlay. Tabs become spaces. */
export function cleanOutput(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, TAB)
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The last `maxBytes` of a file as at most `maxLines` cleaned lines. A missing file reads as empty. */
export function readTail(path: string, maxBytes = TAIL_BYTES, maxLines = TAIL_LINES): OutputTail {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return splitTail(buffer.toString("utf8"), length < size, maxLines);
	} catch {
		return { lines: [], truncated: false };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function splitTail(raw: string, cut: boolean, maxLines: number): OutputTail {
	let text = cleanOutput(raw).replace(/\n+$/, "");
	// Started mid-file: the first line is partial (and may begin with half a UTF-8 character).
	// A single line longer than the read is kept as it is.
	const firstBreak = text.indexOf("\n");
	if (cut && firstBreak >= 0) text = text.slice(firstBreak + 1);
	if (!text) return { lines: [], truncated: cut };
	const lines = text.split("\n");
	return lines.length > maxLines ? { lines: lines.slice(-maxLines), truncated: true } : { lines, truncated: cut };
}

/** readTail that re-reads only when the file's size or mtime changed; the 1 s refresh mostly hits the cache. */
export function cachedTail(read: (path: string) => OutputTail = readTail, stat: (path: string) => string | undefined = statKey): TailFn {
	let cache: { path: string; key: string; tail: OutputTail } | undefined;
	return (path) => {
		const key = stat(path);
		if (key !== undefined && cache?.path === path && cache.key === key) return cache.tail;
		const tail = read(path);
		cache = key === undefined ? undefined : { path, key, tail };
		return tail;
	};
}

function statKey(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const stats = fstatSync(fd);
		return `${stats.size}:${stats.mtimeMs}`;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Scroll state with follow-the-end behaviour: following until the user scrolls up, again at the bottom. */
export class ScrollState {
	top = 0;
	following: boolean;
	private maxTop = 0;
	private viewport = 1;

	constructor(follow: boolean) {
		this.following = follow;
	}

	/** Fit to the latest content; returns the first visible line. */
	layout(contentLines: number, viewport: number): number {
		this.viewport = Math.max(1, viewport);
		this.maxTop = Math.max(0, contentLines - this.viewport);
		this.top = this.following ? this.maxTop : Math.min(this.top, this.maxTop);
		return this.top;
	}

	scrollBy(lines: number): void {
		if (lines === 0) return;
		const start = this.following ? this.maxTop : this.top;
		this.top = Math.max(0, Math.min(this.maxTop, start + lines));
		// Scrolling up stops following; scrolling down to the bottom resumes it. Output that fits keeps following.
		this.following = this.top >= this.maxTop;
	}

	page(direction: 1 | -1): void {
		this.scrollBy(direction * Math.max(1, this.viewport - 1));
	}

	toStart(): void {
		this.top = 0;
		this.following = this.top >= this.maxTop;
	}

	toEnd(): void {
		this.following = true;
		this.top = this.maxTop;
	}
}

export class TaskDetailView implements Component {
	// Output viewer: opens at the bottom and follows new output like tail -f.
	private readonly scroll = new ScrollState(true);
	private readonly tick: ReturnType<typeof setInterval>;
	private readonly tail: TailFn;
	private wrapCache: { tail: OutputTail; width: number; lines: string[] } | undefined;
	private closed = false;
	private readonly confirm: KillConfirm;

	constructor(
		private readonly host: DetailHost,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly source: DetailSource,
		private readonly taskId: string,
		private readonly done: () => void,
		tail: TailFn = cachedTail(),
	) {
		this.tail = tail;
		this.confirm = new KillConfirm(() => source.confirmKill?.() ?? true);
		// Runtime and output change while the overlay is open.
		this.tick = setInterval(() => this.host.requestRender(), REFRESH_MS);
	}

	render(width: number): string[] {
		const { theme } = this;
		const task = this.source.get(this.taskId);
		if (!task || width < 10) return [];
		const dim = (text: string) => theme.fg("dim", text);
		const border = (text: string) => theme.fg("dim", text);
		const inner = width - 4;
		const height = Math.max(MIN_VIEWPORT + 3, Math.floor(this.host.terminal.rows * 0.8));

		const tail = this.tail(task.outputPath);
		const output = this.wrap(tail, inner);
		if (tail.truncated) output.unshift(dim(`… earlier output not shown; full log: ${task.outputPath}`));
		if (output.length === 0) output.push(dim("(no output yet)"));

		// Fixed header, scrolling output; the header gives way first on a short terminal.
		const header = this.header(task, tail.lines.length);
		const available = height - 3;
		const shownHeader = header.slice(0, Math.max(0, available - MIN_VIEWPORT));
		const viewport = available - shownHeader.length;
		const top = this.scroll.layout(output.length, viewport);
		const body = output.slice(top, top + viewport);
		// A fixed-height box: a centred overlay that grew with each new line would jump around.
		while (body.length < viewport) body.push("");

		const title = truncateToWidth(theme.bold(` Shell details · ${task.taskId} `), Math.max(4, width - 4), "…");
		const lines = [`${border("╭─")}${title}${border("─".repeat(Math.max(0, width - 3 - visibleWidth(title))))}${border("╮")}`];
		const row = (text: string) => {
			const cut = truncateToWidth(text, inner, "…");
			return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
		};
		for (const line of shownHeader) lines.push(row(line));
		for (const line of body) lines.push(row(line));
		lines.push(row(this.hint(task, top, viewport, output.length)));
		lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const current = this.source.get(this.taskId);
		// Armed (§3.8): only x goes on to kill. Scroll keys cancel and still scroll; every other key, Esc
		// included, only cancels, so backing out of the kill does not also close the overlay.
		this.confirm.keep(this.taskId, current !== undefined && isKillable(current, this.source));
		if (this.confirm.isArmed(this.taskId) && data !== "x") {
			this.confirm.cancel();
			if (!isMoveKey(data, kb)) {
				this.host.requestRender();
				return;
			}
		}
		if (kb.matches(data, "tui.select.cancel") || data === "q") {
			this.close();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
		else if (kb.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scroll.page(-1);
		else if (matchesKey(data, "pageDown")) this.scroll.page(1);
		else if (matchesKey(data, "home")) this.scroll.toStart();
		else if (matchesKey(data, "end")) this.scroll.toEnd();
		else if (data === "x") {
			if (!current || !isKillable(current, this.source)) return;
			if (this.confirm.press(this.taskId)) this.source.kill(this.taskId);
		} else return;
		this.host.requestRender();
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		// Scrolling moves, like the scroll keys: it cancels an armed kill.
		this.confirm.cancel();
		this.scroll.scrollBy(event.wheelDelta);
		return { handled: true };
	}

	invalidate(): void {
		this.wrapCache = undefined;
	}

	dispose(): void {
		this.cleanup();
	}

	private close(): void {
		if (this.closed) return;
		this.cleanup();
		this.done();
	}

	private cleanup(): void {
		this.closed = true;
		clearInterval(this.tick);
	}

	private header(task: BgTask, outputLines: number): string[] {
		const { theme } = this;
		const dim = (text: string) => theme.fg("dim", text);
		const exit = task.exitCode !== undefined ? dim(` (exit ${task.exitCode})`) : "";
		const lines = [
			`${dim("Status   ")}${theme.fg(STATUS_COLORS[task.status], shownStatus(task, this.source))}${exit}${task.reason ? dim(` · ${task.reason}`) : ""}`,
			`${dim("Runtime  ")}${formatDuration(elapsed(task, Date.now()))}`,
			`${dim("Command  ")}${task.command.replace(/\s+/g, " ")}`,
		];
		if (task.description) lines.push(`${dim("Label    ")}${task.description}`);
		lines.push(`${dim("Output   ")}${task.outputPath}`, dim(`── output · ${outputLines} line${outputLines === 1 ? "" : "s"} ──`));
		return lines;
	}

	private hint(task: BgTask, top: number, viewport: number, total: number): string {
		const { theme } = this;
		// The task may have exited on its own since the first x: the arm goes with it.
		const killable = isKillable(task, this.source);
		this.confirm.keep(this.taskId, killable);
		// Armed, the whole key line gives way to the confirmation prompt.
		if (this.confirm.isArmed(this.taskId)) return theme.fg("error", ARMED_HINT);
		const parts = [total > viewport ? "↑↓/wheel scroll · pgup/pgdn · home/end" : undefined, killable ? "x kill" : undefined, "esc close"];
		const keys = theme.fg("dim", parts.filter(Boolean).join(" · "));
		if (this.scroll.following) return keys;
		const position = `paused at ${Math.min(total, top + viewport)}/${total} · end to follow`;
		return `${theme.fg("warning", position)}${theme.fg("dim", " · ")}${keys}`;
	}

	/** Long output lines wrap rather than being cut; cached while the tail and width stay the same. */
	private wrap(tail: OutputTail, width: number): string[] {
		if (this.wrapCache?.tail !== tail || this.wrapCache.width !== width) {
			const lines = tail.lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
			this.wrapCache = { tail, width, lines };
		}
		return [...this.wrapCache.lines];
	}
}
