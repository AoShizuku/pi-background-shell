import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupOldOutputs, OUTPUT_RETENTION_MS } from "./cleanup.js";

let root: string;

function file(session: string, name: string, ageMs: number): string {
	const dir = join(root, session);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "x");
	const time = new Date(Date.now() - ageMs);
	utimesSync(path, time, time);
	return path;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-bg-cleanup-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("cleanupOldOutputs", () => {
	it("removes old output files, keeps recent ones and the current session", async () => {
		const old = file("s1", "bg-1.output", OUTPUT_RETENTION_MS + 60_000);
		const recent = file("s1", "bg-2.output", 60_000);
		const current = file("now", "bg-1.output", OUTPUT_RETENTION_MS + 60_000);
		const other = file("s1", "notes.txt", OUTPUT_RETENTION_MS + 60_000);

		expect(await cleanupOldOutputs(root, "now")).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(current)).toBe(true);
		expect(existsSync(other)).toBe(true);
	});

	it("removes session directories left empty", async () => {
		file("s2", "bg-1.output", OUTPUT_RETENTION_MS + 60_000);
		await cleanupOldOutputs(root, "now");
		expect(existsSync(join(root, "s2"))).toBe(false);
	});

	it("ignores a missing root", async () => {
		expect(await cleanupOldOutputs(join(root, "missing"), "now")).toBe(0);
	});
});
