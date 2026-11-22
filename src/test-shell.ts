// Test helper: locate a bash for spawning real background processes.

import { existsSync } from "node:fs";

import type { ShellConfig } from "./process.js";

/** Git Bash on Windows, /bin/bash elsewhere. */
export function testShell(): ShellConfig {
	if (process.platform === "win32") {
		const candidates = [`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`, `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`];
		const found = candidates.find((path) => existsSync(path));
		if (!found) throw new Error("tests need Git Bash on Windows");
		return { shell: found, args: ["-c"] };
	}
	return { shell: "/bin/bash", args: ["-c"] };
}

/** Resolve once `check` returns true, polling every 25ms, or reject after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
