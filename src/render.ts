// Rows for `bash_background` and `bg_kill`, drawn with renderShell: "self" so they line up with pi's
// compact tool rows instead of sitting in a colored box:
//
//   ● Background Bash (等待 8 个话题的拍板回复) · bg-1 running in background
//   ● Background Interrupted (bg-7 · 启动 woclient dev) · Stopped · 1h11m
//
// renderCall returns one long-lived component that reads the shared renderer state at render time;
// renderResult only records the latest result there, because the marker color depends on the result
// and pi rebuilds the call component before the result one.

import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { formatDuration, type TaskStatus, taskLabel } from "./task.js";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type ThemeColor = Parameters<Theme["fg"]>[0];

/** details of both tools' results. Fields after outputPath only exist on bg_kill results. */
export interface ToolDetails {
	taskId?: string;
	outputPath?: string;
	status?: TaskStatus;
	label?: string;
	runtimeMs?: number;
	wasRunning?: boolean;
}

interface RowResult {
	text: string;
	details?: ToolDetails;
	isError: boolean;
}

interface RowState {
	row?: ToolRow;
	result?: RowResult;
}

type Kind = "background" | "kill";

const TITLES: Record<Kind, string> = {
	background: "Background Bash",
	kill: "Background Interrupted",
};

const MAX_COMMAND_LINES = 12;
const EMPTY: Component = { render: () => [], invalidate: () => {} };

/** Gutter convention (pi-shizuku README.md): markers sit in column 0, so rows ignore pi's outputPad. */
const MARKER_COLUMN = 0;

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/)[0] ?? "";
}

interface KillOutcome {
	color: ThemeColor;
	summary: string;
	label?: string;
}

/** What a bg_kill did, from its details, or from the result text for sessions written before they existed. */
export function killOutcome(result: RowResult): KillOutcome {
	const details = result.details;
	if (details?.wasRunning !== undefined) {
		if (!details.wasRunning) return { color: "success", summary: `Already finished · ${details.status ?? "done"}`, label: details.label };
		if (details.status === "running") return { color: "warning", summary: "Signal sent · still running", label: details.label };
		const runtime = details.runtimeMs !== undefined ? ` · ${formatDuration(details.runtimeMs)}` : "";
		return { color: "success", summary: `Stopped${runtime}`, label: details.label };
	}
	const line = firstLine(result.text);
	const stopped = /^Stopped \S+ \((.*)\) after (.+)\.$/.exec(line);
	if (stopped) return { color: "success", summary: `Stopped · ${stopped[2]}`, label: stopped[1] };
	const finished = /had already finished: (\w+)/.exec(line);
	if (finished) return { color: "success", summary: `Already finished · ${finished[1]}` };
	if (line.startsWith("Kill signal sent")) return { color: "warning", summary: "Signal sent · still running" };
	return { color: "success", summary: line };
}

export class ToolRow implements Component {
	args: Record<string, unknown> = {};
	theme: Theme | undefined;
	expanded = false;
	pad = 0;

	constructor(
		private readonly kind: Kind,
		private readonly state: RowState,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme || width <= 0) return [];
		const pad = " ".repeat(this.pad);
		const result = this.state.result;
		const lines = [truncateToWidth(`${pad}${this.header(theme, result)}`, width, "…")];
		if (this.expanded) {
			for (const line of this.detailLines(theme, result, Math.max(1, width - this.pad - 2))) {
				lines.push(truncateToWidth(`${pad}  ${line}`, width, "…"));
			}
		}
		return lines;
	}

	invalidate(): void {
		// Everything is derived from the shared state at render time.
	}

	private header(theme: Theme, result: RowResult | undefined): string {
		const title = theme.fg("toolTitle", theme.bold(TITLES[this.kind]));
		if (result?.isError) {
			const detail = this.detail(theme, undefined);
			return `${theme.fg("error", "×")} ${title}${detail}${theme.fg("error", ` · ${firstLine(result.text) || "failed"}`)}`;
		}
		if (this.kind === "background") {
			const marker = theme.fg(result ? "success" : "accent", "●");
			const taskId = result?.details?.taskId;
			const summary = result
				? taskId
					? `${theme.fg("dim", " · ")}${theme.fg("accent", taskId)}${theme.fg("dim", " running in background")}`
					: theme.fg("dim", ` · ${firstLine(result.text)}`)
				: "";
			return `${marker} ${title}${this.detail(theme, undefined)}${summary}`;
		}
		if (!result) return `${theme.fg("accent", "●")} ${title}${this.detail(theme, undefined)}`;
		const outcome = killOutcome(result);
		const summary = outcome.summary ? theme.fg("dim", ` · ${outcome.summary}`) : "";
		return `${theme.fg(outcome.color, "●")} ${title}${this.detail(theme, outcome.label)}${summary}`;
	}

	private detail(theme: Theme, label: string | undefined): string {
		let text: string;
		if (this.kind === "background") {
			const command = typeof this.args.command === "string" ? this.args.command : "";
			const description = typeof this.args.description === "string" ? this.args.description : undefined;
			text = taskLabel({ command, description });
		} else {
			const taskId = typeof this.args.task_id === "string" ? this.args.task_id.trim() : "";
			text = [taskId, label?.trim()].filter(Boolean).join(" · ");
		}
		return text ? ` ${theme.fg("muted", `(${text})`)}` : "";
	}

	private detailLines(theme: Theme, result: RowResult | undefined, width: number): string[] {
		const lines: string[] = [];
		if (this.kind === "background") {
			const command = typeof this.args.command === "string" ? this.args.command.replace(/\r\n?/g, "\n").trim() : "";
			const wrapped = command ? command.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width - 2)) : [""])) : [];
			wrapped.slice(0, MAX_COMMAND_LINES).forEach((line, index) => {
				lines.push(`${index === 0 ? theme.fg("accent", "$ ") : "  "}${theme.fg("text", line)}`);
			});
			const hidden = wrapped.length - MAX_COMMAND_LINES;
			if (hidden > 0) lines.push(theme.fg("dim", `  … ${hidden} more command line${hidden === 1 ? "" : "s"}`));
		}
		if (result?.isError) {
			const rest = result.text.trim().split(/\r?\n/).slice(1).filter((line) => line.trim());
			for (const line of rest) lines.push(theme.fg("error", line));
		}
		const outputPath = result?.details?.outputPath;
		if (outputPath) {
			const prefix = "output: ";
			const wrapped = wrapTextWithAnsi(outputPath, Math.max(1, width - visibleWidth(prefix)));
			wrapped.forEach((line, index) => lines.push(theme.fg("dim", `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`)));
		}
		return lines;
	}
}

function renderers(kind: Kind): { renderCall: RenderCall; renderResult: RenderResult } {
	return {
		renderCall(args, theme, context) {
			const state = context.state as RowState;
			const row = state.row ?? new ToolRow(kind, state);
			state.row = row;
			row.args = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
			row.theme = theme;
			row.expanded = context.expanded;
			row.pad = MARKER_COLUMN;
			return row;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as RowState;
			const text = result.content
				.filter((part) => part.type === "text")
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("\n");
			state.result = { text, details: result.details as ToolDetails | undefined, isError: context.isError };
			if (state.row) {
				state.row.theme = theme;
				state.row.expanded = options.expanded;
				state.row.pad = MARKER_COLUMN;
			}
			return EMPTY;
		},
	};
}

export const backgroundRenderers = renderers("background");
export const killRenderers = renderers("kill");
