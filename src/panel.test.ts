import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { TaskDetailView } from "./detail.js";
import { describeTasks, openPanel, type PanelSource, TaskPanel } from "./panel.js";
import type { BgTask } from "./task.js";

/** The mock marks the background with a zero-width escape, the way the real theme does. */
const SELECTED_BG = "\x1b[41m";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => `${SELECTED_BG}${text}\x1b[0m`, getBgAnsi: (_color: string) => SELECTED_BG } as unknown as Theme;
const KEYS: Record<string, string> = { "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r" };
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data } as unknown as KeybindingsManager;
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

function task(taskId: string, overrides: Partial<BgTask> = {}): BgTask {
	return { taskId, command: `echo ${taskId}`, status: "running", startedAt: 0, outputPath: `/no/such/${taskId}.log`, notified: false, ...overrides };
}

interface Component {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose?(): void;
}

interface CustomCall {
	options?: { overlay?: boolean; overlayOptions?: unknown };
	component: Component;
	settled: boolean;
}

/** ctx.ui.custom that builds the component and settles when it calls done, as pi does (dispose included). */
function fakeUi() {
	const calls: CustomCall[] = [];
	const host = { requestRender: () => {}, terminal: { rows: 30 } };
	const custom = (factory: (...args: unknown[]) => Component, options?: CustomCall["options"]) =>
		new Promise<void>((resolve) => {
			const call = { options, settled: false } as CustomCall;
			call.component = factory(host, theme, keybindings, () => {
				call.settled = true;
				call.component.dispose?.();
				resolve();
			});
			calls.push(call);
		});
	return { ctx: { ui: { custom } } as unknown as Pick<ExtensionContext, "ui">, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("/background panel", () => {
	const open: Component[] = [];
	afterEach(() => {
		for (const component of open.splice(0)) component.dispose?.();
	});

	it("lists at the bottom and opens the detail as an overlay on top of it", async () => {
		const tasks = [task("bg-1"), task("bg-2", { status: "completed", exitCode: 0, endedAt: 1000 })];
		const { ctx, calls } = fakeUi();
		let panelClosed = false;
		const panel = openPanel(ctx, { list: () => tasks, kill: () => {} }).then(() => {
			panelClosed = true;
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toBeUndefined();
		const list = calls[0]!.component;
		open.push(list);
		expect(list).toBeInstanceOf(TaskPanel);
		// The title and the counts sit on the top edge; narrow, the counts shorten before the title is cut.
		expect(list.render(80)[0]).toMatch(/^─ Background tasks ─+ 1 running, 2 total ─$/);
		expect(list.render(32)[0]).toMatch(/^─ Background tasks ─+ 2 total ─$/);
		expect(visibleWidth(list.render(80)[0]!)).toBe(80);

		list.handleInput(DOWN);
		list.handleInput(ENTER);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.options).toEqual({ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
		const detail = calls[1]!.component;
		open.push(detail);
		expect(detail).toBeInstanceOf(TaskDetailView);
		expect(detail.render(80)[0]).toContain("bg-2");

		// Only one detail at a time.
		list.handleInput(ENTER);
		expect(calls).toHaveLength(2);

		// Esc closes the detail only; the list keeps its selection and can open it again.
		detail.handleInput(ESC);
		await flush();
		expect(calls[1]?.settled).toBe(true);
		expect(calls[0]?.settled).toBe(false);
		expect(list.render(80).find((line) => line.startsWith(`${SELECTED_BG}▎ `))).toContain("bg-2");
		list.handleInput(ENTER);
		expect(calls).toHaveLength(3);
		calls[2]!.component.handleInput("q");
		await flush();
		expect(panelClosed).toBe(false);

		list.handleInput(ESC);
		await panel;
		expect(panelClosed).toBe(true);
	});

	it("q closes the list", async () => {
		const { ctx, calls } = fakeUi();
		const panel = openPanel(ctx, { list: () => [], kill: () => {} });
		calls[0]!.component.handleInput("q");
		await panel;
		expect(calls[0]?.settled).toBe(true);
	});

	function killPanel(tasks: BgTask[], options: { confirm?: boolean; panelTheme?: Theme } = {}) {
		const killed: string[] = [];
		const opened: string[] = [];
		let closed = 0;
		const requested = new Set<string>();
		const source: PanelSource = {
			list: () => tasks,
			kill: (id) => {
				killed.push(id);
				requested.add(id);
			},
			canKill: (id) => !requested.has(id),
			confirmKill: () => options.confirm ?? true,
		};
		const list = new TaskPanel({ requestRender: () => {}, terminal: { rows: 30 } }, options.panelTheme ?? theme, keybindings, source, (id) => opened.push(id), () => closed++);
		open.push(list);
		return { list, killed, opened, closed: () => closed };
	}

	/** Marks colors and surfaces by name, to tell the armed row from the plain selection. */
	const marking = {
		...theme,
		fg: (color: string, text: string) => (color === "error" || color === "accent" ? `<${color}>${text}` : text),
		bg: (color: string, text: string) => `[${color}]${text}`,
		getBgAnsi: (color: string) => `[${color}]`,
	} as unknown as Theme;

	it("x x kills the selected running task; nothing for a finished one", () => {
		const tasks = [task("bg-1"), task("bg-2", { status: "failed", exitCode: 1, endedAt: 10 })];
		const { list, killed } = killPanel(tasks);
		list.handleInput("x");
		expect(killed).toEqual([]);
		list.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
		list.handleInput(DOWN);
		list.handleInput("x");
		list.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
		expect(list.render(100).at(-1)).toBe("↑↓ select · enter details · x kill · esc close");
	});

	it("with confirmKill off, one x kills", () => {
		const { list, killed } = killPanel([task("bg-1")], { confirm: false });
		list.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
	});

	it("the first x arms the row: error bar, error surface and the prompt in place of the key line", () => {
		const { list } = killPanel([task("bg-1"), task("bg-2")], { panelTheme: marking });
		expect(list.render(100)[2]).toMatch(/^\[selectedBg\]<accent>▎ bg-1/);
		list.handleInput("x");
		const lines = list.render(100);
		expect(lines[2]).toMatch(/^\[toolErrorBg\]<error>▎ bg-1/);
		expect(lines.at(-1)).toBe("<error>press x again to kill · any other key cancels");
	});

	it("armed: ↓ cancels and moves; Esc, Enter and q only cancel", () => {
		const { list, killed, opened, closed } = killPanel([task("bg-1"), task("bg-2")]);
		list.handleInput("x");
		list.handleInput(DOWN);
		expect(list.render(100)[3]).toMatch(/▎ bg-2/);
		list.handleInput("x");
		expect(killed).toEqual([]);
		for (const key of [ESC, ENTER, "q"]) {
			list.handleInput(key);
			list.handleInput("x");
		}
		expect(closed()).toBe(0);
		expect(opened).toEqual([]);
		expect(killed).toEqual([]);
		list.handleInput("x");
		expect(killed).toEqual(["bg-2"]);
	});

	it("a task being killed shows killing and x does not arm it; an exit drops the arm", () => {
		const tasks = [task("bg-1"), task("bg-2")];
		const { list, killed } = killPanel(tasks);
		list.handleInput("x");
		list.handleInput("x");
		expect(list.render(100)[2]).toMatch(/▎ bg-1 +killing/);
		list.handleInput("x");
		list.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
		list.handleInput(DOWN);
		list.handleInput("x");
		tasks[1] = task("bg-2", { status: "completed", exitCode: 0, endedAt: 10 });
		expect(list.render(100).at(-1)).toContain("x kill · esc close");
		list.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
	});

	it("marks the selected row with a bar and the selection surface, and the surface fills the line", () => {
		const tasks = [task("bg-1"), task("bg-2")];
		const source: PanelSource = { list: () => tasks, kill: () => {} };
		const list = new TaskPanel({ requestRender: () => {}, terminal: { rows: 30 } }, theme, keybindings, source, () => {}, () => {});
		open.push(list);
		const row = list.render(80)[2] ?? "";
		expect(row.startsWith(`${SELECTED_BG}▎ bg-1`)).toBe(true);
		expect(visibleWidth(row)).toBe(80);
		// The other rows stay on the terminal background.
		expect(list.render(80)[3]).not.toContain(SELECTED_BG);
	});

	it("steps dim text up to muted on the selected row; a killed status keeps its warning color", () => {
		const colorTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as unknown as Theme;
		const tasks = [task("bg-1", { status: "killed", endedAt: 1000 }), task("bg-2", { status: "killed", endedAt: 1000 })];
		const list = new TaskPanel({ requestRender: () => {}, terminal: { rows: 30 } }, colorTheme, keybindings, { list: () => tasks, kill: () => {} }, () => {}, () => {});
		open.push(list);
		const [selected, other] = list.render(120).slice(2, 4);
		// design_style.md §3: killed did not finish but did not fail.
		expect(selected).toContain("<warning>killed   </warning>");
		expect(selected).not.toContain("<dim>");
		expect(selected).toContain("<muted>");
		expect(other).toContain("<warning>killed   </warning>");
		expect(other).toContain("<dim>");
	});

	it("draws a running task in accent", () => {
		const colorTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as unknown as Theme;
		const list = new TaskPanel({ requestRender: () => {}, terminal: { rows: 30 } }, colorTheme, keybindings, { list: () => [task("bg-1")], kill: () => {} }, () => {}, () => {});
		open.push(list);
		expect(list.render(120)[2]).toContain("<accent>running  </accent>");
	});

	it("windows a long list around the selection, with the hidden counts above and below", () => {
		const tasks = Array.from({ length: 25 }, (_, i) => task(`bg-${i + 1}`));
		// 30 rows: at most 10 tasks at once.
		const list = new TaskPanel({ requestRender: () => {}, terminal: { rows: 30 } }, theme, keybindings, { list: () => tasks, kill: () => {} }, () => {}, () => {});
		open.push(list);
		const rows = () => list.render(80).filter((line) => /bg-\d+ /.test(line));
		let lines = list.render(80);
		expect(rows()).toHaveLength(10);
		expect(lines.some((line) => /↑ \d+ more/.test(line))).toBe(false);
		expect(lines).toContain("  ↓ 15 more");
		for (let i = 0; i < 12; i++) list.handleInput(DOWN);
		lines = list.render(80);
		expect(rows()).toHaveLength(10);
		// bg-13 roughly centred: tasks 8-17 shown.
		expect(lines).toContain("  ↑ 7 more");
		expect(lines).toContain("  ↓ 8 more");
		// The selection stays in view.
		expect(lines.find((line) => line.includes(SELECTED_BG))).toContain("bg-13");
	});

	it("describes tasks for modes without a TUI", () => {
		expect(describeTasks([])).toBe("No background tasks in this session.");
		expect(describeTasks([task("bg-1", { startedAt: 0 })], 61_000)).toBe("bg-1  running  1m01s  echo bg-1");
	});
});
