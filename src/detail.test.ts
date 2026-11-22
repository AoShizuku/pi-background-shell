import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { cachedTail, type OutputTail, readTail, ScrollState, TaskDetailView } from "./detail.js";
import type { BgTask } from "./task.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const KEYS: Record<string, string> = { "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r" };
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data } as unknown as KeybindingsManager;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const HOME = "\x1b[H";
const END = "\x1b[F";

function task(overrides: Partial<BgTask> = {}): BgTask {
	return {
		taskId: "bg-1",
		command: "npm run dev",
		status: "running",
		startedAt: Date.now() - 5000,
		outputPath: "/tmp/bg-1.log",
		notified: false,
		...overrides,
	};
}

function numbered(count: number): OutputTail {
	return { lines: Array.from({ length: count }, (_, i) => `line ${i + 1}`), truncated: false };
}

/** The text inside the box frame, one entry per row. */
function rows(lines: string[]): string[] {
	return lines.slice(1, -1).map((line) => line.slice(2, -2).trimEnd());
}

function outputRows(lines: string[]): string[] {
	return rows(lines).filter((line) => line.startsWith("line "));
}

describe("TaskDetailView", () => {
	const views: TaskDetailView[] = [];
	afterEach(() => {
		for (const view of views.splice(0)) view.dispose();
	});

	function view(options: { rec?: BgTask; rows?: number; output?: OutputTail; confirm?: boolean } = {}) {
		const rec = options.rec ?? task();
		const killed: string[] = [];
		let closed = 0;
		let renders = 0;
		const state = { output: options.output ?? numbered(100) };
		const host = { requestRender: () => renders++, terminal: { rows: options.rows ?? 30 } };
		const v = new TaskDetailView(
			host,
			theme,
			keybindings,
			{
				get: (id) => (id === rec.taskId ? rec : undefined),
				kill: (id) => killed.push(id),
				// A kill was requested: the process is still exiting.
				canKill: (id) => !killed.includes(id),
				confirmKill: () => options.confirm ?? true,
			},
			rec.taskId,
			() => closed++,
			() => state.output,
		);
		views.push(v);
		return { v, killed, state, closed: () => closed, renders: () => renders };
	}

	it("is a framed box 80% of the terminal tall, whatever the output length", () => {
		for (const [count, termRows] of [
			[2, 30],
			[100, 30],
			[5000, 30],
			[100, 50],
			[100, 13],
		] as const) {
			const { v } = view({ rows: termRows, output: numbered(count) });
			const lines = v.render(70);
			expect(lines.length).toBeLessThanOrEqual(Math.floor(termRows * 0.8));
			expect(lines).toHaveLength(Math.floor(termRows * 0.8));
			for (const line of lines) expect(visibleWidth(line)).toBe(70);
		}
		const lines = view().v.render(70);
		expect(lines[0]).toMatch(/^╭─ Shell details · bg-1 ─+╮$/);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		expect(rows(lines)).toContain("Command  npm run dev");
		expect(rows(lines)).toContain("Output   /tmp/bg-1.log");
		expect(rows(lines).at(-1)).toContain("x kill · esc close");
	});

	it("keeps the header on a short terminal until the output needs the room", () => {
		const { v } = view({ rows: 10, output: numbered(100) });
		const lines = v.render(70);
		expect(lines).toHaveLength(8);
		expect(outputRows(lines)).toHaveLength(3);
		expect(rows(lines)[0]).toMatch(/^Status/);
	});

	it("opens at the bottom and stays pinned while output grows", () => {
		const { v, state } = view();
		expect(outputRows(v.render(70)).at(-1)).toBe("line 100");
		state.output = numbered(120);
		expect(outputRows(v.render(70)).at(-1)).toBe("line 120");
	});

	it("stops following after scrolling up and resumes with End or at the bottom", () => {
		const { v, state } = view();
		v.render(70);
		v.handleInput(UP);
		let lines = v.render(70);
		expect(outputRows(lines).at(-1)).toBe("line 99");
		expect(rows(lines).at(-1)).toMatch(/^paused at 99\/100 · end to follow/);

		state.output = numbered(150);
		expect(outputRows(v.render(70)).at(-1)).toBe("line 99");

		v.handleInput(END);
		lines = v.render(70);
		expect(outputRows(lines).at(-1)).toBe("line 150");
		expect(rows(lines).at(-1)).not.toContain("paused");
		state.output = numbered(160);
		expect(outputRows(v.render(70)).at(-1)).toBe("line 160");

		// Scrolling back down to the bottom follows again.
		v.handleInput(UP);
		v.handleInput(UP);
		v.render(70);
		v.handleInput(DOWN);
		v.handleInput(DOWN);
		state.output = numbered(170);
		expect(outputRows(v.render(70)).at(-1)).toBe("line 170");
	});

	it("scrolls with page keys, Home and the wheel", () => {
		const { v } = view();
		const viewport = outputRows(v.render(70)).length;
		v.handleInput(PAGE_UP);
		expect(outputRows(v.render(70)).at(-1)).toBe(`line ${100 - (viewport - 1)}`);
		v.handleInput(HOME);
		expect(outputRows(v.render(70))[0]).toBe("line 1");
		expect(v.handleMouse({ type: "wheel", wheelDelta: 3 } as never)).toEqual({ handled: true });
		expect(outputRows(v.render(70))[0]).toBe("line 4");
		v.handleInput(END);
		v.render(70);
		v.handleMouse({ type: "wheel", wheelDelta: -3 } as never);
		expect(outputRows(v.render(70)).at(-1)).toBe("line 97");
		expect(v.handleMouse({ type: "click", button: "left" } as never)).toBeUndefined();
	});

	it("keeps following when the output fits", () => {
		const { v, state } = view({ output: numbered(3) });
		v.render(70);
		v.handleInput(UP);
		expect(rows(v.render(70)).at(-1)).not.toContain("paused");
		state.output = numbered(100);
		expect(outputRows(v.render(70)).at(-1)).toBe("line 100");
	});

	it("wraps long lines and marks omitted earlier output", () => {
		const { v } = view({ output: { lines: ["x".repeat(130)], truncated: true } });
		const body = rows(v.render(70));
		expect(body).toContain("… earlier output not shown; full log: /tmp/bg-1.log");
		expect(body.filter((line) => /^x+$/.test(line)).map((line) => line.length)).toEqual([66, 64]);
		expect(rows(view({ output: { lines: [], truncated: false } }).v.render(70))).toContain("(no output yet)");
	});

	it("x x kills a running task; nothing for a finished one", () => {
		const running = view();
		running.v.handleInput("x");
		expect(running.killed).toEqual([]);
		running.v.handleInput("x");
		expect(running.killed).toEqual(["bg-1"]);
		const finished = view({ rec: task({ status: "completed", exitCode: 0, endedAt: Date.now() }) });
		finished.v.handleInput("x");
		finished.v.handleInput("x");
		expect(finished.killed).toEqual([]);
		expect(rows(finished.v.render(70)).at(-1)).not.toContain("x kill");
	});

	it("with confirmKill off, one x kills", () => {
		const { v, killed } = view({ confirm: false });
		v.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
	});

	it("the first x swaps the key line for the prompt; Esc then only cancels, scroll keys cancel and scroll", () => {
		const { v, killed, closed } = view();
		v.handleInput("x");
		expect(rows(v.render(70)).at(-1)).toContain("press x again to kill · any other key cancels");
		v.handleInput("\x1b");
		expect(closed()).toBe(0);
		expect(rows(v.render(70)).at(-1)).toContain("x kill · esc close");
		v.handleInput("x");
		v.handleInput("\x1b[A");
		expect(rows(v.render(70)).at(-1)).toContain("paused at");
		v.handleInput("x");
		v.handleMouse({ type: "wheel", wheelDelta: -1 } as never);
		expect(rows(v.render(70)).at(-1)).not.toContain("press x again");
		expect(killed).toEqual([]);
	});

	it("after the second x the status says killing until the process exits, and x does nothing", () => {
		const rec = task();
		const { v, killed } = view({ rec });
		v.handleInput("x");
		v.handleInput("x");
		const lines = rows(v.render(70));
		expect(lines[0]).toContain("Status   killing");
		expect(lines.at(-1)).not.toContain("x kill");
		v.handleInput("x");
		v.handleInput("x");
		expect(killed).toEqual(["bg-1"]);
	});

	it("the arm is dropped when the task exits on its own", () => {
		const rec = task();
		const { v, killed } = view({ rec });
		v.handleInput("x");
		rec.status = "completed";
		rec.endedAt = Date.now();
		expect(rows(v.render(70)).at(-1)).not.toContain("press x again");
		v.handleInput("x");
		expect(killed).toEqual([]);
	});

	it("esc and q close the overlay once", () => {
		const a = view();
		a.v.handleInput("\x1b");
		a.v.handleInput("\x1b");
		expect(a.closed()).toBe(1);
		const b = view();
		b.v.handleInput("q");
		expect(b.closed()).toBe(1);
	});
});

