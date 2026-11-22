import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { backgroundRenderers, killRenderers, type ToolDetails } from "./render.js";

/** Tags the marker colors so they are visible in assertions. */
const theme = {
	fg: (color: string, text: string) => (["accent", "success", "error", "warning"].includes(color) && text.length === 1 ? `<${color}>${text}` : text),
	bold: (text: string) => text,
} as unknown as Theme;

type Renderers = typeof backgroundRenderers;

function row(
	renderers: Renderers,
	args: Record<string, unknown>,
	result?: { text: string; details?: ToolDetails; isError?: boolean },
	options: { outputPad?: number; expanded?: boolean } = {},
) {
	const context = {
		state: {},
		expanded: options.expanded ?? false,
		isError: result?.isError ?? false,
		outputPad: options.outputPad ?? 1,
		lastComponent: undefined,
	} as never;
	const component = renderers.renderCall(args as never, theme, context);
	if (result) {
		renderers.renderResult(
			{ content: [{ type: "text", text: result.text }], details: result.details } as never,
			{ expanded: options.expanded ?? false, isPartial: false },
			theme,
			context,
		);
	}
	return component.render(200);
}

describe("bash_background row", () => {
	const args = { command: "npm run dev", description: "启动 dev server" };

	it("draws a bash-style line with the marker in column 0, whatever the outputPad", () => {
		expect(row(backgroundRenderers, args)).toEqual(["<accent>● Background Bash (启动 dev server)"]);
		expect(row(backgroundRenderers, args, { text: "Started", details: { taskId: "bg-1", outputPath: "/o/bg-1.output" } }, { outputPad: 2 })).toEqual([
			"<success>● Background Bash (启动 dev server) · bg-1 running in background",
		]);
	});

	it("falls back to the command when there is no description", () => {
		expect(row(backgroundRenderers, { command: "sleep   10" })).toEqual(["<accent>● Background Bash (sleep 10)"]);
	});

	it("shows the command and output file when expanded", () => {
		const lines = row(backgroundRenderers, args, { text: "Started", details: { taskId: "bg-1", outputPath: "/o/bg-1.output" } }, { expanded: true });
		expect(lines.slice(1)).toEqual(["  $ npm run dev", "  output: /o/bg-1.output"]);
	});

	it("marks a failed start red", () => {
		expect(row(backgroundRenderers, args, { text: "Error: no shell", isError: true })).toEqual([
			"<error>× Background Bash (启动 dev server) · Error: no shell",
		]);
	});
});

describe("bg_kill row", () => {
	const args = { task_id: "bg-7" };
	const output = "/o/bg-7.output";

	it("shows the task, its label and how long it ran", () => {
		expect(row(killRenderers, args)).toEqual(["<accent>● Background Interrupted (bg-7)"]);
		const details: ToolDetails = { taskId: "bg-7", outputPath: output, status: "killed", label: "启动 woclient dev (5975)", runtimeMs: 4_260_000, wasRunning: true };
		expect(row(killRenderers, args, { text: `Stopped bg-7 (启动 woclient dev (5975)) after 1h11m.\noutput: ${output}`, details })).toEqual([
			"<success>● Background Interrupted (bg-7 · 启动 woclient dev (5975)) · Stopped · 1h11m",
		]);
	});

	it("keeps the output path for the expanded view", () => {
		const details: ToolDetails = { taskId: "bg-7", outputPath: output, status: "killed", label: "dev", runtimeMs: 1000, wasRunning: true };
		expect(row(killRenderers, args, { text: "Stopped", details }, { expanded: true })[1]).toBe(`  output: ${output}`);
	});

	it("colors each outcome", () => {
		const finished: ToolDetails = { taskId: "bg-7", outputPath: output, status: "completed", label: "dev", runtimeMs: 1000, wasRunning: false };
		expect(row(killRenderers, args, { text: "", details: finished })[0]).toBe("<success>● Background Interrupted (bg-7 · dev) · Already finished · completed");
		const pending: ToolDetails = { ...finished, status: "running", wasRunning: true };
		expect(row(killRenderers, args, { text: "", details: pending })[0]).toBe("<warning>● Background Interrupted (bg-7 · dev) · Signal sent · still running");
		expect(row(killRenderers, args, { text: "Unknown background task bg-7.", isError: true })[0]).toBe(
			"<error>× Background Interrupted (bg-7) · Unknown background task bg-7.",
		);
	});

	it("reads results saved before the details carried label and runtime", () => {
		const details: ToolDetails = { taskId: "bg-7", outputPath: output, status: "killed" };
		expect(row(killRenderers, args, { text: `Stopped bg-7 (启动 woclient dev (5975)) after 1h11m.\noutput: ${output}`, details })[0]).toBe(
			"<success>● Background Interrupted (bg-7 · 启动 woclient dev (5975)) · Stopped · 1h11m",
		);
		expect(row(killRenderers, args, { text: `bg-7 had already finished: completed (exit code 0).\noutput: ${output}`, details })[0]).toBe(
			"<success>● Background Interrupted (bg-7) · Already finished · completed",
		);
	});
});
