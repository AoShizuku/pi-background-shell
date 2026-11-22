// Task registry and lifecycle: start, timeout, output cap, kill, exit, restore.

import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { constants as osConstants } from "node:os";

import { type KillTarget, killTree, killTreesSync, type ShellConfig, spawnBackground } from "./process.js";
import type { BgTask, BgTaskEntry, KillReason } from "./task.js";

export interface ManagerOptions {
	/** Directory holding this session's `<taskId>.output` files. */
	outputDir: string;
	resolveShell(): ShellConfig;
	/** Called on every task state change, for persistence. */
	persist(task: BgTask): void;
	/** Called once when a task ends and the model should hear about it. */
	onFinished(task: BgTask): void;
	/** Called whenever the set of running tasks may have changed. */
	onChange(): void;
	maxRunning?: number;
	outputLimitBytes?: number;
	/** How often output files are checked against the size cap. */
	outputCheckMs?: number;
}

export interface StartRequest {
	command: string;
	cwd: string;
	description?: string;
	/** Seconds. */
	timeout?: number;
}

interface Runtime {
	child: ChildProcess;
	target: KillTarget;
	killReason?: KillReason;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	exited: Promise<void>;
	resolveExited(): void;
}

export const DEFAULT_MAX_RUNNING = 8;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_OUTPUT_CHECK_MS = 2000;
const KILL_WAIT_MS = 5000;
const MAX_TIMEOUT_SECONDS = 2_147_483;

const KILL_REASON_TEXT: Record<KillReason, string> = {
	model: "stopped with bg_kill",
	user: "stopped by the user",
	timeout: "timeout reached",
	output_limit: "output exceeded the size limit",
	session_end: "session ended",
};

