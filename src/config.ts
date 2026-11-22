// Plugin configuration: <agent dir>/pi-background-shell.json (global only), read at session start.
// A missing or unreadable file, or a field of the wrong type, falls back to the default.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CONFIG_FILE_NAME = "pi-background-shell.json";

export interface BgConfig {
	/** x kills a task only when pressed twice on it, in the /background list and the detail overlay (DESIGN.md §3.8). */
	confirmKill: boolean;
}

export const DEFAULT_CONFIG: BgConfig = { confirmKill: true };

export function loadConfig(path: string): BgConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	return parseConfig(parsed);
}

export function parseConfig(input: unknown): BgConfig {
	const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	return { confirmKill: typeof source.confirmKill === "boolean" ? source.confirmKill : DEFAULT_CONFIG.confirmKill };
}

/**
 * Write `patch` into the file, keeping every other field already there (unknown keys included). A missing file
 * is created. Throws when the file exists but is not a JSON object (it is left alone, not overwritten) or
 * cannot be written.
 */
export function saveConfigPatch(path: string, patch: Partial<BgConfig>): BgConfig {
	let current: Record<string, unknown> = {};
	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (raw !== undefined) {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the file must contain a JSON object");
		current = parsed as Record<string, unknown>;
	}
	const next = { ...current, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}
`, "utf8");
	return parseConfig(next);
}
