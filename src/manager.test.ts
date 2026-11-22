import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ManagerOptions, TaskManager } from "./manager.js";
import type { BgTask } from "./task.js";
import { testShell, waitFor } from "./test-shell.js";

let dir: string;
let manager: TaskManager;
let finished: BgTask[];
let persisted: BgTask[];

function create(overrides: Partial<ManagerOptions> = {}): TaskManager {
	finished = [];
	persisted = [];
	manager = new TaskManager({
		outputDir: join(dir, "out"),
		resolveShell: testShell,
		persist: (task) => persisted.push({ ...task }),
		onFinished: (task) => finished.push(task),
		onChange: () => {},
		...overrides,
	});
	return manager;
}

// Let the shell start its children (and on Windows write its MSYS pid) before killing.
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

function countWindowsProcesses(marker: string): number {
	const query = `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -ne 'bash.exe' -and $_.Name -notlike 'powershell*' }).Count`;
	return Number(spawnSync("powershell", ["-NoProfile", "-Command", query], { encoding: "utf8" }).stdout.trim());
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
});

afterEach(async () => {
	manager?.shutdown();
	await waitFor(() => manager.runningCount() === 0).catch(() => {});
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("TaskManager lifecycle", () => {
	it("runs a command, writes its output to the file and reports completion once", async () => {
		const m = create();
		const task = m.start({ command: "echo hello; echo oops >&2", cwd: dir });
		expect(task.taskId).toBe("bg-1");
		expect(task.status).toBe("running");
		await waitFor(() => finished.length === 1);
		expect(task.status).toBe("completed");
		expect(task.exitCode).toBe(0);
		expect(readFileSync(task.outputPath, "utf8")).toMatch(/hello\s+oops/);
		expect(persisted.map((t) => t.status)).toEqual(["running", "completed"]);
	});

	it("reports a non-zero exit as failed", async () => {
		const m = create();
		m.start({ command: "exit 3", cwd: dir });
		await waitFor(() => finished.length === 1);
		expect(finished[0]?.status).toBe("failed");
		expect(finished[0]?.exitCode).toBe(3);
	});

	it("kills a task at its timeout", async () => {
		const m = create();
		m.start({ command: "sleep 30", cwd: dir, timeout: 0.3 });
		await waitFor(() => finished.length === 1);
		expect(finished[0]?.status).toBe("timeout");
	});

	it("does not report a task the model killed itself", async () => {
		const m = create();
		const task = m.start({ command: "sleep 30", cwd: dir });
		await settle();
		const result = await m.kill(task.taskId, "model");
		expect(result?.status).toBe("killed");
		expect(result?.reason).toBe("stopped with bg_kill");
		expect(finished).toEqual([]);
		expect(m.runningCount()).toBe(0);
	});

	it("reports a task the user killed", async () => {
		const m = create();
		const task = m.start({ command: "sleep 30", cwd: dir });
		await settle();
		expect(m.canKill(task.taskId)).toBe(true);
		const killing = m.kill(task.taskId, "user");
		// From the request on, even while the process is still exiting, it cannot be killed again.
		expect(m.canKill(task.taskId)).toBe(false);
		await killing;
		expect(m.canKill(task.taskId)).toBe(false);
		expect(m.canKill("bg-99")).toBe(false);
		expect(finished.map((t) => t.reason)).toEqual(["stopped by the user"]);
	});

	it("kills the whole process tree, not just the shell", async () => {
		const m = create();
		const marker = join(dir, "late.txt").replace(/\\/g, "/");
		const task = m.start({ command: `(sleep 4; echo late > '${marker}') & sleep 30`, cwd: dir });
		await settle();
		await m.kill(task.taskId, "user");
		expect(task.status).toBe("killed");
		await new Promise((resolve) => setTimeout(resolve, 5000));
		expect(existsSync(marker)).toBe(false);
	});

	it.runIf(process.platform === "win32")("kills MSYS programs that taskkill /T cannot see", async () => {
		const m = create();
		// Git Bash runs sleep.exe through a helper that exits at once, detaching it from the Windows tree.
		const task = m.start({ command: "sleep 29.123; echo done", cwd: dir });
		await settle();
		expect(countWindowsProcesses("29.123")).toBe(1);
		await m.kill(task.taskId, "user");
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(countWindowsProcesses("29.123")).toBe(0);
		expect(existsSync(task.outputPath.replace(/\.output$/, ".pid"))).toBe(false);
	});

	it("rejects tasks beyond the running limit", async () => {
		const m = create({ maxRunning: 1 });
		m.start({ command: "sleep 30", cwd: dir });
		expect(() => m.start({ command: "sleep 30", cwd: dir })).toThrow(/Too many background tasks running \(1\/1: bg-1\)/);
		await settle();
	});

	it("rejects a bad timeout and a missing cwd", () => {
		const m = create();
		expect(() => m.start({ command: "true", cwd: dir, timeout: -1 })).toThrow(/timeout/);
		expect(() => m.start({ command: "true", cwd: join(dir, "nope") })).toThrow(/Working directory does not exist/);
	});

	it("kills a task whose output exceeds the cap and marks the file", async () => {
		const m = create({ outputLimitBytes: 4096, outputCheckMs: 50 });
		const task = m.start({ command: "while true; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done", cwd: dir });
		await waitFor(() => finished.length === 1);
		expect(task.status).toBe("killed");
		expect(task.reason).toBe("output exceeded the size limit");
		expect(readFileSync(task.outputPath, "utf8")).toContain("[output truncated: exceeded 4096 bytes, task killed]");
	});

	it("shutdown kills everything without reporting", async () => {
		const m = create();
		m.start({ command: "sleep 30", cwd: dir });
		m.start({ command: "sleep 30", cwd: dir });
		await settle();
		m.shutdown();
		await waitFor(() => m.runningCount() === 0);
		expect(finished).toEqual([]);
	});
});

describe("TaskManager.restore", () => {
	it("closes tasks left running by an earlier pi run and continues the numbering", () => {
		const m = create();
		const base = { command: "x", startedAt: 1, outputPath: "/o" };
		const closed = m.restore([
			{ ...base, taskId: "bg-1", status: "running" },
			{ ...base, taskId: "bg-2", status: "running" },
			{ ...base, taskId: "bg-1", status: "completed", exitCode: 0, endedAt: 2 },
		]);
		expect(closed.map((t) => t.taskId)).toEqual(["bg-2"]);
		expect(m.get("bg-2")?.status).toBe("killed");
		expect(m.get("bg-2")?.reason).toBe("session ended");
		expect(m.get("bg-1")?.status).toBe("completed");
		const next = m.start({ command: "true", cwd: dir });
		expect(next.taskId).toBe("bg-3");
	});
});