/** Owns every background task of one session. */
export class TaskManager {
	private readonly options: ManagerOptions;
	private readonly tasks = new Map<string, BgTask>();
	private readonly runtimes = new Map<string, Runtime>();
	private nextId = 1;
	private outputTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: ManagerOptions) {
		this.options = options;
	}

	/** All tasks, oldest first. */
	list(): BgTask[] {
		return [...this.tasks.values()];
	}

	/** Look up a task by id. */
	get(taskId: string): BgTask | undefined {
		return this.tasks.get(taskId);
	}

	/** Number of tasks still running. */
	runningCount(): number {
		return this.runtimes.size;
	}

	/**
	 * Running and no kill requested yet. A killed task stays `running` until the process exits (taskkill takes
	 * about a second on Windows); the /background panel shows it as stopping and does not offer x again.
	 */
	canKill(taskId: string): boolean {
		const runtime = this.runtimes.get(taskId);
		return runtime !== undefined && runtime.killReason === undefined && this.tasks.get(taskId)?.status === "running";
	}

	/**
	 * Rebuild the registry from persisted entries (last entry per task wins). Processes of an earlier
	 * pi run are gone, so tasks still marked running are closed as killed; those are returned for re-persisting.
	 */
	restore(entries: readonly BgTaskEntry[]): BgTask[] {
		const latest = new Map<string, BgTaskEntry>();
		for (const entry of entries) latest.set(entry.taskId, entry);

		const closed: BgTask[] = [];
		for (const entry of latest.values()) {
			const task: BgTask = { ...entry, notified: true };
			if (task.status === "running") {
				task.status = "killed";
				task.reason = KILL_REASON_TEXT.session_end;
				task.pid = undefined;
				closed.push(task);
			}
			this.tasks.set(task.taskId, task);
			const n = Number(/^bg-(\d+)$/.exec(task.taskId)?.[1]);
			if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
		}
		return closed;
	}

	/** Spawn a task and return immediately. Throws when the request is invalid or the running limit is hit. */
	start(request: StartRequest): BgTask {
		const command = request.command.trim();
		if (!command) throw new Error("command must not be empty");
		// spawn() reports a missing cwd as a misleading "spawn <shell> ENOENT".
		if (!existsSync(request.cwd)) throw new Error(`Working directory does not exist: ${request.cwd}`);
		const timeout = request.timeout;
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
			throw new Error(`timeout must be a positive number of seconds (at most ${MAX_TIMEOUT_SECONDS})`);
		}
		const maxRunning = this.options.maxRunning ?? DEFAULT_MAX_RUNNING;
		if (this.runtimes.size >= maxRunning) {
			const running = [...this.runtimes.keys()].join(", ");
			throw new Error(
				`Too many background tasks running (${this.runtimes.size}/${maxRunning}: ${running}). Stop one with bg_kill or wait for one to finish.`,
			);
		}

		mkdirSync(this.options.outputDir, { recursive: true });
		const taskId = `bg-${this.nextId++}`;
		const outputPath = join(this.options.outputDir, `${taskId}.output`);
		const { child, target } = spawnBackground(command, request.cwd, this.options.resolveShell(), outputPath);

		const description = request.description?.trim() || undefined;
		const task: BgTask = { taskId, command, description, status: "running", startedAt: Date.now(), outputPath, pid: target.pid, notified: false };
		this.tasks.set(taskId, task);

		let resolveExited = () => {};
		const exited = new Promise<void>((resolve) => {
			resolveExited = resolve;
		});
		const runtime: Runtime = { child, target, exited, resolveExited };
		this.runtimes.set(taskId, runtime);

		child.once("exit", (code, signal) => this.finish(taskId, { code, signal }));
		child.once("error", (error) => this.finish(taskId, { error }));
		if (timeout !== undefined) {
			runtime.timeoutTimer = setTimeout(() => this.requestKill(taskId, "timeout"), timeout * 1000);
		}
		this.ensureOutputWatch();

		this.options.persist(task);
		this.options.onChange();
		return task;
	}

	/** Kill a running task and wait (bounded) for it to exit. Returns the task, or undefined if unknown. */
	async kill(taskId: string, reason: KillReason): Promise<BgTask | undefined> {
		const task = this.tasks.get(taskId);
		if (!task) return undefined;
		const runtime = this.runtimes.get(taskId);
		if (!runtime) return task;
		this.requestKill(taskId, reason);
		await Promise.race([runtime.exited, new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS))]);
		return task;
	}

	/** Kill every running task (session end). Their ends are not reported to the model. */
	shutdown(): void {
		for (const taskId of [...this.runtimes.keys()]) this.requestKill(taskId, "session_end");
		this.stopOutputWatch();
	}

	/** Synchronous last-resort kill when the pi process is exiting. */
	killAllSync(): void {
		killTreesSync([...this.runtimes.values()].map((runtime) => runtime.target));
	}

	private requestKill(taskId: string, reason: KillReason): void {
		const runtime = this.runtimes.get(taskId);
		const task = this.tasks.get(taskId);
		// One kill per task: taskkill takes about a second on Windows, and the output watcher
		// would otherwise start a new one on every check until the first lands.
		if (!runtime || !task || runtime.killReason) return;
		runtime.killReason = reason;
		if (runtime.target.pid !== undefined) killTree(runtime.target);
		else runtime.child.kill("SIGKILL");
	}

	private finish(taskId: string, outcome: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error }): void {
		const runtime = this.runtimes.get(taskId);
		const task = this.tasks.get(taskId);
		if (!runtime || !task) return;
		this.runtimes.delete(taskId);
		if (runtime.timeoutTimer) clearTimeout(runtime.timeoutTimer);
		if (this.runtimes.size === 0) this.stopOutputWatch();

		task.endedAt = Date.now();
		const reason = runtime.killReason;
		if (reason === "timeout") {
			task.status = "timeout";
		} else if (reason) {
			task.status = "killed";
			task.reason = KILL_REASON_TEXT[reason];
		} else if (outcome.error) {
			task.status = "failed";
			task.reason = outcome.error.message;
		} else {
			const exitCode = outcome.code ?? (outcome.signal ? 128 + (osConstants.signals[outcome.signal] ?? 0) : 1);
			task.exitCode = exitCode;
			task.status = exitCode === 0 ? "completed" : "failed";
		}
		if (reason === "output_limit") appendMarker(task.outputPath, this.outputLimit());
		if (runtime.target.groupPidFile) removeQuietly(runtime.target.groupPidFile);
		// The model asked for this kill itself, or nobody is left to tell.
		if (reason === "model" || reason === "session_end") task.notified = true;

		runtime.resolveExited();
		this.options.persist(task);
		this.options.onChange();
		if (!task.notified) this.options.onFinished(task);
	}

	private outputLimit(): number {
		return this.options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
	}

	// The child writes straight to the file, so the cap can only be enforced by watching its size.
	private ensureOutputWatch(): void {
		if (this.outputTimer) return;
		this.outputTimer = setInterval(() => this.checkOutputSizes(), this.options.outputCheckMs ?? DEFAULT_OUTPUT_CHECK_MS);
		this.outputTimer.unref();
	}

	private stopOutputWatch(): void {
		if (this.outputTimer) clearInterval(this.outputTimer);
		this.outputTimer = undefined;
	}

	private checkOutputSizes(): void {
		const limit = this.outputLimit();
		for (const taskId of this.runtimes.keys()) {
			const task = this.tasks.get(taskId);
			if (!task) continue;
			try {
				if (statSync(task.outputPath).size > limit) this.requestKill(taskId, "output_limit");
			} catch {
				// The file may be gone (deleted by the user); nothing to cap.
			}
		}
	}
}

function appendMarker(outputPath: string, limit: number): void {
	try {
		appendFileSync(outputPath, `\n[output truncated: exceeded ${formatBytes(limit)}, task killed]\n`);
	} catch {
		// Best effort; the status already says why the task ended.
	}
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// A locked leftover is removed by the startup cleanup later.
	}
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))}MB` : `${bytes} bytes`;
}
