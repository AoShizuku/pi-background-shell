import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, parseConfig } from "./config.js";

describe("config", () => {
	it("confirmKill defaults to on and takes only a boolean", () => {
		expect(parseConfig({})).toEqual({ confirmKill: true });
		expect(parseConfig({ confirmKill: false })).toEqual({ confirmKill: false });
		expect(parseConfig({ confirmKill: "no" })).toEqual({ confirmKill: true });
		expect(parseConfig(null)).toEqual({ confirmKill: true });
	});

	it("falls back to the defaults for a missing or broken file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-config-"));
		try {
			expect(loadConfig(join(dir, "missing.json"))).toEqual({ confirmKill: true });
			const broken = join(dir, "broken.json");
			writeFileSync(broken, "{ not json");
			expect(loadConfig(broken)).toEqual({ confirmKill: true });
			const off = join(dir, "off.json");
			writeFileSync(off, '{ "confirmKill": false }');
			expect(loadConfig(off)).toEqual({ confirmKill: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