describe("ScrollState", () => {
	it("follows the end until the user scrolls up, and again after scrolling back down", () => {
		const scroll = new ScrollState(true);
		expect(scroll.layout(30, 10)).toBe(20);
		expect(scroll.layout(35, 10)).toBe(25);
		scroll.scrollBy(-3);
		expect(scroll.following).toBe(false);
		expect(scroll.layout(40, 10)).toBe(22);
		scroll.page(1);
		expect(scroll.layout(40, 10)).toBe(30);
		scroll.scrollBy(1);
		expect(scroll.following).toBe(true);
		expect(scroll.layout(50, 10)).toBe(40);
		scroll.toStart();
		expect(scroll.layout(50, 10)).toBe(0);
		scroll.toEnd();
		expect(scroll.layout(60, 10)).toBe(50);
	});
});

describe("readTail", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("strips escapes, drops the partial first line of a cut read and caps the line count", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-bg-tail-"));
		const file = join(dir, "out.log");
		writeFileSync(file, "\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07a\tb\x07\n\n");
		expect(readTail(file)).toEqual({ lines: ["red", "a    b"], truncated: false });

		writeFileSync(file, `${"0123456789".repeat(10)}\nkeep 1\nkeep 2\n`);
		expect(readTail(file, 20)).toEqual({ lines: ["keep 1", "keep 2"], truncated: true });
		expect(readTail(file, 1000, 1)).toEqual({ lines: ["keep 2"], truncated: true });
		expect(readTail(join(dir, "missing.log"))).toEqual({ lines: [], truncated: false });
	});

	it("re-reads only when the file changed", () => {
		let reads = 0;
		let key = "1";
		const tail = cachedTail(
			() => {
				reads++;
				return numbered(reads);
			},
			() => key,
		);
		const first = tail("a.log");
		expect(tail("a.log")).toBe(first);
		expect(reads).toBe(1);
		key = "2";
		expect(tail("a.log").lines).toHaveLength(2);
		tail("b.log");
		expect(reads).toBe(3);
	});
});
