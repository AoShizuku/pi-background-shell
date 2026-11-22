import { describe, expect, it } from "vitest";

import { type BgTask, formatDuration, formatNotification } from "./task.js";

function task(overrides: Partial<BgTask>): BgTask {
	return {
		taskId: "bg-1",
		command: "npm test",
		status: "completed",
		exitCode: 0,
		startedAt: 1_000,
		endedAt: 43_000,
		outputPath: "/s/bg-tasks/abc/bg-1.output",
		notified: false,
		...overrides,
	};
}

describe("formatDuration", () => {
	it("formats seconds, minutes and hours", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(133_000)).toBe("2m13s");
		expect(formatDuration(3_720_000)).toBe("1h02m");
	});
});

describe("formatNotification", () => {
	it("gives path and status, never output", () => {
		const text = formatNotification([task({})]);
		expect(text).toContain("<task-id>bg-1</task-id>");
		expect(text).toContain("<status>completed</status>");
		expect(text).toContain("<exit-code>0</exit-code>");
		expect(text).toContain("<duration>42s</duration>");
		expect(text).toContain("<output-file>/s/bg-tasks/abc/bg-1.output</output-file>");
		expect(text).toContain('Background task bg-1 "npm test" completed (exit code 0).');
	});

	it("words each status differently and merges several tasks into one message", () => {
		const text = formatNotification([
			task({ taskId: "bg-1", status: "failed", exitCode: 2 }),
			task({ taskId: "bg-2", status: "timeout", exitCode: undefined }),
			task({ taskId: "bg-3", status: "killed", exitCode: undefined, reason: "stopped by the user" }),
		]);
		expect(text.match(/<bg-task-notification>/g)).toHaveLength(1);
		expect(text.match(/<task>/g)).toHaveLength(3);
		expect(text).toContain("failed (exit code 2)");
		expect(text).toContain("was killed after reaching its timeout");
		expect(text).toContain("was killed (stopped by the user)");
	});

	it("escapes markup in commands", () => {
		const text = formatNotification([task({ command: "echo '<x>' && cat a" })]);
		expect(text).toContain("<command>echo '&lt;x&gt;' &amp;&amp; cat a</command>");
	});
});
