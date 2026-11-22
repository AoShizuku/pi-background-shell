// Removes background-task output files older than the retention period.

import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Delete `.output` (and leftover `.pid`) files under `<root>/<sessionId>/` whose last write is older than `maxAgeMs`,
 * then remove session directories left empty. The current session's directory is skipped.
 * Best effort: every filesystem error is ignored.
 */
export async function cleanupOldOutputs(root: string, currentSessionId: string, maxAgeMs = OUTPUT_RETENTION_MS, now = Date.now()): Promise<number> {
	let removed = 0;
	const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const session of sessions) {
		if (!session.isDirectory() || session.name === currentSessionId) continue;
		const dir = join(root, session.name);
		const files = await readdir(dir).catch(() => [] as string[]);
		let kept = 0;
		for (const file of files) {
			const path = join(dir, file);
			const info = await stat(path).catch(() => undefined);
			if ((file.endsWith(".output") || file.endsWith(".pid")) && info && now - info.mtimeMs > maxAgeMs) {
				await rm(path, { force: true }).then(
					() => removed++,
					() => kept++,
				);
			} else {
				kept++;
			}
		}
		if (kept === 0) await rmdir(dir).catch(() => {});
	}
	return removed;
}
