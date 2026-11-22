// Spawning a background shell process with output going straight to a file, and killing its tree.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/** Everything needed to kill one task's process tree. */
export interface KillTarget {
	/** OS pid of the spawned shell. */
	pid: number | undefined;
	/**
	 * Windows only: the shell writes its own (MSYS/Cygwin) pid here. It is also its process group,
	 * which reaches MSYS children that are invisible to taskkill /T.
	 */
	groupPidFile?: string;
	shell: string;
}

export interface SpawnedTask {
	child: ChildProcess;
	target: KillTarget;
}

const isWindows = process.platform === "win32";

/**
 * Start `command` in the background. stdout and stderr are bound to `outputPath` at the OS level,
 * so the process never waits on a Node pipe.
 */
export function spawnBackground(command: string, cwd: string, shell: ShellConfig, outputPath: string): SpawnedTask {
	// Not "a": on Windows an append-only handle lacks FILE_WRITE_DATA and MSYS programs (Git Bash) fail to write to it.
	const fd = openSync(outputPath, "w");
	const viaStdin = shell.commandTransport === "stdin";
	// Git Bash starts MSYS programs (sleep, tail, a forked subshell) through helper processes that
	// exit at once, so taskkill /T cannot see them. Record the shell's MSYS pid to kill its group.
	const groupPidFile = isWindows && !viaStdin ? outputPath.replace(/\.output$/, "") + ".pid" : undefined;
	const script = groupPidFile ? `printf '%s' "$$" > ${shellQuote(toPosixPath(groupPidFile))}\n${command}` : command;
	try {
		const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, script], {
			cwd,
			// POSIX: own process group, so the whole tree can be signalled with -pid.
			// Windows: taskkill /T walks the tree; detached would only add a console.
			detached: !isWindows,
			env: process.env,
			stdio: [viaStdin ? "pipe" : "ignore", fd, fd],
			windowsHide: true,
		});
		if (viaStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		// The task must not keep pi alive; exit events still arrive while pi runs.
		child.unref();
		return { child, target: { pid: child.pid, groupPidFile, shell: shell.shell } };
	} finally {
		// The child holds its own copy of the descriptor.
		closeSync(fd);
	}
}

const KILL_GRACE_MS = 2000;

/** Kill a process tree: SIGTERM then SIGKILL on POSIX; MSYS group kill plus taskkill /T on Windows. */
export function killTree(target: KillTarget): void {
	if (isWindows) {
		// Detached and unref'd: pi may exit right after session_shutdown, and the killers must outlive it.
		const group = readGroupPid(target);
		if (group !== undefined) startDetached(target.shell, ["-c", `kill -9 -- -${group} 2>/dev/null`]);
		if (target.pid !== undefined) startDetached(taskkillPath(), ["/F", "/T", "/PID", String(target.pid)]);
		return;
	}
	const pid = target.pid;
	if (pid === undefined || !signalGroup(pid, "SIGTERM")) return;
	setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
}

/** Synchronous kill of several trees for `process.on("exit")`, where async work never runs. */
export function killTreesSync(targets: readonly KillTarget[]): void {
	if (targets.length === 0) return;
	if (!isWindows) {
		for (const target of targets) if (target.pid !== undefined) signalGroup(target.pid, "SIGKILL");
		return;
	}
	const groups = new Map<string, number[]>();
	for (const target of targets) {
		const group = readGroupPid(target);
		if (group !== undefined) groups.set(target.shell, [...(groups.get(target.shell) ?? []), group]);
	}
	for (const [shell, pids] of groups) {
		spawnSync(shell, ["-c", `kill -9 -- ${pids.map((pid) => `-${pid}`).join(" ")} 2>/dev/null`], { stdio: "ignore", windowsHide: true });
	}
	const pids = targets.flatMap((target) => (target.pid === undefined ? [] : ["/PID", String(target.pid)]));
	if (pids.length > 0) spawnSync(taskkillPath(), ["/F", "/T", ...pids], { stdio: "ignore", windowsHide: true });
}

function startDetached(command: string, args: string[]): void {
	const child = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: true });
	child.once("error", () => {});
	child.unref();
}

function readGroupPid(target: KillTarget): number | undefined {
	if (!target.groupPidFile) return undefined;
	try {
		const pid = Number.parseInt(readFileSync(target.groupPidFile, "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 1 ? pid : undefined;
	} catch {
		// The shell had not started yet; taskkill still covers it.
		return undefined;
	}
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

function taskkillPath(): string {
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

function toPosixPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}
