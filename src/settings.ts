// Settings exposed to the /shizuku panel (pi-shizuku-settings): the fields of pi-background-shell.json.

import { type BgConfig, DEFAULT_CONFIG, saveConfigPatch } from "./config.js";
import type { SetResult, SettingItem, SettingValue } from "./shizuku-settings.js";

export function settingsItems(config: BgConfig): SettingItem[] {
	return [
		{
			id: "confirmKill",
			kind: "bool",
			label: "Confirm kill",
			description: "x kills a task only when pressed twice on it, in the /background list and the detail overlay.",
			value: config.confirmKill,
			default: DEFAULT_CONFIG.confirmKill,
			applies: "live",
		},
	];
}

/** Validate and save one setting; on success `apply` gets the new config so the running session uses it at once. */
export function setSetting(path: string, id: string, value: SettingValue, apply: (config: BgConfig) => void): SetResult {
	if (id !== "confirmKill") return { ok: false, error: `unknown setting ${id}` };
	if (typeof value !== "boolean") return { ok: false, error: "Confirm kill must be on or off" };
	let config: BgConfig;
	try {
		config = saveConfigPatch(path, { confirmKill: value });
	} catch (error) {
		return { ok: false, error: `could not save ${path}: ${(error as Error).message}` };
	}
	apply(config);
	return { ok: true };
}
