import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type BgConfig, loadConfig } from "./config.js";
import { setSetting, settingsItems } from "./settings.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-settings-"));
	dirs.push(dir);
	return join(dir, "pi-background-shell.json");
}

describe("settings", () => {
	it("items reflect the current config", () => {
		expect(settingsItems({ confirmKill: false })).toEqual([
			expect.objectContaining({ id: "confirmKill", kind: "bool", value: false, default: true, applies: "live" }),
		]);
	});

	it("set saves the value, keeps other fields and applies it to the running session", () => {
		const path = tempFile();
		writeFileSync(path, '{ "confirmKill": true, "extra": 1 }');
		let applied: BgConfig | undefined;
		expect(setSetting(path, "confirmKill", false, (config) => (applied = config))).toEqual({ ok: true });
		expect(applied).toEqual({ confirmKill: false });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ confirmKill: false, extra: 1 });
		expect(loadConfig(path)).toEqual({ confirmKill: false });
	});

	it("rejects a wrong type or an unknown id without writing", () => {
		const path = tempFile();
		const apply = () => {
			throw new Error("must not apply");
		};
		expect(setSetting(path, "confirmKill", "no", apply)).toMatchObject({ ok: false });
		expect(setSetting(path, "nope", true, apply)).toMatchObject({ ok: false });
		expect(() => readFileSync(path)).toThrow();
	});

	it("leaves a broken file alone", () => {
		const path = tempFile();
		writeFileSync(path, "{ not json");
		expect(setSetting(path, "confirmKill", false, () => {})).toMatchObject({ ok: false });
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});

	it("resets to the default", () => {
		const path = tempFile();
		writeFileSync(path, '{ "confirmKill": false }');
		const item = settingsItems(loadConfig(path))[0];
		if (!item || item.kind !== "bool") throw new Error("missing item");
		setSetting(path, "confirmKill", item.default, () => {});
		expect(loadConfig(path).confirmKill).toBe(true);
	});
});
