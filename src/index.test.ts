import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piBackgroundShell, { OPEN_CHANNEL, STATE_CHANNEL, STATE_REQUEST_CHANNEL } from "./index.js";
import { testShell, waitFor } from "./test-shell.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Sent {
	message: { customType: string; content: string; details: { tasks: Array<{ taskId: string; status: string }> } };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

interface ToolLike {
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }>;
}

let dir: string;

function harness(mode = "tui") {
	let activeTools = ["read", "bash", "bash_background", "bg_kill"];
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	const sent: Sent[] = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const states: number[] = [];
	const statuses: Array<string | undefined> = [];
	const state = { idle: true };
	// Each open panel; calling an entry closes that panel.
	const panels: Array<() => void> = [];

	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool: (tool: ToolLike & { name: string }) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: Sent["message"], options: Sent["options"]) => sent.push({ message, options }),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		getSettings: () => ({ shellPath: testShell().shell }),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler));
			},
			emit: (channel: string, data: unknown) => {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: dir,
		hasUI: mode !== "print",
		mode,
		isIdle: () => state.idle,
		ui: {
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			custom: () => new Promise<void>((resolve) => panels.push(resolve)),
		},
		sessionManager: {
			getSessionDir: () => join(dir, "sessions"),
			getSessionId: () => "session-1",
			getEntries: () => [],
		},
	};

	piBackgroundShell(pi);
	pi.events.on(STATE_CHANNEL, (data) => states.push((data as { running: number }).running));

	const emit = (event: string, payload: unknown = {}) => (handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
	const tool = (name: string) => {
		const found = tools.get(name);
		if (!found) throw new Error(`tool ${name} not registered`);
		return found;
	};
	const run = async (command: string) => {
		const result = await tool("bash_background").execute("call", { command }, undefined, undefined, ctx);
		return /task_id: (bg-\d+)/.exec(result.content[0]?.text ?? "")?.[1] ?? "";
	};

	emit("session_start", { reason: "startup" });
	return { emit, tool, run, sent, appended, states, statuses, state, ctx, pi, panels, activeTools: () => activeTools };
}

let current: ReturnType<typeof harness> | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-bg-index-"));
});

afterEach(async () => {
	current?.emit("session_shutdown", { reason: "quit" });
	current = undefined;
	// Killed shells hold the directory as cwd until taskkill lands (about a second on Windows).
	await new Promise((resolve) => setTimeout(resolve, 1500));
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe("pi-background-shell", () => {
	it("wakes an idle agent once for tasks finishing together", async () => {
		const h = (current = harness());
		await h.run("sleep 0.3; echo a");
		await h.run("sleep 0.6; echo b");
		await waitFor(() => h.sent.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect(h.sent).toHaveLength(1);
		const [first] = h.sent;
		expect(first?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(first?.message.details.tasks.map((task) => task.taskId)).toEqual(["bg-1", "bg-2"]);
		expect(first?.message.content).toContain("<output-file>");
		expect(first?.message.content).not.toMatch(/^a$/m);
	});

	it("holds notifications while busy and drains them as one entry at turn_end", async () => {
		const h = (current = harness());
		h.state.idle = false;
		await h.run("echo a");
		await h.run("echo b");
		await waitFor(() => h.appended.filter((entry) => (entry.data as { status: string }).status !== "running").length === 2);
		expect(h.sent).toEqual([]);

		const [result] = h.emit("turn_end", { outcome: "completed", entries: [] }) as Array<{ entries: Array<{ type: string; content: string }>; continue: boolean }>;
		expect(result?.continue).toBe(true);
		expect(result?.entries).toHaveLength(1);
		expect(result?.entries[0]?.type).toBe("custom_message");
		expect(result?.entries[0]?.content.match(/<task>/g)).toHaveLength(2);

		// Nothing left for the next boundary.
		expect(h.emit("turn_end", { outcome: "completed", entries: [] })).toEqual([undefined]);
	});

	it("records but does not restart an aborted run", async () => {
		const h = (current = harness());
		h.state.idle = false;
		await h.run("echo a");
		await waitFor(() => h.appended.length === 2);
		h.state.idle = true;
		h.emit("agent_settled", { aborted: true });
		expect(h.sent.map((s) => s.options.triggerTurn)).toEqual([false]);
	});

	it("does not notify for a task stopped with bg_kill", async () => {
		const h = (current = harness());
		const taskId = await h.run("sleep 30");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const result = await h.tool("bg_kill").execute("call", { task_id: taskId }, undefined, undefined, h.ctx);
		expect(result.content[0]?.text).toContain(`Stopped ${taskId}`);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		expect(h.sent).toEqual([]);
	});

	it("keeps the tools active interactively and disables them in print mode", () => {
		expect((current = harness("tui")).activeTools()).toContain("bash_background");
		current.emit("session_shutdown", { reason: "quit" });
		const h = (current = harness("print"));
		expect(h.activeTools()).toEqual(["read", "bash"]);
	});

	it("publishes the running count for pi-hud and re-sends it on request", async () => {
		const h = (current = harness());
		await h.run("sleep 30");
		// Let the shell spawn sleep first: taskkill /T misses a child created while it walks the tree.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(h.states.at(-1)).toBe(1);
		expect(h.statuses.at(-1)).toBe("1 shell");
		h.pi.events.emit(STATE_REQUEST_CHANNEL, undefined);
		expect(h.states.at(-1)).toBe(1);
		h.emit("session_shutdown", { reason: "quit" });
		current = undefined;
		expect(h.states.at(-1)).toBe(0);
	});

	it("opens the /background list on request (a click on pi-hud), once at a time", async () => {
		const h = (current = harness());
		h.pi.events.emit(OPEN_CHANNEL, undefined);
		h.pi.events.emit(OPEN_CHANNEL, undefined);
		expect(h.panels).toHaveLength(1);
		h.panels[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		h.pi.events.emit(OPEN_CHANNEL, undefined);
		expect(h.panels).toHaveLength(2);
	});

	it("ignores open requests without a TUI and after the session ends", () => {
		const print = harness("print");
		print.pi.events.emit(OPEN_CHANNEL, undefined);
		expect(print.panels).toHaveLength(0);
		print.emit("session_shutdown", { reason: "quit" });
		const h = (current = harness());
		h.emit("session_shutdown", { reason: "quit" });
		current = undefined;
		h.pi.events.emit(OPEN_CHANNEL, undefined);
		expect(h.panels).toHaveLength(0);
	});
});
